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
  // Peak between the points: a parabola through the top three in (log f, dB).
  let peakF = c[k].f, peakDb = c[k].gainDb;
  if (k > 0 && k < c.length - 1) {
    const [x0, x1, x2] = [c[k - 1], c[k], c[k + 1]].map((p) => Math.log(p.f)), [y0, y1, y2] = [c[k - 1], c[k], c[k + 1]].map((p) => p.gainDb);
    const d = (x0 - x1) * (x0 - x2) * (x1 - x2);
    const A = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / d;
    const B = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / d;
    if (A < 0) {
      const xv = Math.min(x2, Math.max(x0, -B / (2 * A)));
      peakF = Math.exp(xv);
      peakDb = Math.max(peakDb, y1 + A * (xv - x1) * (xv - x1) + (B + 2 * A * x1) * (xv - x1));
    }
  }
  return { peakF, peakDb, peakIndex: k, refDb: ref, lowF: lo, highF: hi };
}

/**
 * Frequencies to add for sharper readouts: `n` log-spaced points inside each interval that
 * brackets a −3 dB crossing, and either side of the peak (integer Hz, not already swept).
 */
export function refineFreqs(c, r, n = 3) {
  const have = new Set(c.map((p) => p.freq ?? Math.round(p.f)));
  const out = new Set();
  const inside = (i) => {
    if (i < 1 || i >= c.length) return;
    const a = c[i - 1].f, b = c[i].f;
    for (let k = 1; k <= n; k++) {
      const f = Math.round(a * (b / a) ** (k / (n + 1)));
      if (f > a && f < b && !have.has(f)) out.add(f);
    }
  };
  const bracket = (f) => { if (Number.isFinite(f)) inside(c.findIndex((p) => p.f >= f)); };
  bracket(r.lowF);
  bracket(r.highF);
  const k = r.peakIndex;
  if (k > 0 && k < c.length - 1) { inside(k); inside(k + 1); }
  return [...out].sort((a, b) => a - b);
}
