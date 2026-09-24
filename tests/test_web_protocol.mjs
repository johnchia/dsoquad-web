// Cross-checks web/js/protocol.js against the Python codec and a real device recording.
//   node --test tests/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as P from '../web/js/protocol.js';

const root = new URL('..', import.meta.url).pathname;

function randomBytes(n, seed) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = (x >>> 16) % 4 === 0 ? 0 : (x >>> 8) & 0xFF;  // plenty of zeros
  }
  return b;
}

test('encoding matches Python byte for byte', () => {
  const cases = [0, 1, 2, 253, 254, 255, 508, 600, 1000].map((n, i) => ({ type: 0x10 + i, seq: i * 37, body: randomBytes(n, i + 1) }));
  const script = `
import sys, json
sys.path.insert(0, '${root}tools/dsoq')
from protocol import encode
for c in json.load(sys.stdin):
    print(encode(c['type'], c['seq'], bytes(c['body'])).hex())
`;
  const out = execFileSync('python3', ['-c', script], {
    input: JSON.stringify(cases.map((c) => ({ ...c, body: [...c.body] }))),
  }).toString().trim().split('\n');
  cases.forEach((c, i) => {
    const js = P.encode(c.type, c.seq, c.body);
    assert.equal(Buffer.from(js).toString('hex'), out[i], `case ${i} (${c.body.length} bytes)`);
    const d = P.decode(js.subarray(0, js.length - 1));
    assert.deepEqual([d.type, d.seq, [...d.body]], [c.type, c.seq & 0xFF, [...c.body]]);
  });
});

test('corrupted frames are rejected', () => {
  const m = P.encode(0x02, 1, Uint8Array.of(1, 2, 3));
  const bad = m.slice(0, m.length - 1);
  bad[2] ^= 0x40;
  assert.throws(() => P.decode(bad));
});

test('splitter handles arbitrary chunking', () => {
  const msgs = [P.encode(1, 1), P.encode(2, 2, randomBytes(700, 9)), P.encode(3, 3)];
  const stream = new Uint8Array(msgs.reduce((n, m) => n + m.length, 0));
  let o = 0;
  for (const m of msgs) { stream.set(m, o); o += m.length; }
  const sp = new P.FrameSplitter();
  const got = [];
  for (let i = 0; i < stream.length; i += 17) got.push(...sp.push(stream.subarray(i, i + 17)));
  assert.deepEqual(got.map((f) => P.decode(f).type), [1, 2, 3]);
});

test('real device recording decodes', () => {
  const data = new Uint8Array(readFileSync(`${root}web/recordings/square-1khz.dsoq`));
  const msgs = new P.FrameSplitter().push(data).map(P.decode);
  const types = new Set(msgs.map((m) => m.type));
  for (const t of [P.INFO, P.TABLE, P.STATE, P.FRAME]) assert.ok(types.has(t), `has ${t.toString(16)}`);

  const info = P.parseInfo(msgs.find((m) => m.type === P.INFO).body);
  assert.equal(info.proto, 1);
  const tables = Object.fromEntries(msgs.filter((m) => m.type === P.TABLE).map((m) => P.parseTable(m.body)).map((t) => [t.id, t.value]));
  assert.equal(tables[1].length, 8);
  assert.equal(tables[1][0].voltsPerDiv, 0.05);
  assert.equal(tables[1][7].str, '10V');
  const st = P.parseState(msgs.find((m) => m.type === P.STATE).body);
  assert.equal(st.rateActual, P.actualRate(st.rateReq));

  const frames = msgs.filter((m) => m.type === P.FRAME).map((m) => P.parseFrame(m.body));
  assert.ok(frames.length > 5);
  const f = frames[1];
  assert.equal(f.count, 4096);
  assert.equal(f.pretrigger, 150);
  // Rising edge on A at the trigger point: below the level before it, at/above just after.
  assert.ok(f.triggered);
  assert.ok(f.a[f.pretrigger - 5] < f.trigLevel && f.a[f.pretrigger + 5] >= f.trigLevel);
});

test('actualRate mirrors the firmware divider maths', () => {
  assert.equal(P.actualRate(1e6), 1e6);
  assert.equal(P.actualRate(36e6), 36e6);
  assert.equal(P.actualRate(30e6), 24e6);   // rounds down to a whole divider
  assert.equal(P.actualRate(7e6), 6545455);  // 72 MHz / 11
  assert.equal(P.actualRate(1), 1);
});
