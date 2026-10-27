// Software edge trigger on synthetic signals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findEdge } from '../web/js/softtrig.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const sine = (n, per, ph = 0, amp = 1, noise = 0) => Float64Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * (i / per + ph)) + noise * (Math.random() * 2 - 1));

test('rising and falling edges of a sine, interpolated between samples', () => {
  const x = sine(4096, 100.37);   // rising zero crossings at k·100.37
  const r = findEdge(x, { rising: true, level: 0, hyst: 0.1, near: 2000 });
  near(r, 20 * 100.37, 0.01, 'rising');
  const f = findEdge(x, { rising: false, level: 0, hyst: 0.1, near: 2000 });
  near(f, 19.5 * 100.37, 0.01, 'falling');
  const l = findEdge(x, { rising: true, level: 0.5, hyst: 0.1, near: 2000 });
  near(l, (20 + 1 / 12) * 100.37, 0.05, 'rising through 0.5');
});

test('the edge nearest `near`, inside [from, to]', () => {
  const x = sine(4096, 400);
  assert.equal(Math.round(findEdge(x, { rising: true, level: 0, hyst: 0.1, near: 1150 })), 1200);
  assert.equal(Math.round(findEdge(x, { rising: true, level: 0, hyst: 0.1, near: 1150, from: 1300 })), 1600);
  assert.equal(Math.round(findEdge(x, { rising: true, level: 0, hyst: 0.1, near: 3000, to: 2500 })), 2400);
  assert.equal(findEdge(x, { rising: true, level: 0, hyst: 0.1, from: 1300, to: 1500 }), -1, 'no edge in the window');
});

test('hysteresis: noise on the level is not an edge', () => {
  // A slow ramp up through the level with ±0.05 noise: one edge, near where it crosses.
  const n = 4000, x = Float64Array.from({ length: n }, (_, i) => -1 + 2 * i / n + 0.05 * Math.sin(i * 1.7));
  const e = [];
  for (let from = 1; ;) {
    const at = findEdge(x, { rising: true, level: 0, hyst: 0.1, from, near: from });
    if (at < 0) break;
    e.push(at); from = Math.ceil(at) + 1;
  }
  assert.equal(e.length, 1, `edges: ${e}`);
  near(e[0], 2000, 100, 'edge (the noise touches the level up to 0.05/0.0005 samples early)');
  // Noisy sine: every edge found is a real one.
  const y = sine(4096, 256, 0, 1, 0.08);
  const at = findEdge(y, { rising: true, level: 0, hyst: 0.2, near: 1000 });
  near(at, 1024, 6, 'noisy sine edge');
});

test('flat or level outside the signal: no edge', () => {
  assert.equal(findEdge(new Float64Array(1000), { rising: true, level: 0, hyst: 0.1 }), -1);
  assert.equal(findEdge(sine(4096, 100), { rising: true, level: 1.5, hyst: 0.1 }), -1);
});

test('free-running simulator captures line up on the math edge', { timeout: 30000 }, async () => {
  // A = generator sine, B = it through the RC: A + B is one sine. Captures are forced (no
  // hardware trigger), so each starts at a random phase; aligned on the edge they must agree.
  const { Device } = await import('../web/js/device.js');
  const { SimTransport } = await import('../web/js/transport.js');
  const P = await import('../web/js/protocol.js');
  const Gen = await import('../web/js/wavegen.js');
  const t = new SimTransport(), dev = new Device(t);
  t.dut = 'rc';
  await dev.open();
  const frames = [];
  try {
    await dev.setGenWave(Gen.table('sine', Gen.planPoints(1000).n, 0.9, 0.5), 1000);
    await dev.setRate(200000);   // 1 ms/div at 200 samples/div
    dev.addEventListener('frame', (e) => frames.push(e.detail));
    await dev.setAcq(P.ACQ_AUTO, 1);
    for (let i = 0; i < 200 && frames.length < 10; i++) await new Promise((r) => setTimeout(r, 50));
    await dev.setAcq(P.ACQ_STOP, 100);
  } finally { await dev.close(); }
  assert.ok(frames.length >= 10, `${frames.length} frames`);
  assert.ok(frames.every((f) => f.auto), 'forced captures');
  const level = 110, posDiv = 1, perDiv = 200;
  let ref = null;
  for (const f of frames) {
    const m = Float64Array.from(f.a, (a, i) => a + f.b[i] - 256);
    const at = findEdge(m, { rising: true, level, hyst: 2.5, from: f.stale + posDiv * perDiv, to: f.count - 1 - (10 - posDiv) * perDiv });
    assert.ok(at >= posDiv * perDiv, `edge at ${at}`);
    const v = [];
    for (let k = -posDiv * perDiv; k < (10 - posDiv) * perDiv; k += 7) {
      const i = Math.floor(at + k), fr = at + k - i;
      v.push(m[i] * (1 - fr) + m[i + 1] * fr);
    }
    if (!ref) { ref = v; continue; }
    const rms = Math.sqrt(v.reduce((s, y, j) => s + (y - ref[j]) ** 2, 0) / v.length);
    assert.ok(rms < 4, `screen differs by ${rms.toFixed(2)} codes rms`);
  }
});
