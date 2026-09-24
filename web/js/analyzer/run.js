// Runs a sweep on the device: per point, generator and sample rate from the plan (sweep.js),
// both channels auto-ranged, a settle time, then `average` readings of B/A. Free-running
// captures ("high level at threshold 0" fires at once, as calibration does).
import * as P from '../protocol.js';
import * as Cal from '../calibration.js';
import { table } from '../wavegen.js';
import { analyse, cabs, carg, cdiv, clipped, cx } from './detect.js';
import { settleS } from './sweep.js';

export const SPAN_DIV = 6;         // a channel's signal should fit 6 of the 8 divisions
const CODE_LO = 6, CODE_HI = 249;  // usable codes (0 and 255 are clipped)
const MAX_RANGING = 6;             // captures spent finding the ranges at one point
const MAX_REPEATS = 2;             // extra reading sets when readings disagree

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
function nextFrame(dev, plan, st, coupling, after, signal) {
  const timeout = 4000 + 3 * plan.captureS * 1000 + Math.max(0, after - performance.now());
  return new Promise((resolve, reject) => {
    let skipped = false;
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
 * ctx: {dev, cal, ranges (V/div per range), amp (0..1), coupling (0 DC, 1 AC)}
 * opts: {settle (s), average, tolDb, tolDeg}
 * Calls onPoint({freq, f, h, a: {amp, dc, thd, range}, b: {...}, spreadDb, spreadDeg}) per
 * point and returns them all. Stops with an AbortError when `signal` fires.
 */
export async function runSweep(ctx, points, opts = {}, onPoint = () => {}, signal = null) {
  const { dev, cal, ranges, coupling = 0 } = ctx;
  const avg = opts.average ?? 2, tolDb = opts.tolDb ?? 0.1, tolDeg = opts.tolDeg ?? 1;
  const top = ranges.length - 1;
  // Start wide; each point starts from the ranges the previous one found.
  const st = [0, 1].map((ch) => ({ range: top, offset: Cal.offsetFor(cal, ch, top, 128) }));
  await dev.setTrigger(0, 3, 0, 0);
  await dev.setAcq(P.ACQ_AUTO, 100);
  const out = [];
  for (const plan of points) {
    signal?.throwIfAborted();
    await dev.setGenWave(table('sine', plan.points, ctx.amp ?? 0.9), plan.freq);
    await dev.setRate(plan.rateReq);
    const s = await dev.state();
    if (s.waveLen !== plan.points || s.genPsc !== plan.genPsc || s.genArr !== plan.genArr) {
      throw new Error(`generator at ${plan.freq} Hz: ${s.waveLen} points ${s.genPsc}/${s.genArr}, planned ${plan.points} ${plan.genPsc}/${plan.genArr}`);
    }
    const settleUntil = performance.now() + 1000 * settleS(plan.freq, opts.settle);
    const read = async () => {
      for (let c = 0; c < 2; c++) await dev.setChannel(c, st[c].range, coupling, st[c].offset);
      const f = await nextFrame(dev, plan, st, coupling, settleUntil, signal);
      const K = plan.samples, start = f.stale;
      if (f.count - start < K) throw new Error(`frame of ${f.count} samples`);
      return [0, 1].map((c) => {
        const codes = c ? f.b : f.a, fc = f.ch[c];
        const z = Cal.zeroCode(cal, c, fc.range, fc.offset), k = ranges[fc.range] / Cal.codesPerDiv(cal, c, fc.range);
        const v = Float64Array.from(codes, (x) => (x - z) * k);
        let lo = Infinity, hi = -Infinity;
        for (let i = start; i < start + K; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
        return { ...analyse(v, start, K, plan.cycles), lo, hi, clip: clipped(codes, start, K), range: fc.range };
      });
    };

    // 1. Ranges: until both channels show their signal well.
    let r = await read();
    for (let i = 0; i < MAX_RANGING; i++) {
      const pick = [0, 1].map((c) => pickRange(cal, c, ranges, st[c], r[c].lo, r[c].hi, r[c].clip));
      if (pick.every((p) => p.ok)) break;
      pick.forEach((p, c) => { st[c] = { range: p.range, offset: p.offset }; });
      r = await read();
    }

    // 2. Readings: B/A per capture (each starts at its own phase, so ratios are averaged, not
    // phasors), repeated when they disagree (the circuit still settling, or noise).
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
    const hs = reads.map(([a, b]) => cdiv(b.fund, a.fund));
    const h = cx(hs.reduce((s2, x) => s2 + x.re, 0) / hs.length, hs.reduce((s2, x) => s2 + x.im, 0) / hs.length);
    const summary = (c) => {
      const m = (fn) => reads.reduce((s2, x) => s2 + fn(x[c]), 0) / reads.length;
      return { amp: m((x) => cabs(x.fund)), dc: m((x) => x.dc), thd: m((x) => x.thd), range: reads[0][c].range, clip: reads.some((x) => x[c].clip) };
    };
    const p = { freq: plan.freq, f: plan.actual, h, a: summary(0), b: summary(1), spreadDb, spreadDeg, n: reads.length };
    out.push(p);
    onPoint(p, out.length, points.length);
  }
  await dev.setGen(P.GEN_OFF, 1000, 50);
  return out;
}
