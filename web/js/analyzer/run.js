// Runs a sweep on the device: per point, generator and sample rate from the plan (sweep.js),
// both channels auto-ranged, a settle time, then `average` readings of B/A. Free-running
// captures ("high level at threshold 0" fires at once, as calibration does).
import * as P from '../protocol.js';
import * as Cal from '../calibration.js';
import { table } from '../wavegen.js';
import { added, addedFloor, analyse, cabs, carg, cdiv, clipped, cx, rss } from './detect.js';
import { settleS } from './sweep.js';
import { correct } from './match.js';

export const SPAN_DIV = 6;         // a channel's signal should fit 6 of the 8 divisions
const CODE_LO = 6, CODE_HI = 249;  // usable codes (0 and 255 are clipped)
const MAX_RANGING = 6;             // captures spent finding the ranges at one point
const MAX_REPEATS = 2;             // extra reading sets when readings disagree
export const AC_SETTLE_S = 5;      // AC coupling: the input capacitor's DC settles (τ ≈ 1 s, measured)

/**
 * Range and offset register for a channel whose last record spanned lo..hi volts.
 * cur: {range, offset}, clip: the record touched 0 or 255. Returns {range, offset, ok} where ok
 * means the current setting already shows the signal well (no need to change anything).
 */
export function pickRange(cal, ch, ranges, cur, lo, hi, clip) {
  const mid = (lo + hi) / 2;
  const fits = (r) => {
    const cpd = Cal.codesPerDiv(cal, ch, r), v = ranges[r];
    const offset = Cal.offsetFor(cal, ch, r, 128 - mid / v * cpd);
    const z = Cal.zeroCode(cal, ch, r, offset);
    const cLo = z + lo / v * cpd, cHi = z + hi / v * cpd;
    return { offset, ok: hi - lo <= SPAN_DIV * v && cLo >= CODE_LO && cHi <= CODE_HI };
  };
  let r = 0;
  while (r < ranges.length - 1 && !fits(r).ok) r++;
  if (clip) r = Math.max(r, Math.min(ranges.length - 1, cur.range + 1));   // a clipped reading understates
  const { offset } = fits(r);
  // Keep the current setting when it's the same range and the signal sits well inside it.
  if (!clip && r === cur.range) {
    const cpd = Cal.codesPerDiv(cal, ch, r), v = ranges[r], z = Cal.zeroCode(cal, ch, r, cur.offset);
    if (z + lo / v * cpd >= CODE_LO && z + hi / v * cpd <= CODE_HI) return { range: r, offset: cur.offset, ok: true };
  }
  return { range: r, offset, ok: false };
}

const rateOf = (div) => Math.floor((P.TIMER_HZ + Math.floor(div / 2)) / div);   // as frames report it

/** The next frame at the plan's rate with the given channel settings, arriving after `after` (ms). */
function nextFrame(dev, plan, st, coupling, after, signal, skip = true) {
  const timeout = 4000 + 3 * plan.captureS * 1000 + Math.max(0, after - performance.now());
  return new Promise((resolve, reject) => {
    let skipped = !skip;
    const done = (err, f) => {
      dev.removeEventListener('frame', on); clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (err) reject(err); else resolve(f);
    };
    const abort = () => done(new DOMException('Sweep stopped', 'AbortError'));
    const on = (e) => {
      const f = e.detail;
      if (f.rate !== rateOf(plan.capDiv) || performance.now() < after) return;
      if (!st.every((c, i) => f.ch[i].range === c.range && f.ch[i].offset === c.offset && f.ch[i].coupling === coupling)) return;
      // The first frame that matches may have started before the settings did.
      if (!skipped) { skipped = true; return; }
      done(null, f);
    };
    const timer = setTimeout(() => done(new Error(`no frames at ${plan.rateReq} S/s`)), timeout);
    signal?.addEventListener('abort', abort);
    dev.addEventListener('frame', on);
  });
}

/**
 * A reader for fixed-plan captures: read() applies `st` (the channel settings, which the caller
 * may change between reads), waits for a matching frame and returns per channel the analysis
 * of the plan's whole-cycle record plus lo/hi, mean, clip and range.
 */
