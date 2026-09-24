// Auto set: pick V/div and position for each enabled channel, a time/div that shows a few
// periods, and a trigger at the middle of the strongest signal. The helpers are pure (tested
// under node); autoset() drives the device with quick free-running captures.
import * as P from './protocol.js';
import { measure } from './measure.js';

export const FIT = 0.85;          // use at most this much of a trace's band
export const CYCLES = 3;          // periods to show across the screen
const RATE_LADDER = [36e6, 3.6e6, 360e3, 36e3, 3.6e3];   // fast to slow; 3.6 kS/s = 1.1 s per capture
const MIN_SAMPLES_PER_PERIOD = 8;

/** Screen bands: one trace uses the middle 6 divisions, two share the screen (A above B). */
export function bands(on) {
  const n = on.filter(Boolean).length;
  if (n <= 1) return on.map(() => ({ center: 4, height: 6 }));
  return on.map((_, i) => (i === 0 ? { center: 6, height: 3.4 } : { center: 2, height: 3.4 }));
}

/** Smallest range (index into `ranges`, V/div ascending) that shows `pp` volts in `height` div. */
export function pickRange(ranges, pp, height) {
  for (let i = 0; i < ranges.length; i++) if (pp <= FIT * height * ranges[i]) return i;
  return ranges.length - 1;
}

/** Position (divisions of 0 V above the bottom) that centres [lo, hi] volts on the band. */
export function pickPos(lo, hi, vdiv, center) {
  return +Math.min(8, Math.max(0, center - (lo + hi) / 2 / vdiv)).toFixed(2);
}

/** Time/div from `tdivs` (ascending) that shows about CYCLES periods in 10 divisions. */
export function pickTdiv(tdivs, period, hdiv = 10) {
  const want = CYCLES * period / hdiv;
  return tdivs.find((t) => t >= want * 0.999) ?? tdivs[tdivs.length - 1];
}

/**
 * ctx: {dev, ranges, tdivs, on: [bool, bool], coupling: [c, c], trigSource (current, kept if usable),
 *       offsetFor(ch, range, posDiv) -> offset register, volts(frame, ch) -> Float32Array,
 *       progress(text)}
 * Returns {ch: [{range, posDiv} | null], tdiv | null, trig: {source, levelDiv} | null, found}.
 */
export async function autoset(ctx) {
  const { dev, ranges } = ctx;
  const on = ctx.on.some(Boolean) ? ctx.on : [true, false];
  const band = bands(on);
  const top = ranges.length - 1;
  const st = on.map((o) => (o ? { range: top, posDiv: 4 } : null));

  const apply = async (rate) => {
    for (let i = 0; i < 2; i++) {
      if (st[i]) await dev.setChannel(i, st[i].range, ctx.coupling[i], ctx.offsetFor(i, st[i].range, st[i].posDiv));
    }
    await dev.setRate(rate);
  };
  const grab = async (rate) => {
    await apply(rate);
    return nextFrame(dev, (f) => f.rate === P.actualRate(rate) && on.every((o, i) => !o || f.ch[i].range === st[i].range), rate);
  };
  const stats = (f, i) => {
    const v = ctx.volts(f, i).subarray(f.stale), codes = (i ? f.b : f.a).subarray(f.stale);
    let lo = Infinity, hi = -Infinity, clip = false;
    for (let k = 0; k < v.length; k++) { if (v[k] < lo) lo = v[k]; if (v[k] > hi) hi = v[k]; if (codes[k] <= 0 || codes[k] >= 255) clip = true; }
    return { lo, hi, clip, v };
  };

  // Free-running captures: "high level at threshold 0" fires at once (as calibration does).
  await dev.setTrigger(0, 3, 0, 0);
  await dev.setAcq(P.ACQ_AUTO, 100);

  // 1. Vertical: from the widest range down to the one that fits, re-centring each time.
  ctx.progress?.('Auto: measuring amplitude…');
  const amp = [null, null];
  for (let pass = 0; pass < 4; pass++) {
    const f = await grab(1e6);
    let changed = false;
    for (let i = 0; i < 2; i++) {
      if (!st[i]) continue;
      const s = stats(f, i);
      amp[i] = s;
      let r = pickRange(ranges, s.hi - s.lo, band[i].height);
      if (s.clip) r = Math.max(r, Math.min(top, st[i].range + 1));   // can't trust a clipped reading
      const pos = pickPos(s.lo, s.hi, ranges[r], band[i].center);
      if (r !== st[i].range || Math.abs(pos - st[i].posDiv) > 0.3) changed = true;
      st[i] = { range: r, posDiv: pos };
    }
    if (!changed) break;
  }

  // 2. Trigger source: keep the current one if its signal is usable (at least a third of its
  // band), otherwise the channel whose signal fills its band the most.
  const fill = (i) => (st[i] && amp[i] ? (amp[i].hi - amp[i].lo) / ranges[st[i].range] / band[i].height : -1);
  const cur = ctx.trigSource;
  const src = cur < 2 && fill(cur) >= 0.33 ? cur : fill(1) > fill(0) ? 1 : 0;

  // 3. Timebase: from fast to slow until the record holds at least two whole periods.
  let period = NaN;
  for (const rate of RATE_LADDER) {
    ctx.progress?.(`Auto: looking for the period at ${rate >= 1e6 ? `${rate / 1e6} MS/s` : `${rate / 1e3} kS/s`}…`);
    const f = await grab(rate);
    const s = stats(f, src);
    const m = measure(s.v, f.rate, ranges[st[src].range] / P.CODES_PER_DIV);
    if (Number.isFinite(m.period) && m.period * f.rate >= MIN_SAMPLES_PER_PERIOD) { period = m.period; amp[src] = s; break; }
  }

  const found = Number.isFinite(period);
  const s = amp[src];
  const mid = s ? (s.lo + s.hi) / 2 : 0;
  return {
    ch: st,
    tdiv: found ? pickTdiv(ctx.tdivs, period) : null,
    trig: s && s.hi - s.lo > 0.5 * ranges[st[src].range] ? { source: src, levelDiv: +(mid / ranges[st[src].range]).toFixed(2) } : null,
    period,
    found,
  };
}

/** The next frame that `ok(frame)` accepts, after one more to let the front end settle. */
function nextFrame(dev, ok, rate) {
  const timeout = 2000 + 3 * 4096 / rate * 1000;
  return new Promise((resolve, reject) => {
    let seen = 0;
    const done = (err, f) => { dev.removeEventListener('frame', on); clearTimeout(timer); if (err) reject(err); else resolve(f); };
    const on = (e) => { if (ok(e.detail) && ++seen >= 2) done(null, e.detail); };
    const timer = setTimeout(() => done(new Error('Auto set: no frames from the device')), timeout);
    dev.addEventListener('frame', on);
  });
}
