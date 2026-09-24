// Analyzer end to end against the simulator: sweeps through simulated circuits, auto-ranging,
// and results against the circuits' transfer functions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Cal from '../web/js/calibration.js';
import { Device } from '../web/js/device.js';
import { SimTransport } from '../web/js/transport.js';
import { logFreqs, planSweep } from '../web/js/analyzer/sweep.js';
import { runSweep, pickRange } from '../web/js/analyzer/run.js';
import { cabs, carg, cdiv } from '../web/js/analyzer/detect.js';
import { DUTS, SIM_B_GAIN } from '../web/js/analyzer/duts.js';

const RANGES = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];

// Expected B/A for the simulator: the circuit, B's front-end mismatch, and the uncalibrated
// gains of the ranges each channel ended up on.
const sim = new SimTransport();
const expect = (dut, p) => {
  const H = DUTS[dut].h(p.f), k = SIM_B_GAIN * sim.frontGain(1, p.b.range) / sim.frontGain(0, p.a.range);
  return { re: H.re * k, im: H.im * k };
};

async function sweep(dut, freqs, opts = {}) {
  const t = new SimTransport();
  t.dut = dut;
  const dev = new Device(t);
  await dev.open();
  try {
    const { points } = planSweep(freqs);
    return await runSweep({ dev, cal: Cal.nominal(), ranges: RANGES, amp: 0.9 }, points, opts);
  } finally { await dev.close(); }
}

test('pickRange: smallest range that holds the signal, centred', () => {
  const cal = Cal.nominal(), cur = { range: 7, offset: 128 };
  const p = pickRange(cal, 0, RANGES, cur, 0.1, 2.3, false);   // 2.2 Vpp around 1.2 V: 0.5 V/div
  assert.equal(RANGES[p.range], 0.5);
  assert.ok(!p.ok);
  const q = pickRange(cal, 0, RANGES, { range: p.range, offset: p.offset }, 0.1, 2.3, false);
  assert.ok(q.ok);
  // Clipped: at least one range up from the current one.
  assert.equal(pickRange(cal, 0, RANGES, { range: 2, offset: 128 }, -0.2, 0.2, true).range, 3);
});

test('RC low-pass through the simulator matches theory', { timeout: 60000 }, async () => {
  const pts = await sweep('rc', logFreqs(100, 20000, 4));
  assert.equal(pts.length, 10);
  for (const p of pts) {
    const H = expect('rc', p);
    const dDb = 20 * Math.log10(cabs(p.h) / cabs(H));
    const dDeg = carg(cdiv(p.h, H)) * 180 / Math.PI;
    assert.ok(Math.abs(dDb) < 0.1, `${p.f} Hz: ${dDb.toFixed(3)} dB off`);
    assert.ok(Math.abs(dDeg) < 1, `${p.f} Hz: ${dDeg.toFixed(2)}° off`);
    assert.ok(!p.a.clip && !p.b.clip, `${p.f} Hz clipped`);
  }
  // B follows the signal down: its range at 20 kHz is finer than at 100 Hz.
  assert.ok(pts[pts.length - 1].b.range < pts[0].b.range);
});

test('RLC band-pass peak', { timeout: 60000 }, async () => {
  const pts = await sweep('rlc', [2000, 4000, 5000, 5033, 6000, 12000]);
  const best = pts.reduce((a, b) => (cabs(b.h) > cabs(a.h) ? b : a));
  assert.ok(Math.abs(best.f - 5033) < 40, `peak at ${best.f}`);
  assert.ok(Math.abs(cabs(best.h) / cabs(expect('rlc', best)) - 1) < 0.01);
});