function reader(ctx, plan, st, coupling, after, signal) {
  const { dev, cal, ranges } = ctx;
  let applied = null;   // settings of the last read: unchanged, no frame needs skipping
  return async () => {
    const key = JSON.stringify(st);
    if (key !== applied) for (let c = 0; c < 2; c++) await dev.setChannel(c, st[c].range, coupling, st[c].offset);
    const f = await nextFrame(dev, plan, st, coupling, after, signal, key !== applied);
    applied = key;
    const K = plan.samples, start = f.stale;
    if (f.count - start < K) throw new Error(`frame of ${f.count} samples`);
    return [0, 1].map((c) => {
      const codes = c ? f.b : f.a, fc = f.ch[c];
      const z = Cal.zeroCode(cal, c, fc.range, fc.offset), k = ranges[fc.range] / Cal.codesPerDiv(cal, c, fc.range);
      const v = Float64Array.from(codes, (x) => (x - z) * k);
      let lo = Infinity, hi = -Infinity;
      for (let i = start; i < start + K; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
      return { ...analyse(v, start, K, plan.cycles ?? 1), lo, hi, clip: clipped(codes, start, K), range: fc.range };
    });
  };
}

/** Sets the generator to a plan's sine and the sample rate, and checks both against STATE. */
async function startPoint(dev, plan, amp) {
  await dev.setGenWave(table('sine', plan.points, amp), plan.freq);
  await dev.setRate(plan.rateReq);
  const s = await dev.state();
  if (s.waveLen !== plan.points || s.genPsc !== plan.genPsc || s.genArr !== plan.genArr) {
    throw new Error(`generator at ${plan.freq} Hz: ${s.waveLen} points ${s.genPsc}/${s.genArr}, planned ${plan.points} ${plan.genPsc}/${plan.genArr}`);
  }
}

/** Puts both channels on AC coupling (widest range) and waits for the input capacitors to
 * charge to the signal's DC: measured about 4 s on HW 2.6. */
async function settleAc(ctx, signal) {
  const { dev, cal, ranges } = ctx, top = ranges.length - 1;
  for (let c = 0; c < 2; c++) await dev.setChannel(c, top, 1, Cal.offsetFor(cal, c, top, 128));
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, (ctx.acSettleS ?? AC_SETTLE_S) * 1000);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Sweep stopped', 'AbortError')); }, { once: true });
  });
}

/** Mean of B/A over readings (each capture starts at its own phase: ratios, not phasors). */
const meanRatio = (reads) => {
  const hs = reads.map(([a, b]) => cdiv(b.fund, a.fund));
  return cx(hs.reduce((s, x) => s + x.re, 0) / hs.length, hs.reduce((s, x) => s + x.im, 0) / hs.length);
};

/**
 * ctx: {dev, cal, ranges (V/div per range), amp (0..1), coupling (0 DC, 1 AC), match (match.js, or null)}
 * opts: {settle (s), average, tolDb, tolDeg}
 * Calls onPoint({freq, f, h, hRaw, a: {amp, dc, thd, range}, b: {..., thdAdded}, spreadDb, spreadDeg})
 * per point and returns them all. A point's own `amp` (0..1) overrides ctx.amp (a level sweep).
 * thdAdded: the THD B adds to A's (detect.js added), thdFloor: the noise floor under it. h is B/A with ctx.match applied (if any), hRaw without. Stops
 * with an AbortError when `signal` fires.
 */
