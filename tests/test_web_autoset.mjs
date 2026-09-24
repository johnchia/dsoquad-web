// Auto set: the pure helpers, and a full run against the simulator.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as P from '../web/js/protocol.js';
import * as Cal from '../web/js/calibration.js';
import { Device } from '../web/js/device.js';
import { SimTransport } from '../web/js/transport.js';
import { autoset, bands, pickPos, pickRange, pickTdiv } from '../web/js/autoset.js';

const RANGES = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
const TDIVS = [];
for (let e = -7; e <= 0; e++) for (const m of [1, 2, 5]) TDIVS.push(+(m * 10 ** e).toPrecision(1));

test('helpers', () => {
  assert.deepEqual(bands([true, false]).map((b) => b.center), [4, 4]);
  assert.deepEqual(bands([true, true]).map((b) => b.center), [6, 2]);
  assert.equal(RANGES[pickRange(RANGES, 2.4, 6)], 0.5);     // 2.4 V in 6 div at ≤ 85 %: 0.5 V/div
  assert.equal(RANGES[pickRange(RANGES, 2.4, 3.4)], 1);
  assert.equal(RANGES[pickRange(RANGES, 500, 6)], 10);      // beyond the widest range: stay widest
  assert.equal(pickPos(0, 3, 1, 4), 2.5);                    // 0..3 V centred at 4 div: 0 V at 2.5 div
  assert.equal(pickPos(10, 20, 1, 4), 0);                    // clamped
  assert.equal(pickTdiv(TDIVS, 1e-3), 5e-4);                 // 3 periods of 1 ms over 10 div
  assert.equal(pickTdiv(TDIVS, 1e-6), 5e-7);
});

test('auto set against the simulator fits both signals and finds the trigger source period', async () => {
  const dev = new Device(new SimTransport());
  await dev.open();
  const cal = Cal.nominal();
  const scale = (f, i) => {
    const codes = i ? f.b : f.a, c = f.ch[i];
    const zero = Cal.zeroCode(cal, i, c.range, c.offset), k = RANGES[c.range] / Cal.codesPerDiv(cal, i, c.range);
    return Float32Array.from(codes, (x) => (x - zero) * k);
  };
  const r = await autoset({
    dev, ranges: RANGES, tdivs: TDIVS, on: [true, true], coupling: [0, 0], trigSource: 0,
    offsetFor: (ch, range, pos) => Cal.offsetFor(cal, ch, range, P.ADC_ZERO + pos * P.CODES_PER_DIV),
    volts: scale,
  });
  await dev.close();
  assert.ok(r.found, 'period found');
  // The current trigger source (A) has a usable signal, so it's kept: 1 kHz.
  assert.equal(r.trig.source, 0);
  assert.ok(Math.abs(r.period - 1e-3) < 2e-5, `period ${r.period}`);
  assert.equal(r.tdiv, 5e-4);
  // The simulator's front end reads a few % off nominal: 1 or 2 V/div are both a fit.
  assert.ok([1, 2].includes(RANGES[r.ch[0].range]), `A ${RANGES[r.ch[0].range]} V/div`);
  assert.ok([1, 2].includes(RANGES[r.ch[1].range]), `B ${RANGES[r.ch[1].range]} V/div`);
  assert.ok(r.ch[0].posDiv > 4 && r.ch[1].posDiv < 4, `positions ${r.ch[0].posDiv} ${r.ch[1].posDiv}`);
});
