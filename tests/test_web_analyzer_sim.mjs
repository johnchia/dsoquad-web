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
import { DUTS, SIM_B_GAIN, SIM_BOX, SIM_DRIVER, SIM_MASS, SIM_MMS, SIM_R, SIM_SD } from '../web/js/analyzer/duts.js';
import * as Match from '../web/js/analyzer/match.js';
import { RHO_C2, fitDriver, fromVas, impedance, reFromDc, vasAddedMass, vasSealed } from '../web/js/analyzer/speaker.js';
import { measureDc, measureRangeGains } from '../web/js/analyzer/run.js';
import { planPoint } from '../web/js/analyzer/sweep.js';
import { cx } from '../web/js/analyzer/detect.js';

const RANGES = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];

// Expected B/A for the simulator: the circuit, B's front-end mismatch, and the uncalibrated
// gains of the ranges each channel ended up on.
const sim = new SimTransport();
const expect = (dut, p) => {
  const H = DUTS[dut].h(p.f), k = SIM_B_GAIN * sim.frontGain(1, p.b.range) / sim.frontGain(0, p.a.range);
  return { re: H.re * k, im: H.im * k };
};

/** The calibration a perfect run on the simulator would find (its zero and gain errors). */
function simCal() {
  const cal = Cal.nominal();
  cal.ch.forEach((rs, ch) => rs.forEach((e, r) => Object.assign(e, {
    a: ch ? 14 - r * 0.5 : 9 + r * 0.4, b: ch ? 0.985 : 1.012, gain: sim.frontGain(ch, r), zeroCal: true, gainCal: true,
  })));
  return cal;
}

async function withSim(dut, fn) {
  const t = new SimTransport();
  t.dut = dut;
  const dev = new Device(t);
  await dev.open();
  try { return await fn(dev, t); } finally { await dev.close(); }
}

const sweep = (dut, freqs, opts = {}, ctx = {}) => withSim(dut, (dev) =>
  runSweep({ dev, cal: Cal.nominal(), ranges: RANGES, amp: 0.9, ...ctx }, planSweep(freqs).points, opts));

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

test('channel match: a loopback removes the B front end\'s gain and delay; the record round-trips', { timeout: 60000 }, async () => {
  const cal = simCal();
  const loop = await sweep('through', logFreqs(Match.FROM_HZ, Match.TO_HZ, Match.PER_DECADE), {}, { cal });
  const m = Match.fromSweep(loop);
  assert.ok(m.pts.length <= Match.MAX_POINTS);
  assert.equal(m.rA, 3); assert.equal(m.rB, 3);
  const back = Match.decode(Match.encode(m));
  assert.equal(back.pts.length, m.pts.length);
  assert.ok(Math.abs(back.pts[3].db - m.pts[3].db) < 1e-4);
  // Measured: the simulated 1.004 gain and 6 ns delay.
  const top = m.pts[m.pts.length - 1];
  assert.ok(Math.abs(top.db - 20 * Math.log10(SIM_B_GAIN)) < 0.02, `gain ${top.db}`);
  assert.ok(Math.abs(top.deg + 360 * top.f * 6e-9) < 0.1, `phase ${top.deg} at ${top.f}`);
  // Applied: an RC sweep now matches the circuit alone.
  const rc = await sweep('rc', [200, 1591, 10000], {}, { cal, match: back });
  for (const p of rc) {
    const H = DUTS.rc.h(p.f), d = cdiv(p.h, H);
    assert.ok(Math.abs(20 * Math.log10(cabs(d))) < 0.03, `${p.f} Hz: ${20 * Math.log10(cabs(d))} dB`);
    assert.ok(Math.abs(carg(d) * 180 / Math.PI) < 0.3, `${p.f} Hz: ${carg(d) * 180 / Math.PI}°`);
  }
  // Nonsense (B on something else) is refused.
  assert.throws(() => Match.fromSweep([{ f: 100, h: cx(0.1) }]), /both probes/);
});

/** A full channel match on the simulator (both probes on the wave out). */
async function simMatch(cal) {
  const loop = await sweep('through', logFreqs(Match.FROM_HZ, Match.TO_HZ, Match.PER_DECADE), {}, { cal });
  const gains = await withSim('through', (dev) => measureRangeGains({ dev, cal, ranges: RANGES, acSettleS: 0 }, planPoint(1000), loop[0].a.range));
  return Match.fromSweep(loop, gains);
}