export async function runSweep(ctx, points, opts = {}, onPoint = () => {}, signal = null) {
  const { dev, cal, ranges, coupling = 0 } = ctx;
  const avg = opts.average ?? 2, tolDb = opts.tolDb ?? 0.1, tolDeg = opts.tolDeg ?? 1;
  const top = ranges.length - 1;
  // Start wide; each point starts from the ranges the previous one found.
  const st = [0, 1].map((ch) => ({ range: top, offset: Cal.offsetFor(cal, ch, top, 128) }));
  await dev.setTrigger(0, 3, 0, 0);
  await dev.setAcq(P.ACQ_AUTO, 100);
  if (coupling && points.length) {
    await startPoint(dev, points[0], ctx.amp ?? 0.9);   // the signal whose DC the capacitors take up
    await settleAc(ctx, signal);
  }
  const out = [];
  for (const plan of points) {
    signal?.throwIfAborted();
    await startPoint(dev, plan, plan.amp ?? ctx.amp ?? 0.9);
    const read = reader(ctx, plan, st, coupling, performance.now() + 1000 * settleS(plan.freq, opts.settle), signal);

    // 1. Ranges: until both channels show their signal well.
    let r = await read();
    for (let i = 0; i < MAX_RANGING; i++) {
      const pick = [0, 1].map((c) => pickRange(cal, c, ranges, st[c], r[c].lo, r[c].hi, r[c].clip));
      if (pick.every((p) => p.ok)) break;
      pick.forEach((p, c) => { st[c] = { range: p.range, offset: p.offset }; });
      r = await read();
    }

    // 2. Readings, repeated when they disagree (the circuit still settling, or noise).
    let reads, spreadDb, spreadDeg;
    for (let rep = 0; rep <= MAX_REPEATS; rep++) {
      reads = [r];
      while (reads.length < avg) reads.push(await read());
      const hs = reads.map(([a, b]) => cdiv(b.fund, a.fund));
      const dbs = hs.map((h) => 20 * Math.log10(cabs(h))), degs = hs.map((h) => carg(cdiv(h, hs[0])) * 180 / Math.PI);
      spreadDb = Math.max(...dbs) - Math.min(...dbs);
      spreadDeg = Math.max(...degs) - Math.min(...degs);
      if (spreadDb <= tolDb && spreadDeg <= tolDeg) break;
      if (rep < MAX_REPEATS) r = await read();
    }
    const h = meanRatio(reads);
    const summary = (c) => {
      const m = (fn) => reads.reduce((s2, x) => s2 + fn(x[c]), 0) / reads.length;
      return { amp: m((x) => cabs(x.fund)), dc: m((x) => x.dc), thd: m((x) => x.thd), range: reads[0][c].range, clip: reads.some((x) => x[c].clip) };
    };
    // Added THD: the harmonic vectors averaged over the readings (noise averages down), and the
    // floor that noise leaves.
    const ad = reads.map(([x, y]) => added(x, y));
    const adMean = ad[0].map((_, i) => cx(ad.reduce((s2, v) => s2 + v[i].re, 0) / ad.length, ad.reduce((s2, v) => s2 + v[i].im, 0) / ad.length));
    const floor = reads.reduce((s2, [x, y]) => s2 + addedFloor(x, y, plan.samples, reads.length), 0) / reads.length;
    const a = summary(0), b = { ...summary(1), thdAdded: rss(adMean), thdFloor: floor };
    const p = { freq: plan.freq, f: plan.actual, level: plan.amp ?? ctx.amp ?? 0.9, h: correct(ctx.match, plan.actual, h, a.range, b.range), hRaw: h, a, b, spreadDb, spreadDeg, n: reads.length };
    out.push(p);
    onPoint(p, out.length, points.length);
  }
  await dev.setGen(P.GEN_OFF, 1000, 50);
  return out;
}

/**
 * DC levels on both channels for two constant generator outputs (tables of equal codes), for
 * Re: {levels: [[a, b], [a, b]], ranges: [rA, rB]} in volts. Both levels are read with the same
 * channel settings, so zero errors cancel in their difference. Only without a capacitor.
 */
