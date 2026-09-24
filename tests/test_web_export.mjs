// Interleaved frame decoding, CSV export and share links.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as P from '../web/js/protocol.js';
import { frameCsv, sharedSettings, shareLink } from '../web/js/export.js';

function frameBody(flags, words) {
  const n = words.length, out = new Uint8Array(22 + 3 * n), v = new DataView(out.buffer);
  out[4] = flags; v.setUint32(5, flags & P.FRAME_INTERLEAVED ? 72e6 : 1e6, true);
  v.setUint16(18, 150, true); v.setUint16(20, n, true);
  words.forEach(([a, b, cd], i) => { out[22 + 3 * i] = a; out[23 + 3 * i] = b; out[24 + 3 * i] = cd; });
  return out;
}

test('interleaved frames merge both ADCs into channel A, balanced', () => {
  // A sine sampled at 72 MS/s: even samples in ADC A, odd in ADC B, which reads 3 codes high.
  const sig = (k) => Math.round(128 + 60 * Math.sin(2 * Math.PI * k / 37.3));
  const words = Array.from({ length: 2000 }, (_, i) => {
    const [first, second] = [2 * i, 2 * i + 1].map(sig);
    return P.IL_B_FIRST ? [second, first + 3, 1] : [first, second + 3, 1];
  });
  const f = P.parseFrame(frameBody(1 | P.FRAME_INTERLEAVED, words));
  assert.ok(f.interleaved);
  assert.equal(f.count, 4000); assert.equal(f.pretrigger, 300); assert.equal(f.stale, 8); assert.equal(f.b, null);
  assert.ok(Math.abs(f.ilBalance + 3) < 0.1, `balance ${f.ilBalance}`);
  for (let k = 8; k < 4000; k++) assert.ok(Math.abs(f.a[k] - sig(k)) < 0.2, `sample ${k}: ${f.a[k]}`);
});

test('separate-mode frames are unchanged', () => {
  const f = P.parseFrame(frameBody(1, [[1, 2, 3], [4, 5, 0]]));
  assert.equal(f.interleaved, false); assert.equal(f.stale, P.STALE_SAMPLES);
  assert.deepEqual([...f.a], [1, 4]); assert.deepEqual([...f.b], [2, 5]);
});

test('actualRate: 72 MS/s above 36 MS/s', () => {
  assert.equal(P.actualRate(50e6), 72e6);
  assert.equal(P.actualRate(36e6), 36e6);
});

test('frameCsv: time from the trigger, one column per trace', () => {
  const f = { stale: 1, count: 3, pretrigger: 1, rate: 1e3, cd: Uint8Array.of(0, 3, 1) };
  const csv = frameCsv(f, [{ label: 'A', unit: 'V', data: Float32Array.of(9, 1.5, -0.25) }], ['hello']);
  assert.equal(csv, '# hello\nt (s),A (V),C,D\n0,1.5,1,1\n0.001,-0.25,1,0\n');
});

test('share links round-trip settings, unicode included', () => {
  const s = { math: { op: 'a-b' }, note: 'µs Δt' };
  const url = shareLink(s, 'https://example.org/app/?x=1#old');
  assert.ok(url.startsWith('https://example.org/app/?x=1#s='));
  assert.deepEqual(sharedSettings(url.slice(url.indexOf('#'))), s);
  assert.equal(sharedSettings('#s=!!'), null);
  assert.equal(sharedSettings(''), null);
});
