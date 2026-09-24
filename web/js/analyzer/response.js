// Frequency-response readouts from a sweep of H = B/A. Pure (tested under node).
import { cabs, carg } from './detect.js';

export const db = (x) => 20 * Math.log10(x);

/** pts: [{f, h: {re, im}}] ascending. Adds gainDb and unwrapped phaseDeg to copies. */
export function curve(pts) {
  let prev = null, turns = 0;
  return pts.map((p) => {
    let ph = carg(p.h) * 180 / Math.PI;
    if (prev !== null) {
      while (ph + 360 * turns - prev > 180) turns--;
      while (ph + 360 * turns - prev < -180) turns++;
    }
    ph += 360 * turns;
    prev = ph;
    return { ...p, gain: cabs(p.h), gainDb: db(cabs(p.h)), phaseDeg: ph };
  });
}

/** Log-frequency where y crosses `level` between points i-1 and i. */
function crossAt(c, i, level, key) {
  const t = (level - c[i - 1][key]) / (c[i][key] - c[i - 1][key]);
  return c[i - 1].f * (c[i].f / c[i - 1].f) ** t;
}

/** Value of `key` at frequency f, interpolated in log f (clamped to the ends). */
export function valueAt(c, f, key) {
  if (f <= c[0].f) return c[0][key];
  for (let i = 1; i < c.length; i++) {
    if (f <= c[i].f) {
      const t = Math.log(f / c[i - 1].f) / Math.log(c[i].f / c[i - 1].f);
      return c[i - 1][key] + t * (c[i][key] - c[i - 1][key]);
    }
  }
  return c[c.length - 1][key];
}

/**
 * Readouts: the peak, and the −3 dB points either side of it relative to a reference gain
 * (the peak by default, or the gain at `refF`). Missing crossings are NaN (outside the sweep).
 */
export function readouts(c, { refF = null, drop = 3 } = {}) {
  let k = 0;
  for (let i = 1; i < c.length; i++) if (c[i].gainDb > c[k].gainDb) k = i;
  const ref = refF === null ? c[k].gainDb : valueAt(c, refF, 'gainDb');
  const lvl = ref - drop;
  let lo = NaN, hi = NaN;
  for (let i = k; i > 0; i--) if (c[i - 1].gainDb < lvl && c[i].gainDb >= lvl) { lo = crossAt(c, i, lvl, 'gainDb'); break; }
  for (let i = k + 1; i < c.length; i++) if (c[i - 1].gainDb >= lvl && c[i].gainDb < lvl) { hi = crossAt(c, i, lvl, 'gainDb'); break; }
  return { peakF: c[k].f, peakDb: c[k].gainDb, refDb: ref, lowF: lo, highF: hi };
}
