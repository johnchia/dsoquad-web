// Real-signal spectrum: windowing and a radix-2 FFT. Pure functions (tested under node).

// Window functions w(i, n). Coefficients from Heinzel, Rüdiger & Schilling (2002).
const cosineSum = (a) => (i, n) => {
  let w = 0;
  for (let k = 0; k < a.length; k++) w += (k % 2 ? -1 : 1) * a[k] * Math.cos(2 * Math.PI * k * i / (n - 1));
  return w;
};
export const WINDOWS = {
  hann: { label: 'Hann', w: cosineSum([0.5, 0.5]) },
  blackmanharris: { label: 'Blackman-Harris', w: cosineSum([0.35875, 0.48829, 0.14128, 0.01168]) },
  flattop: { label: 'Flat top (amplitude)', w: cosineSum([0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368]) },
  rect: { label: 'Rectangular', w: () => 1 },
};

const windowCache = new Map();
function windowOf(name, n) {
  const key = `${name}/${n}`;
  let c = windowCache.get(key);
  if (!c) {
    const w = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) { w[i] = WINDOWS[name].w(i, n); sum += w[i]; }
    c = { w, sum };
    windowCache.set(key, c);
  }
  return c;
}

const twiddleCache = new Map();
function twiddles(n) {
  let t = twiddleCache.get(n);
  if (!t) {
    t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let i = 0; i < n / 2; i++) { t.cos[i] = Math.cos(2 * Math.PI * i / n); t.sin[i] = -Math.sin(2 * Math.PI * i / n); }
    twiddleCache.set(n, t);
  }
  return t;
}

/** In-place iterative radix-2 FFT of (re, im); length must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/**
 * Amplitude spectrum of `x` (volts), zero-padded to a power of two.
 * Returns {rms: Float64Array(bins) — RMS volts of a sine centred on each bin (DC bin: the mean),
 *          binHz(rate), n}.
 */
export function spectrum(x, windowName = 'hann') {
  const m = x.length;
  let n = 1;
  while (n < m) n <<= 1;
  const { w, sum } = windowOf(windowName, m);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < m; i++) re[i] = x[i] * w[i];
  fft(re, im);
  const bins = n / 2 + 1, rms = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const mag = Math.hypot(re[k], im[k]) / sum;   // DC: mean; else half the sine amplitude
    rms[k] = k === 0 || k === n / 2 ? mag : mag * Math.SQRT2;  // 2·mag/√2
  }
  return { rms, n, binHz: (rate) => rate / n };
}

/** Largest non-DC peak: {bin (fractional, parabolic on dB), rms}. Skips `skip` low bins. */
export function peak(rms, skip = 3) {
  let k = skip;
  for (let i = skip; i < rms.length - 1; i++) if (rms[i] > rms[k]) k = i;
  const db = (i) => 20 * Math.log10(Math.max(rms[i], 1e-12));
  let d = 0;
  if (k > 0 && k < rms.length - 1) {
    const a = db(k - 1), b = db(k), c = db(k + 1);
    const den = a - 2 * b + c;
    if (den < 0) d = 0.5 * (a - c) / den;
  }
  return { bin: k + d, rms: rms[k] };
}