export async function measureDc(ctx, signal = null) {
  const { dev, cal, ranges } = ctx;
  const plan = { rateReq: 100000, capDiv: 720, captureS: 0.041, samples: 4000, cycles: 1 };
  const top = ranges.length - 1;
  const st = [0, 1].map((ch) => ({ range: top, offset: Cal.offsetFor(cal, ch, top, 128) }));
  await dev.setTrigger(0, 3, 0, 0);
  await dev.setAcq(P.ACQ_AUTO, 100);
  await dev.setRate(plan.rateReq);
  const FRACS = [0.15, 0.85];
  const level = async (frac) => {
    await dev.setGenWave(new Array(16).fill(Math.round(frac * 4095)), 1000);
    return reader(ctx, plan, st, 0, performance.now() + 100, signal);
  };
  // 1. Where each level lands, from the widest range.
  const seen = [];
  for (const frac of FRACS) seen.push(await (await level(frac))());
  // 2. One setting per channel that holds both levels.
  for (let c = 0; c < 2; c++) {
    const lo = Math.min(...seen.map((x) => x[c].lo)), hi = Math.max(...seen.map((x) => x[c].hi));
    const pad = 0.1 * (hi - lo) + 0.02;
    const pick = pickRange(cal, c, ranges, { range: top, offset: st[c].offset }, lo - pad, hi + pad, false);
    st[c] = { range: pick.range, offset: pick.offset };
  }
  // 3. Both levels with those settings.
  const levels = [];
  for (const frac of FRACS) {
    const read = await level(frac);
    const r = [await read(), await read()];
    if (r.some((x) => x[0].clip || x[1].clip)) throw new Error('a DC level clipped');
    levels.push([0, 1].map((c) => (r[0][c].dc + r[1][c].dc) / 2));
  }
  await dev.setGen(P.GEN_OFF, 1000, 50);
  return { levels, ranges: st.map((x) => x.range) };
}

/**
 * Relative gain of every range of both channels, with both probes on the wave out: B/A with
 * both channels on the same range, then with A one range above B, at 1 kHz (AC coupled, so
 * the generator's DC doesn't matter). Chained, they give each range's gain relative to channel
 * A on range `ref`: {ga: [dB per range], gb: [dB per range]} (NaN where not measurable).
 */
export async function measureRangeGains(ctx, plan, ref, onStep = () => {}, signal = null) {
  const { dev, cal, ranges } = ctx;
  const n = ranges.length;
  await dev.setTrigger(0, 3, 0, 0);
  await dev.setAcq(P.ACQ_AUTO, 100);
  const pair = async (rA, rB) => {
    // The signal fills about 5 divisions of the finer range (at most the generator's 90 %).
    const amp = Math.min(0.9, 5 * ranges[Math.min(rA, rB)] / 2.68);
    await startPoint(dev, plan, amp);
    const st = [{ range: rA, offset: Cal.offsetFor(cal, 0, rA, 128) }, { range: rB, offset: Cal.offsetFor(cal, 1, rB, 128) }];
    const read = reader(ctx, plan, st, 1, performance.now() + 100, signal);
    let reads = [];
    for (let tries = 0; tries < 12 && reads.length < 4; tries++) {
      const r = await read();
      if (r[0].clip || r[1].clip) reads = []; else reads.push(r);   // clipped: the input still settling
    }
    if (reads.length < 4) return NaN;
    const h = meanRatio(reads);
    return 20 * Math.log10(cabs(h));
  };
  await startPoint(dev, plan, 0.9);
  await settleAc(ctx, signal);
  const same = [], cross = [];   // dB: gB(r)/gA(r), and gB(r)/gA(r+1)
  for (let r = 0; r < n; r++) { onStep(`range ${r + 1} of ${n}`); same.push(await pair(r, r)); }
  for (let r = 0; r + 1 < n; r++) { onStep(`ranges ${r + 1}/${r + 2}`); cross.push(await pair(r + 1, r)); }
  await dev.setGen(P.GEN_OFF, 1000, 50);
  // gA(r+1)/gA(r) = same[r] − cross[r] in dB; anchored at gA(ref) = 0 dB.
  const ga = new Array(n).fill(NaN);
  ga[ref] = 0;
  for (let r = ref; r + 1 < n; r++) ga[r + 1] = ga[r] + same[r] - cross[r];
  for (let r = ref - 1; r >= 0; r--) ga[r] = ga[r + 1] - (same[r] - cross[r]);
  const gb = ga.map((g, r) => g + same[r]);
  return { ga, gb };
}
