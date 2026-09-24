// Impedance and loudspeaker (Thiele-Small) maths. Pure (tested under node).
//
// Wiring: generator → series resistor R → driver → ground; channel A at the generator side of R,
// B across the driver. Driver model: Re + jωLe in series with the motional parallel RLC
// (Res, Lces, Cmes), which resonates at fs with mechanical Q = Qms.
import { cabs, carg, cdiv, csub, cx, cmul } from './detect.js';

/** Z = R·B/(A−B) from the two phasors. */
export const impedance = (A, B, R) => cmul(cx(R), cdiv(B, csub(A, B)));

/** Re from two DC levels (equal-code tables): the difference cancels both channels' offsets. */
export const reFromDc = (a1, b1, a2, b2, R) => R * (b2 - b1) / ((a2 - a1) - (b2 - b1));

/** Model impedance at f for p = {Re, Le, Res, fs, Qms}. */
export function model(p, f) {
  const w = 2 * Math.PI * f, ws = 2 * Math.PI * p.fs;
  // Motional admittance: 1/Res + j(ω·Cmes − 1/(ω·Lces)), Cmes = Qms/(ωs·Res), Lces = Res/(ωs·Qms).
  const y = cx(1 / p.Res, (p.Qms / p.Res) * (w / ws - ws / w));
  const zm = cdiv(cx(1), y);
  return cx(p.Re + zm.re, w * p.Le + zm.im);
}

/** Linear interpolation of the log-frequency where `ys` crosses `level` between i-1 and i. */
function crossF(fs, ys, i, level) {
  const t = (level - ys[i - 1]) / (ys[i] - ys[i - 1]);
  return fs[i - 1] * (fs[i] / fs[i - 1]) ** t;
}

/**
 * Classical estimate from |Z|: fs at the peak, r0 = Zmax/Re, f1/f2 where |Z| = √r0·Re.
 * pts: [{f, z: {re, im}}] ascending in f. Re: known (DC) or null for the lowest-f real part.
 */
export function classical(pts, Re = null) {
  const f = pts.map((p) => p.f), m = pts.map((p) => cabs(p.z));
  let k = 0;
  for (let i = 1; i < m.length; i++) if (m[i] > m[k]) k = i;
  Re ??= Math.min(...pts.slice(0, Math.max(1, k)).map((p) => p.z.re));
  // Peak refined by the phase zero crossing next to it, when there is one.
  let fs = f[k];
  const ph = pts.map((p) => carg(p.z));
  if (k > 0 && ph[k - 1] > 0 && ph[k] <= 0) fs = crossF(f, ph, k, 0);
  else if (k + 1 < ph.length && ph[k] > 0 && ph[k + 1] <= 0) fs = crossF(f, ph, k + 1, 0);
  const zmax = m[k], r0 = zmax / Re, lvl = Math.sqrt(r0) * Re;
  let f1 = NaN, f2 = NaN;
  for (let i = k; i > 0; i--) if (m[i - 1] < lvl && m[i] >= lvl) { f1 = crossF(f, m, i, lvl); break; }
  for (let i = k + 1; i < m.length; i++) if (m[i - 1] >= lvl && m[i] < lvl) { f2 = crossF(f, m, i, lvl); break; }
  const Qms = Math.sqrt(r0) * Math.sqrt(f1 * f2) / (f2 - f1);
  // Le: the reactance left at the top of the sweep, where the motional branch is small.
  const top = pts[pts.length - 1];
  const Le = Math.max(0, top.z.im) / (2 * Math.PI * top.f);
  return { Re, Le, Res: zmax - Re, fs, Qms, f1, f2, r0 };
}

// ---------------------------------------------------------------- least-squares fit

/** Solves A·x = b (n×n, Gaussian elimination with partial pivoting). */
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) return null;
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}

const KEYS = ['Re', 'Le', 'Res', 'fs', 'Qms'];
const LE_FLOOR = 1e-7;   // Le is fitted as log(Le + floor): it may be ~0

