// Analyzer core: sweep planning (coherence), tone detection, frequency response, impedance and
// the Thiele-Small fit, against synthetic records with 8-bit quantization and noise.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as P from '../web/js/protocol.js';
import { analogActual, planPoints } from '../web/js/wavegen.js';
import { USABLE, captureDiv, logFreqs, planPoint, planSweep, rateForDiv } from '../web/js/analyzer/sweep.js';
import { analyse, cabs, carg, cdiv, cx, polar } from '../web/js/analyzer/detect.js';
import { curve, readouts, refineFreqs } from '../web/js/analyzer/response.js';
import { classical, coneArea, fitDriver, impedance, model, outputImpedance, reFromDc, vasAddedMass, vasSealed } from '../web/js/analyzer/speaker.js';

const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b}`);

// Seeded noise so failures reproduce.
function rng(seed = 1) {
  return () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** An 8-bit capture of dc + Σ amp_h·cos(h·ω·t + ph_h) at the plan's exact rate and frequency. */
function capture(plan, tones, { vdiv = 0.5, dc = 0, noise = 0.3, seed = 1, phase0 = 0.7 } = {}) {
  const r = rng(seed), lsb = vdiv / P.CODES_PER_DIV, zero = 128;
  const x = new Float32Array(4096), codes = new Uint8Array(4096);
  for (let k = 0; k < x.length; k++) {
    const t = k / plan.rate;
    let v = dc;
    for (const { h = 1, amp, ph = 0 } of tones) v += amp * Math.cos(h * (2 * Math.PI * plan.actual * t + phase0) + ph);
    const c = Math.max(0, Math.min(255, Math.round(zero + v / lsb + noise * gauss(r))));
    codes[k] = c;
    x[k] = (c - zero) * lsb;
  }
  return { x, codes };
}

test('rate helpers mirror the firmware', () => {
  for (const hz of [1100, 3600, 44100, 1e6, 7.2e6, 36e6]) {
    assert.equal(P.actualRate(hz), Math.floor((P.TIMER_HZ + captureDiv(hz) / 2) / captureDiv(hz)));
  }
  for (const div of [2, 3, 71, 1000, 4097, 8000, 65515]) assert.equal(captureDiv(rateForDiv(div)), div);
  // Large dividers are reachable only in steps (integer rate requests near 1.1 kS/s).
  assert.equal(rateForDiv(65536), null);
});

test('every planned point is coherent, dense and within the record', () => {
  for (const f of [...logFreqs(1, 125000, 20), 7, 997, 44100, 99999]) {
    const p = planPoint(f);
    assert.ok(p, `plan for ${f} Hz`);
    const period = p.points * (p.genPsc + 1) * (p.genArr + 1);
    assert.equal(p.samples * p.capDiv, p.cycles * period, `${f} Hz: whole cycles`);
    assert.ok(Number.isInteger(p.cycles) && p.cycles >= 2, `${f} Hz: cycles ${p.cycles}`);
    assert.ok(p.samples <= USABLE && p.samples >= 0.5 * USABLE, `${f} Hz: ${p.samples} samples`);
    assert.ok(p.spc >= 8, `${f} Hz: ${p.spc} samples per cycle`);
    assert.equal(captureDiv(p.rateReq), p.capDiv);
    near(p.actual, analogActual(f, p.points), 1e-12, 'generator frequency');
    assert.ok(Math.abs(p.actual - f) / f <= Math.max(2e-3, planPoints(f).err) + 1e-12, `${f} Hz: made ${p.actual}`);
  }
  assert.equal(planPoint(200000), null);   // above the generator's range
});

test('sweep: log frequencies and time estimate', () => {
  const fs = logFreqs(10, 100000, 10);
  assert.equal(fs[0], 10); assert.equal(fs[fs.length - 1], 100000); assert.equal(fs.length, 41);
  const s = planSweep(fs);
  assert.equal(s.points.length, 41);
  assert.ok(s.seconds > 2 && s.seconds < 30, `${s.seconds} s`);
  assert.ok(planSweep(logFreqs(1, 10, 10)).seconds > s.seconds);   // slow points dominate
});

test('detector: amplitude, phase and harmonics on a quantized record', () => {
  const p = planPoint(1000);
  const { x } = capture(p, [{ amp: 1.2 }, { h: 2, amp: 0.012 }, { h: 3, amp: 0.024 }], { dc: 0.3 });
  const r = analyse(x, P.STALE_SAMPLES, p.samples, p.cycles);
  near(cabs(r.fund), 1.2, 2e-3, 'amplitude');
  near(r.dc, 0.3, 0.02, 'dc');
  near(r.harmonics[0], 0.012, 0.1, 'H2'); near(r.harmonics[1], 0.024, 0.05, 'H3');
  near(r.thd, Math.hypot(0.012, 0.024) / 1.2, 0.05, 'THD');
});

test('RC low-pass: gain within 0.05 dB and phase within 0.5° of theory from 20 Hz to 20 kHz', () => {
  const fc = 1 / (2 * Math.PI * 1e3 * 100e-9);    // 1 kΩ + 100 nF: 1.59 kHz
  const pts = [];
  for (const f of logFreqs(20, 20000, 10)) {
    const p = planPoint(f);
    const H = cdiv(cx(1), cx(1, p.actual / fc));
    // A: 1.3 V peak on 0.5 V/div; B: the filter output on the range that fits it best.
    const vB = [0.05, 0.1, 0.2, 0.5].find((v) => 1.3 * cabs(H) < 3.4 * v) ?? 0.5;
    const A = capture(p, [{ amp: 1.3 }], { seed: f });
    const B = capture(p, [{ amp: 1.3 * cabs(H), ph: carg(H) }], { seed: f + 1, vdiv: vB });
    const a = analyse(A.x, P.STALE_SAMPLES, p.samples, p.cycles), b = analyse(B.x, P.STALE_SAMPLES, p.samples, p.cycles);
    pts.push({ f: p.actual, h: cdiv(b.fund, a.fund), theory: H });
  }
  const c = curve(pts);
  for (const q of c) {
    assert.ok(Math.abs(q.gainDb - 20 * Math.log10(cabs(q.theory))) < 0.05, `${q.f} Hz gain ${q.gainDb}`);
    assert.ok(Math.abs(q.phaseDeg - carg(q.theory) * 180 / Math.PI) < 0.5, `${q.f} Hz phase ${q.phaseDeg}`);
  }
  const r = readouts(c, { refF: 20 });
  near(r.highF, fc, 0.02, '−3 dB point');
  assert.ok(Number.isNaN(r.lowF));
});

test('phase unwrap through −180°', () => {
  const pts = [0, -90, -170, -190, -270, -350].map((d, i) => ({ f: 10 * (i + 1), h: polar(1, d * Math.PI / 180) }));
  assert.deepEqual(curve(pts).map((q) => Math.round(q.phaseDeg)), [0, -90, -170, -190, -270, -350]);
});

// A small woofer: Re 5.6 Ω, Le 0.4 mH, fs 48 Hz, Qms 4.2, Qes 0.45.
const DRIVER = { Re: 5.6, Le: 0.4e-3, fs: 48, Qms: 4.2 };
DRIVER.Res = DRIVER.Re * DRIVER.Qms / 0.45;

test('impedance and Re from the wiring', () => {
  const R = 47, Z = cx(8, 3), A = cx(1.1, 0.2);
  const B = cdiv(cx(A.re * Z.re - A.im * Z.im, A.re * Z.im + A.im * Z.re), cx(R + Z.re, Z.im));   // divider
  const z = impedance(A, B, R);
  near(z.re, 8, 1e-9, 'Re(Z)'); near(z.im, 3, 1e-9, 'Im(Z)');
  // DC: A = V, B = V·Re/(R+Re) plus offsets that cancel.
  const b = (v) => v * 5.6 / (47 + 5.6);
  near(reFromDc(0.2 + 0.013, b(0.2) - 0.02, 2.5 + 0.013, b(2.5) - 0.02, 47), 5.6, 1e-9, 'Re from DC');
});

test('Thiele-Small fit recovers a synthetic driver to < 1 % from a noisy measured sweep', () => {
  const R = 47, pts = [];
  for (const f of logFreqs(10, 20000, 10)) {
    const p = planPoint(f), z = model(DRIVER, p.actual);
    // Gen → R → driver: B = A·Z/(R+Z). Channel A 1.3 V peak on 0.5 V/div, B on a range that fits.
    const H = cdiv(z, cx(R + z.re, z.im));
    const vB = [0.02, 0.05, 0.1, 0.2, 0.5].find((v) => 1.3 * cabs(H) < 3.4 * v) ?? 0.5;
    const A = capture(p, [{ amp: 1.3 }], { seed: f });
    const B = capture(p, [{ amp: 1.3 * cabs(H), ph: carg(H) }], { seed: f + 7, vdiv: vB });
    const a = analyse(A.x, P.STALE_SAMPLES, p.samples, p.cycles), b = analyse(B.x, P.STALE_SAMPLES, p.samples, p.cycles);
    pts.push({ f: p.actual, z: impedance(a.fund, b.fund, R) });
  }
  const { params, derived, rms } = fitDriver(pts);
  for (const k of ['Re', 'fs', 'Qms']) near(params[k], DRIVER[k], 0.01, k);
  near(derived.Qes, 0.45, 0.01, 'Qes');
  near(derived.Qts, 4.2 * 0.45 / 4.65, 0.01, 'Qts');
  near(params.Le, DRIVER.Le, 0.05, 'Le');
  assert.ok(rms < 0.02, `residual ${rms}`);
  // The classical estimate (the fit's starting point) is in the right place too.
  const c = classical(pts);
  near(c.fs, 48, 0.05, 'classical fs');
});

test('fit with Re fixed from DC', () => {
  const pts = logFreqs(10, 20000, 10).map((f) => ({ f, z: model(DRIVER, f) }));
  const { params } = fitDriver(pts, { Re: 5.6 });
  assert.equal(params.Re, 5.6);
  near(params.fs, 48, 1e-4, 'fs'); near(params.Qms, 4.2, 1e-4, 'Qms');
});

test('Vas and amplifier helpers', () => {
  // A driver with Mms 20 g and Cms 0.55 mm/N: fs = 1/(2π√(M·C)).
  const Mms = 0.020, Cms = 0.55e-3, fs = 1 / (2 * Math.PI * Math.sqrt(Mms * Cms));
  const fsMass = 1 / (2 * Math.PI * Math.sqrt((Mms + 0.010) * Cms));
  const Sd = coneArea(0.13);
  const v = vasAddedMass({ fs, fsMass, m: 0.010, Sd });
  near(v.Mms, Mms, 1e-9, 'Mms'); near(v.Cms, Cms, 1e-9, 'Cms');
  near(v.Vas, 1.184 * 346.1 ** 2 * Sd * Sd * Cms, 1e-9, 'Vas');
  // Sealed box: with α = Vas/Vb, fc = fs√(1+α) and Qec = Qes√(1+α).
  const k = Math.sqrt(1 + 2);
  near(vasSealed({ fs: 40, Qes: 0.4, fc: 40 * k, Qec: 0.4 * k, Vb: 0.01 }).Vas, 0.02, 1e-9, 'Vas sealed');
  near(outputImpedance(2.0, 1.9, 8), 8 * (2 / 1.9 - 1), 1e-12, 'Zout');
});

test('refinement sharpens the −3 dB points of a band-pass', () => {
  const h = (f) => { const R = 100, L = 10e-3, C = 100e-9, w = 2 * Math.PI * f; return cdiv(cx(R), cx(R, w * L - 1 / (w * C))); };
  const pts = (fs) => curve(fs.map((f) => ({ f, freq: f, h: h(f) })));
  const coarse = logFreqs(500, 50000, 10), c = pts(coarse), r = readouts(c);
  const q = Math.sqrt(10e-3 / 100e-9) / 100, f0 = 1 / (2 * Math.PI * Math.sqrt(10e-3 * 100e-9));
  const lo = f0 * (Math.sqrt(1 + 1 / (4 * q * q)) - 1 / (2 * q)), hi = f0 * (Math.sqrt(1 + 1 / (4 * q * q)) + 1 / (2 * q));
  assert.ok(Math.abs(r.lowF / lo - 1) > 0.005);             // the coarse grid alone is off
  const extra = refineFreqs(c, r);
  assert.ok(extra.length >= 6 && extra.length <= 12, `${extra.length} extra points`);
  const r2 = readouts(pts([...coarse, ...extra].sort((a, b) => a - b)));
  near(r2.lowF, lo, 0.002, 'low −3 dB'); near(r2.highF, hi, 0.002, 'high −3 dB'); near(r2.peakF, f0, 0.002, 'peak');
  near(r.peakF, f0, 0.02, 'peak from the coarse grid');
});