test('range gains: the chain recovers the simulator\'s per-range gain errors', { timeout: 120000 }, async () => {
  const m = await simMatch(Cal.nominal());
  const db = (x) => 20 * Math.log10(x);
  for (let r = 0; r < 6; r++) {
    // Relative to A on range 3: A's and B's uncalibrated gains, and B's front end.
    const ga = db(sim.frontGain(0, r) / sim.frontGain(0, 3)), gb = db(sim.frontGain(1, r) * SIM_B_GAIN / sim.frontGain(0, 3));
    // 2 V/div and up: the 1.2 V sine spans few codes (hardware repeats to ~0.05 dB there too).
    const tol = r >= 5 ? 0.06 : 0.03;
    assert.ok(Math.abs(m.ga[r] - ga) < tol, `A range ${r}: ${m.ga[r]} vs ${ga}`);
    assert.ok(Math.abs(m.gb[r] - gb) < tol, `B range ${r}: ${m.gb[r]} vs ${gb}`);
  }
  const back = Match.decode(Match.encode(m));
  assert.ok(Math.abs(back.gb[2] - m.gb[2]) < 1e-4);
});

test('loudspeaker behind R, uncalibrated DSO: channel match with range gains, impedance sweep, Thiele-Small fit, Re at DC', { timeout: 180000 }, async () => {
  const cal = Cal.nominal();
  const m = await simMatch(cal);
  const pts = await sweep('speaker', logFreqs(10, 20000, 10), {}, { cal, match: m });
  assert.ok(pts.some((p) => p.b.range < p.a.range), 'B on finer ranges than A');
  const z = pts.map((p) => ({ f: p.f, z: impedance(cx(1), p.h, SIM_R) }));
  const { params, derived } = fitDriver(z);
  for (const k of ['Re', 'fs', 'Qms']) assert.ok(Math.abs(params[k] / SIM_DRIVER[k] - 1) < 0.02, `${k} ${params[k]} vs ${SIM_DRIVER[k]}`);
  assert.ok(Math.abs(derived.Qes / 0.45 - 1) < 0.02, `Qes ${derived.Qes}`);
  assert.ok(Math.abs(params.Le / SIM_DRIVER.Le - 1) < 0.1, `Le ${params.Le}`);
  // Re at DC: two constant outputs on fixed ranges, B corrected by the match on those ranges.
  const dc = await withSim('speaker', (dev) => measureDc({ dev, cal, ranges: RANGES }));
  const [[a1, b1], [a2, b2]] = dc.levels, k = cabs(Match.ratio(m, 0, ...dc.ranges));
  const re = reFromDc(a1, b1 / k, a2, b2 / k, SIM_R);
  assert.ok(Math.abs(re / SIM_DRIVER.Re - 1) < 0.02, `Re at DC ${re}`);
});

test('Vas: free air against added mass and against a sealed box', { timeout: 240000 }, async () => {
  const fit = async (dut) => {
    const pts = await sweep(dut, logFreqs(10, 1000, 20), {}, { cal: simCal() });
    const f = fitDriver(pts.map((p) => ({ f: p.f, z: impedance(cx(1), p.h, SIM_R) })));
    return { ...f.params, Qes: f.derived.Qes };
  };
  const free = await fit('speaker'), mass = await fit('speakerMass'), box = await fit('speakerBox');
  const Vas = RHO_C2 * SIM_SD ** 2 / ((2 * Math.PI * SIM_DRIVER.fs) ** 2 * SIM_MMS);   // 13.7 L
  const vm = vasAddedMass({ fs: free.fs, fsMass: mass.fs, m: SIM_MASS, Sd: SIM_SD }).Vas;
  const vb = vasSealed({ fs: free.fs, Qes: free.Qes, fc: box.fs, Qec: box.Qes, Vb: SIM_BOX }).Vas;
  assert.ok(Math.abs(vm / Vas - 1) < 0.01, `added mass: ${vm * 1e3} L vs ${Vas * 1e3}`);
  assert.ok(Math.abs(vb / Vas - 1) < 0.02, `sealed box: ${vb * 1e3} L vs ${Vas * 1e3}`);
  const t = fromVas({ ...free, Vas: vm, Sd: SIM_SD });
  assert.ok(Math.abs(t.Mms / SIM_MMS - 1) < 0.01, `Mms ${t.Mms}`);
});
