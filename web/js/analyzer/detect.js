// Tone detection on coherent records (sweep.js): a single-bin DFT at the fundamental and its
// harmonics. Complex numbers are {re, im}. Pure (tested under node).

export const cx = (re, im = 0) => ({ re, im });
export const cmul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const cdiv = (a, b) => { const d = b.re * b.re + b.im * b.im; return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
export const csub = (a, b) => cx(a.re - b.re, a.im - b.im);
export const cabs = (a) => Math.hypot(a.re, a.im);
export const carg = (a) => Math.atan2(a.im, a.re);
export const cscale = (a, k) => cx(a.re * k, a.im * k);
export const polar = (mag, rad) => cx(mag * Math.cos(rad), mag * Math.sin(rad));

/** Peak-amplitude phasor of bin `m` over x[start .. start+K): x ≈ |X|·cos(2π·m·k/K + arg X). */
export function bin(x, start, K, m) {
  let re = 0, im = 0;
  const w = 2 * Math.PI * m / K;
  // Recurrence for cos/sin (exact enough over 4 k samples in double precision).
  const cw = Math.cos(w), sw = Math.sin(w);
  let c = 1, s = 0;
  for (let k = 0; k < K; k++) {
    const v = x[start + k];
    re += v * c; im -= v * s;
    const c2 = c * cw - s * sw; s = s * cw + c * sw; c = c2;
  }
  return cx(2 * re / K, 2 * im / K);
}

/**
 * x: one channel's samples (volts), start: first valid sample, K samples holding M cycles.
 * Returns {fund (phasor), dc, harmonics: [|H2|, |H3|, …] up to `hmax` (below Nyquist),
 * thd (ratio, NaN without harmonics), rmsNoise (what the fundamental and harmonics leave)}.
 */
export function analyse(x, start, K, M, hmax = 5) {
  let sum = 0, sq = 0;
  for (let k = 0; k < K; k++) { const v = x[start + k]; sum += v; sq += v * v; }
  const dc = sum / K;
  const fund = bin(x, start, K, M);
  const hc = [];   // complex, from the 2nd up
  for (let h = 2; h <= hmax && h * M < K / 2; h++) hc.push(bin(x, start, K, h * M));
  const harmonics = hc.map(cabs);
  const f = cabs(fund);
  const hp = harmonics.reduce((s, a) => s + a * a / 2, 0);
  const thd = harmonics.length && f > 0 ? Math.sqrt(2 * hp) / f : NaN;
  const rmsNoise = Math.sqrt(Math.max(0, sq / K - dc * dc - f * f / 2 - hp));
  return { fund, dc, harmonics, hc, thd, rmsNoise };
}

/**
 * THD that B adds to A, from one simultaneous pair of analyse() results: each harmonic of B less
 * what A's own harmonic becomes through a flat gain with a pure delay (|g|·Ah·u^h, where
 * g = B1/A1 and u = g/|g|; −g if B is inverted). The generator's own distortion cancels as long as the device is flat
 * and linear-phase up to the highest harmonic, as an amplifier is.
 */
export const addedThd = (a, b) => rss(added(a, b));

/** The harmonics B adds (addedThd), each relative to B's fundamental and rotated to its phase,
 * so they average across captures that start at different phases (noise then averages down). */
export function added(a, b) {
  let g = cdiv(b.fund, a.fund);
  const inv = g.re < 0 ? -1 : 1;                        // an inverting amplifier: −1 times a delay
  g = cscale(g, inv);
  const m = cabs(g), u = cscale(g, 1 / m), b1 = cabs(b.fund), ub = cscale(b.fund, 1 / b1);
  const out = [];
  let uh = u, vh = ub;
  for (let i = 0; i < b.hc.length && i < a.hc.length; i++) {
    uh = cmul(uh, u); vh = cmul(vh, ub);                // u^h and B's own phase^h, h = i + 2
    const d = csub(b.hc[i], cscale(cmul(a.hc[i], uh), inv * m));
    out.push(cscale(cdiv(d, vh), 1 / b1));
  }
  return out;
}

/** Root sum of squares of complex values. */
export const rss = (v) => Math.sqrt(v.reduce((s, x) => s + x.re * x.re + x.im * x.im, 0));

/**
 * The noise floor of addedThd for a pair of analyse() results averaged n times: the noise in
 * each harmonic bin (2σ/√K for residual noise σ over K samples) on both channels.
 */
export function addedFloor(a, b, K, n = 1) {
  const m = cabs(b.fund) / cabs(a.fund), nb = 2 * b.rmsNoise / Math.sqrt(K), na = 2 * a.rmsNoise / Math.sqrt(K) * m;
  return Math.sqrt(b.hc.length * (nb * nb + na * na) / n) / cabs(b.fund);
}

/** True if any code in [start, start+K) sits at the ADC's limits (the reading is clipped). */
export function clipped(codes, start, K) {
  for (let k = start; k < start + K; k++) if (codes[k] <= 0 || codes[k] >= 255) return true;
  return false;
}
