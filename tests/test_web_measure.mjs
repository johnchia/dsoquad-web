// Measurements on synthetic signals with known answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measure } from '../web/js/measure.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const LSB = 0.04;   // 1 V/div: 25 codes per division

test('square wave: levels, frequency, duty, widths', () => {
  const rate = 1e6, f = 1000, x = new Float64Array(4000);
  for (let i = 0; i < x.length; i++) x[i] = ((i / rate) * f) % 1 < 0.3 ? 2.6 : 0.05;
  const m = measure(x, rate, LSB);
  near(m.top, 2.6, 1e-9, 'top'); near(m.base, 0.05, 1e-9, 'base'); near(m.amp, 2.55, 1e-9, 'amp');
  near(m.freq, 1000, 0.5, 'freq'); near(m.period, 1e-3, 1e-6, 'period');
  near(m.duty, 30, 0.2, 'duty'); near(m.pwidth, 300e-6, 2e-6, '+width'); near(m.nwidth, 700e-6, 2e-6, '-width');
  assert.ok(m.limited.has('rise') && m.limited.has('fall'), 'ideal edges are below the resolution');
});

test('sine: rms, no flat top', () => {
  const rate = 1e6, x = new Float64Array(10000);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 + 1.5 * Math.sin(2 * Math.PI * 1234 * i / rate);
  const m = measure(x, rate, LSB);
  near(m.mean, 0.5, 0.01, 'mean'); near(m.acrms, 1.5 / Math.SQRT2, 0.01, 'ac rms');
  near(m.pp, 3, 1e-3, 'pp'); near(m.top, 2, 0.03, 'top ≈ max'); near(m.base, -1, 0.03, 'base ≈ min');
  near(m.freq, 1234, 0.2, 'freq'); near(m.duty, 50, 0.3, 'duty');
});

test('trapezoid: 10-90 % rise and fall times', () => {
  // 20 µs rise, 40 µs fall at 10 MS/s.
  const rate = 10e6, x = new Float64Array(20000), per = 1000e-6;
  for (let i = 0; i < x.length; i++) {
    const t = (i / rate) % per;
    x[i] = t < 20e-6 ? t / 20e-6 : t < 500e-6 ? 1 : t < 540e-6 ? 1 - (t - 500e-6) / 40e-6 : 0;
  }
  const m = measure(x, rate, 0.004);
  near(m.rise, 16e-6, 0.2e-6, 'rise'); near(m.fall, 32e-6, 0.2e-6, 'fall');
  assert.equal(m.limited.size, 0);
});

test('noise-only signal has no edges', () => {
  const x = Float64Array.from({ length: 4000 }, (_, i) => 0.01 * Math.sin(i));
  const m = measure(x, 1e6, LSB);
  assert.ok(Number.isNaN(m.freq) && Number.isNaN(m.rise));
});