/**
 * Levenberg–Marquardt fit of the driver model to measured impedance, relative residuals in
 * the complex plane, log parameters (all positive). opts.Re fixes Re (from DC).
 * Returns {params, derived (Qes, Qts, Zmax…), rms (relative residual), classical}.
 */
export function fitDriver(pts, opts = {}) {
  const init = classical(pts, opts.Re ?? null);
  const fixed = opts.Re != null ? new Set(['Re']) : new Set();
  const free = KEYS.filter((k) => !fixed.has(k));
  const toP = (u) => {
    const p = { ...init };
    free.forEach((k, i) => { p[k] = k === 'Le' ? Math.exp(u[i]) - LE_FLOOR : Math.exp(u[i]); });
    return p;
  };
  const resid = (p) => {
    const r = [];
    for (const { f, z } of pts) {
      const m = model(p, f), d = cabs(z) || 1;
      r.push((m.re - z.re) / d, (m.im - z.im) / d);
    }
    return r;
  };
  const cost = (r) => r.reduce((s, v) => s + v * v, 0);
  const safeInit = { ...init, Qms: Number.isFinite(init.Qms) && init.Qms > 0 ? init.Qms : 3 };
  let u = free.map((k) => Math.log(k === 'Le' ? safeInit.Le + LE_FLOOR : safeInit[k]));
  init.Qms = safeInit.Qms;
  let r = resid(toP(u)), c = cost(r), lambda = 1e-3;
  for (let it = 0; it < 200; it++) {
    const J = free.map((_, j) => {
      const du = u.slice(); du[j] += 1e-6;
      const rj = resid(toP(du));
      return rj.map((v, i) => (v - r[i]) / 1e-6);
    });
    const n = free.length;
    const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)));
    const Jtr = J.map((col) => col.reduce((s, v, i) => s + v * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10 && !improved; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const step = solve(A, Jtr.map((v) => -v));
      if (!step) break;
      const u2 = u.map((v, i) => v + step[i]);
      const r2 = resid(toP(u2)), c2 = cost(r2);
      if (c2 < c) {
        const done = c - c2 < 1e-12 * (1 + c);
        u = u2; r = r2; c = c2; lambda = Math.max(lambda / 10, 1e-12); improved = true;
        if (done) it = Infinity;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  const params = toP(u);
  params.Le = Math.max(0, params.Le);
  return { params, derived: derive(params), rms: Math.sqrt(c / r.length), classical: init };
}

/** Qes, Qts, Zmax, r0 from the model parameters. */
export function derive(p) {
  const Qes = p.Qms * p.Re / p.Res;
  return { Qes, Qts: p.Qms * Qes / (p.Qms + Qes), Zmax: p.Re + p.Res, r0: (p.Re + p.Res) / p.Re };
}

// ---------------------------------------------------------------- Vas

export const RHO_C2 = 1.184 * 346.1 ** 2;   // air at 25 °C: ρ·c² in Pa

/** Cone area in m² from the effective diameter in metres. */
export const coneArea = (d) => Math.PI * (d / 2) ** 2;

/** Added-mass method: fs, fs′ with mass m (kg) added, Sd (m²). Mms kg, Cms m/N, Vas m³. */
export function vasAddedMass({ fs, fsMass, m, Sd }) {
  const Mms = m / ((fs / fsMass) ** 2 - 1);
  const Cms = 1 / ((2 * Math.PI * fs) ** 2 * Mms);
  return { Mms, Cms, Vas: RHO_C2 * Sd * Sd * Cms };
}

/** Sealed-box method: free-air fs, Qes; in a box of volume Vb (m³): fc, Qec. */
export function vasSealed({ fs, Qes, fc, Qec, Vb }) {
  return { Vas: Vb * ((fc * Qec) / (fs * Qes) - 1) };
}

/** Amplifier output impedance from the open-circuit and loaded output levels into RL. */
export const outputImpedance = (vOpen, vLoad, RL) => RL * (vOpen / vLoad - 1);
