// FFT amplitude/frequency accuracy, generator table planning, and analog output through the
// simulator end to end.   node --test tests/*.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as P from '../web/js/protocol.js';
import { WINDOWS, fft, peak, spectrum } from '../web/js/fft.js';
import * as Gen from '../web/js/wavegen.js';
import { Device } from '../web/js/device.js';
import { SimTransport } from '../web/js/transport.js';

const db = (v) => 20 * Math.log10(v);

test('fft matches a direct DFT', () => {
  const n = 64, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) * 0.1;
  const x = re.slice();
  fft(re, im);
  for (const k of [0, 1, 7, 31, 32]) {
    let sr = 0, si = 0;
    for (let i = 0; i < n; i++) { sr += x[i] * Math.cos(2 * Math.PI * k * i / n); si -= x[i] * Math.sin(2 * Math.PI * k * i / n); }
    assert.ok(Math.abs(sr - re[k]) < 1e-9 && Math.abs(si - im[k]) < 1e-9, `bin ${k}`);
  }
});

test('a 1 V amplitude sine reads 0.707 Vrms at the right frequency', () => {
  const rate = 1e6, f0 = 12345, n = 4092;
  const x = Float64Array.from({ length: n }, (_, i) => 0.25 + Math.sin(2 * Math.PI * f0 * i / rate));
  for (const [w, tol] of [['flattop', 0.02], ['hann', 1.5], ['blackmanharris', 1.0]]) {
    const sp = spectrum(x, w);
    const p = peak(sp.rms);
    assert.ok(Math.abs(p.bin * sp.binHz(rate) - f0) < sp.binHz(rate) * 0.1, `${w} freq ${p.bin * sp.binHz(rate)}`);
    assert.ok(Math.abs(db(p.rms) - db(Math.SQRT1_2)) < tol, `${w} level ${db(p.rms)} dBV`);
    assert.ok(Math.abs(sp.rms[0] - 0.25) < 0.01, `${w} DC ${sp.rms[0]}`);
  }
  assert.deepEqual(Object.keys(WINDOWS).sort(), ['blackmanharris', 'flattop', 'hann', 'rect']);
});

test('generator tables and point planning', () => {
  const sine = Gen.table('sine', 8, 1, 0.5);
  assert.deepEqual(sine.slice(0, 3), [2048, 3495, 4095]);
  assert.equal(Math.min(...Gen.table('triangle', 100, 0.5, 0.5)), 1024);
  assert.equal(Gen.table('ramp', 4, 1, 0.5)[0], 0);
  const p = Gen.planPoints(1000);
  assert.ok(p.n >= 384 && p.n <= 512 && p.err < 1e-3, JSON.stringify(p));
  assert.equal(Gen.planPoints(1000).actual, Gen.analogActual(1000, p.n));
  assert.ok(Gen.planPoints(125000).n === 16);
  assert.equal(Gen.planPoints(125001), null);
  for (const f of [1, 7, 50, 440, 1000, 3333, 20000, 100000]) {
    const q = Gen.planPoints(f);
    assert.ok(q.n * f <= P.DAC_MAX_RATE && q.err < 0.01, `${f} Hz: ${JSON.stringify(q)}`);
  }
});

test('analog sine through the simulator shows up in the FFT', { timeout: 20000 }, async () => {
  const dev = new Device(new SimTransport());
  await dev.open();
  try {
    const f0 = 5000, plan = Gen.planPoints(f0);
    await dev.setGenWave(Gen.table('sine', plan.n, 0.8, 0.5), f0);
    const st = await dev.state();
    assert.equal(st.genMode, P.GEN_ANALOG);
    assert.equal(st.waveLen, plan.n);
    await dev.setChannel(0, 4, 0, 104);
    await dev.setRate(200000);
    await dev.setTrigger(0, 1, 140, 0);
    const frame = new Promise((res) => dev.addEventListener('frame', (e) => res(e.detail), { once: true }));
    await dev.setAcq(P.ACQ_AUTO, 100);
    const f = await frame;
    const x = Float64Array.from(f.a.subarray(P.STALE_SAMPLES), (c) => (c - 104) / 25);   // 1 V/div, nominal
    const sp = spectrum(x, 'flattop');
    const pk = peak(sp.rms);
    assert.ok(Math.abs(pk.bin * sp.binHz(f.rate) - f0) < 60, `peak at ${pk.bin * sp.binHz(f.rate)} Hz`);
    // 0.8 of the simulated 2.5 V DAC span = 2 Vpp -> 0.707 Vrms, through the sim's gain error.
    assert.ok(Math.abs(pk.rms - 0.707) < 0.08, `level ${pk.rms} Vrms`);
    await dev.setAcq(P.ACQ_STOP);
  } finally {
    await dev.close();
  }
});
