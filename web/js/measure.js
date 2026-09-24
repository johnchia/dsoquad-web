// Automatic measurements on one channel's samples, in volts. Pure functions (tested under node).

export const MEASUREMENTS = {
  pp: { label: 'Vpp', unit: 'V' },
  mean: { label: 'Vavg', unit: 'V' },
  rms: { label: 'Vrms', unit: 'V' },
  acrms: { label: 'AC rms', unit: 'V' },
  max: { label: 'Max', unit: 'V' },
  min: { label: 'Min', unit: 'V' },
  top: { label: 'Top', unit: 'V' },
  base: { label: 'Base', unit: 'V' },
  amp: { label: 'Ampl', unit: 'V' },
  freq: { label: 'Freq', unit: 'Hz', digits: 5 },
  period: { label: 'Period', unit: 's', digits: 5 },
  duty: { label: 'Duty', unit: '%' },
  pwidth: { label: '+Width', unit: 's' },
  nwidth: { label: '−Width', unit: 's' },
  rise: { label: 'Rise', unit: 's' },
  fall: { label: 'Fall', unit: 's' },
};

/** Most common value among x[i] in [lo, hi) (histogram with `bins` bins): {value, count}. */
function mode(x, lo, hi, bins = 64) {
  const h = new Uint32Array(bins), w = (hi - lo) / bins;
  if (!(w > 0)) return { value: lo, count: 0 };
  let n = 0;
  for (const v of x) if (v >= lo && v < hi) { h[Math.min(bins - 1, Math.floor((v - lo) / w))]++; n++; }
  let k = 0;
  for (let i = 1; i < bins; i++) if (h[i] > h[k]) k = i;
  // Average the samples in the winning bin: a better estimate than the bin centre.
  let s = 0, c = 0;
  const a = lo + k * w, b = a + w;
  for (const v of x) if (v >= a && v < b) { s += v; c++; }
  return { value: c ? s / c : a + w / 2, count: h[k], n };
}

/** Time (fractional sample index) where x crosses `level` between samples i-1 and i. */
const cross = (x, i, level) => i - 1 + (level - x[i - 1]) / (x[i] - x[i - 1] || 1);

/**
 * x: samples in volts, rate: samples/s, lsb: volts per ADC code (noise and resolution scale).
 * Returns every quantity in MEASUREMENTS (NaN where it doesn't apply, e.g. no edges) plus
 * `limited`: set of keys that are at the time resolution limit (shown as "<").
 */
export function measure(x, rate, lsb) {
  const n = x.length;
  const out = { limited: new Set() };
  if (!n) return out;
  let lo = Infinity, hi = -Infinity, sum = 0, sq = 0;
  for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; sq += v * v; }
  const mean = sum / n;
  Object.assign(out, {
    max: hi, min: lo, pp: hi - lo, mean,
    rms: Math.sqrt(sq / n), acrms: Math.sqrt(Math.max(0, sq / n - mean * mean)),
  });

  // Top and base: the most common levels in the upper and lower halves (flat tops of a
  // pulse), or max and min when there's no clear level (a sine).
  const mid0 = (hi + lo) / 2;
  const t = mode(x, mid0, hi + 1e-12), b = mode(x, lo, mid0);
  out.top = t.count >= 0.05 * n && t.count >= 0.1 * t.n ? t.value : hi;
  out.base = b.count >= 0.05 * n && b.count >= 0.1 * b.n ? b.value : lo;
  out.amp = out.top - out.base;
  for (const k of ['freq', 'period', 'duty', 'pwidth', 'nwidth', 'rise', 'fall']) out[k] = NaN;
  if (out.amp < 6 * lsb) return out;   // flat: no edges to time

  // Edges: mid-level crossings with hysteresis (8-bit noise is a few codes), interpolated.
  const mid = (out.top + out.base) / 2, hyst = Math.max(out.amp / 8, lsb);
  const edges = [];   // {t, up, i}
  let state = x[0] > mid ? 1 : 0;
  for (let i = 1; i < n; i++) {
    const v = x[i];
    if (state === 0 && v > mid + hyst) {
      let j = i;
      while (j > 1 && x[j - 1] > mid) j--;
      edges.push({ t: cross(x, j, mid), up: true, i });
      state = 1;
    } else if (state === 1 && v < mid - hyst) {
      let j = i;
      while (j > 1 && x[j - 1] < mid) j--;
      edges.push({ t: cross(x, j, mid), up: false, i });
      state = 0;
    }
  }
  const ups = edges.filter((e) => e.up), downs = edges.filter((e) => !e.up);
  const periodOf = (es) => (es.length >= 2 ? (es[es.length - 1].t - es[0].t) / (es.length - 1) : NaN);
  let per = periodOf(ups);
  if (!Number.isFinite(per)) per = periodOf(downs);
  out.period = per / rate;
  out.freq = rate / per;
  // Mean and rms over whole cycles when there are any: a partial cycle biases them.
  const es = ups.length >= 2 ? ups : downs.length >= 2 ? downs : null;
  if (es) {
    const i0 = Math.ceil(es[0].t), i1 = Math.floor(es[es.length - 1].t);
    let cs = 0, cq = 0;
    for (let i = i0; i < i1; i++) { cs += x[i]; cq += x[i] * x[i]; }
    const c = i1 - i0;
    if (c > 0) {
      out.mean = cs / c;
      out.rms = Math.sqrt(cq / c);
      out.acrms = Math.sqrt(Math.max(0, cq / c - out.mean * out.mean));
    }
  }

  // Pulse widths: from each edge to the next one of the other kind.
  const widths = (up) => {
    const w = [];
    for (let k = 0; k + 1 < edges.length; k++) if (edges[k].up === up && edges[k + 1].up !== up) w.push(edges[k + 1].t - edges[k].t);
    return w.length ? w.reduce((a, c) => a + c, 0) / w.length / rate : NaN;
  };
  out.pwidth = widths(true);
  out.nwidth = widths(false);
  if (Number.isFinite(out.pwidth) && Number.isFinite(out.nwidth)) out.duty = 100 * out.pwidth / (out.pwidth + out.nwidth);
  else if (Number.isFinite(out.pwidth) && Number.isFinite(per)) out.duty = 100 * out.pwidth * rate / per;

  // Rise/fall: 10 % to 90 % of the amplitude, around each mid crossing.
  const l10 = out.base + 0.1 * out.amp, l90 = out.base + 0.9 * out.amp;
  const transition = (e) => {
    // Rising: back from the mid crossing to the last sample at or below 10 %, forward to the
    // first at or above 90 % (mirrored for falling edges).
    const sgn = e.up ? 1 : -1, from = e.up ? l10 : l90, to = e.up ? l90 : l10;
    let k = Math.floor(e.t), j = k + 1;
    while (k >= 0 && sgn * (x[k] - from) > 0) k--;
    while (j < n && sgn * (x[j] - to) < 0) j++;
    if (k < 0 || j >= n) return null;
    return { dt: cross(x, j, to) - cross(x, k + 1, from), inside: j - k - 1 };
  };
  for (const [key, es] of [['rise', ups], ['fall', downs]]) {
    const ts = es.map(transition).filter(Boolean);
    if (!ts.length) continue;
    out[key] = ts.reduce((a, c) => a + c.dt, 0) / ts.length / rate;
    // Two samples or fewer across the edge: the true time is shorter than we can see.
    if (ts.every((c) => c.inside <= 1)) { out[key] = Math.max(out[key], 1 / rate); out.limited.add(key); }
  }
  return out;
}
