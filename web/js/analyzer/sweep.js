// Sweep planning for the analyzer: per frequency, a generator table and a capture rate such
// that a whole number of generator cycles fills (nearly) the whole record. The generator and
// the sample clock both divide the same 72 MHz timer clock, so the cycle count is exact and a
// single-bin DFT (detect.js) sees no leakage and needs no window. Pure (tested under node).
import { DAC_MAX_RATE, TIMER_HZ, STALE_SAMPLES, WAVE_MAX } from '../protocol.js';
import { MAX_ANALOG_HZ, MIN_POINTS, analogActual, planPoints, timerDiv } from '../wavegen.js';

export const RECORD = 4096;                              // samples per frame
export const USABLE = RECORD - 2 * STALE_SAMPLES;        // after the stale head, with a margin
export const MIN_HZ = 1, MAX_HZ = MAX_ANALOG_HZ;
const MAX_CAP_DIV = 65536;       // prescaler 0: every divider 2..65536 is reachable (≥ 1099 S/s)
const OVERHEAD_S = 0.03;         // per capture: USB transfer and command round trips

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

/** Mirrors scope_set_rate(): the timer divider the firmware picks for a requested rate. */
export function captureDiv(hz) {
  const psc = Math.floor(Math.floor(TIMER_HZ / 65536) / hz);
  let arr = Math.floor((Math.floor(TIMER_HZ / (psc + 1)) + hz - 1) / hz) - 1;
  arr = Math.min(Math.max(arr, 1), 65535);
  return (psc + 1) * (arr + 1);
}

/** Integer rate to request for capture divider `div`, or null if the firmware can't make it. */
export function rateForDiv(div) {
  const hz = Math.ceil(TIMER_HZ / div);
  return captureDiv(hz) === div ? hz : null;
}

/**
 * Plan one point at integer frequency `freq` Hz. Returns null above the generator's range.
 * {freq, actual (Hz the generator really makes), points (table length), genPsc, genArr,
 *  capDiv, rateReq (for SET_TIMEBASE), rate (exact S/s), samples K, cycles M, spc (samples per
 *  cycle), captureS (seconds per frame)}. K·capDiv = M·(period in timer ticks) exactly.
 */
export function planPoint(freq, { usable = USABLE, minSpc = 8, prefSpc = 16, minCycles = 2, maxErr = 2e-3 } = {}) {
  const g = planPoints(freq);
  if (!g) return null;
  // Table lengths from the longest down, best frequency accuracy first: each gives another
  // generator period to find a reachable capture divider for (large dividers are reachable
  // only in steps, so one period alone may have none).
  const nMax = Math.min(WAVE_MAX, Math.floor(DAC_MAX_RATE / freq));
  const lengths = [];
  for (let n = nMax; n >= Math.max(MIN_POINTS, Math.floor(nMax / 2)); n--) {
    const err = Math.abs(analogActual(freq, n) - freq) / freq;
    if (err <= Math.max(maxErr, g.err)) lengths.push({ n, err });
  }
  lengths.sort((a, b) => a.err - b.err || b.n - a.n);
  let best = null;
  for (const { n } of lengths) {
    const c = captureFor(freq, n, { usable, minSpc, prefSpc, minCycles });
    if (c && (!best || c.pref > best.pref || (c.pref === best.pref && c.K > best.K))) best = c;
    if (best && best.pref && best.K >= 0.95 * usable) break;
  }
  if (!best) return null;
  return {
    freq, actual: TIMER_HZ / best.period, points: best.n, genPsc: best.psc, genArr: best.arr,
    capDiv: best.div, rateReq: best.rateReq, rate: TIMER_HZ / best.div,
    samples: best.K, cycles: best.M, spc: best.spc, captureS: RECORD * best.div / TIMER_HZ,
  };
}

/** The best capture divider for an n-point table at `freq`, or null. */
function captureFor(freq, n, { usable, minSpc, prefSpc, minCycles }) {
  const { psc, arr } = timerDiv(freq * n);
  const period = n * (psc + 1) * (arr + 1);           // generator period in timer ticks
  const lo = Math.max(2, Math.ceil(minCycles * period / usable));
  const hi = Math.min(MAX_CAP_DIV, Math.floor(period / minSpc));
  let best = null;
  // The densest records sit near `lo`.
  for (let div = lo; div <= hi && div < lo + 4000; div++) {
    const k0 = period / gcd(period, div);               // shortest whole-cycle record
    if (k0 > usable) continue;
    const K = Math.floor(usable / k0) * k0, M = K * div / period;
    if (M < minCycles) continue;
    const spc = period / div, pref = spc >= prefSpc;
    if (best && (pref < best.pref || (pref === best.pref && K <= best.K))) continue;
    const rateReq = rateForDiv(div);
    if (rateReq === null) continue;
    best = { n, psc, arr, period, div, rateReq, K, M, spc, pref };
    if (pref && K === usable) break;
  }
  return best;
}

/** Log-spaced integer frequencies from f0 to f1 (inclusive), `perDecade` per decade. */
export function logFreqs(f0, f1, perDecade = 10) {
  f0 = Math.max(MIN_HZ, Math.round(f0)); f1 = Math.min(MAX_HZ, Math.round(f1));
  const n = Math.max(1, Math.round(Math.log10(f1 / f0) * perDecade));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = Math.round(f0 * (f1 / f0) ** (i / n));
    if (f !== out[out.length - 1]) out.push(f);
  }
  return out;
}

/** Settling time after a frequency change: 3 periods, 50 ms, or the user's figure. */
export const settleS = (freq, userS = 0) => Math.max(3 / freq, 0.05, userS);

/** Plans a whole sweep. opts: {settle (s), average (captures per point)} plus planPoint's. */
export function planSweep(freqs, opts = {}) {
  const points = freqs.map((f) => planPoint(f, opts)).filter(Boolean);
  const avg = opts.average ?? 1;
  // Each point: settle, one capture to discard (the range may have changed), `avg` to keep.
  const seconds = points.reduce((s, p) => s + settleS(p.freq, opts.settle) + (avg + 1) * (p.captureS + OVERHEAD_S), 0);
  return { points, seconds };
}
