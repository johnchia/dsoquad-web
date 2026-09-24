// Calibration against the in-page simulator, whose front end has known zero/offset/gain
// errors (web/js/transport.js SimTransport.code), plus the store record codecs.
//   node --test tests/*.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as P from '../web/js/protocol.js';
import * as Cal from '../web/js/calibration.js';
import { Device } from '../web/js/device.js';
import { SimTransport } from '../web/js/transport.js';

const RANGE_V = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
// Must match SimTransport.code().
const simZero = (ch, r) => ({ a: ch ? 14 - r * 0.5 : 9 + r * 0.4, b: ch ? 0.985 : 1.012 });
const simGain = (ch, r) => (ch ? 1.03 - r * 0.004 : 0.975 + r * 0.003);

test('store records round-trip and keep unknown tags', () => {
  const recs = new Map([[7, Uint8Array.of(1, 2, 3)], [1, Cal.encode(Cal.nominal())]]);
  const back = P.parseStore(P.buildStore(recs));
  assert.deepEqual([...back.get(7)], [1, 2, 3]);
  assert.equal(back.get(1).length, 4 + 16 * 13);
});

test('calibration record round-trips', () => {
  const c = Cal.nominal();
  c.created = '2026-09-23T12:00:00.000Z';
  c.ch[1][3] = { a: 12.5, b: 0.985, gain: 1.0123, zeroCal: true, gainCal: true };
  const d = Cal.decode(Cal.encode(c));
  assert.equal(d.created, c.created);
  assert.ok(Math.abs(d.ch[1][3].gain - 1.0123) < 1e-6);
  assert.deepEqual([d.ch[1][3].zeroCal, d.ch[1][3].gainCal, d.ch[0][0].zeroCal], [true, true, false]);
  const bad = Cal.encode(c);
  new DataView(bad.buffer).setFloat32(4 + 13 * 11 + 4, 50, true);   // absurd offset scale
  assert.throws(() => Cal.decode(bad));
});

test('zero and gain calibration recover the simulated front end, and persist', { timeout: 60000 }, async () => {
  const sim = new SimTransport();
  sim.fwName = `test-${Date.now()}`;   // private store
  const dev = new Device(sim);
  await dev.open();
  try {
    let cal = await Cal.loadFrom(dev);
    assert.equal(Cal.status(cal), 'none');

    sim.inputsOpen = true;
    ({ cal } = await Cal.runZero(dev, cal));
    sim.inputsOpen = false;
    for (const ch of [0, 1]) {
      for (let r = 0; r < 8; r++) {
        const e = cal.ch[ch][r], want = simZero(ch, r);
        const at154 = e.a + e.b * 154, want154 = want.a + want.b * 154;
        assert.ok(Math.abs(at154 - want154) < 0.3, `ch${ch} r${r} zero ${at154} vs ${want154}`);
        assert.ok(Math.abs(e.b - want.b) < 0.01, `ch${ch} r${r} b ${e.b}`);
      }
    }

    // Wave out held high = 3.0 V in the simulator, wired to CH A.
    await dev.setGen(1, 1000, 100);
    const g = await Cal.runGain(dev, cal, 0, 3.0, RANGE_V);
    const used = g.report.filter((x) => x.used).map((x) => x.range);
    assert.deepEqual(used, [3, 4, 5]);   // 0.5 V (6 div), 1 V (3 div), 2 V (1.5 div)
    for (const r of used) assert.ok(Math.abs(g.cal.ch[0][r].gain - simGain(0, r)) < 0.01, `gain r${r} ${g.cal.ch[0][r].gain}`);
    assert.equal(Cal.status(g.cal), 'partial');

    await Cal.saveTo(dev, g.cal);
    const back = await Cal.loadFrom(dev);
    assert.ok(Math.abs(back.ch[0][4].gain - g.cal.ch[0][4].gain) < 1e-6);
    await Cal.saveTo(dev, null);
    assert.equal(Cal.status(await Cal.loadFrom(dev)), 'none');
  } finally {
    await dev.close();
  }
});
