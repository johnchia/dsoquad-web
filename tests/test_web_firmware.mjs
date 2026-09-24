// Firmware update host side: Intel HEX parsing, CRC-32, the bundled release, and the
// FW_BEGIN/FW_DATA/FW_COMMIT sequence against a fake device.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as P from '../web/js/protocol.js';
import { Device } from '../web/js/device.js';

const root = new URL('..', import.meta.url).pathname;

function hexLine(type, addr, data) {
  const r = [data.length, addr >> 8 & 0xFF, addr & 0xFF, type, ...data];
  r.push(-r.reduce((a, b) => a + b, 0) & 0xFF);
  return ':' + r.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

// 0x0800C000: 8 bytes, a 3-byte gap, then 5 bytes (odd total: padded to even).
const HEX = [
  hexLine(4, 0, [0x08, 0x00]),
  hexLine(0, 0xC000, [0, 0x50, 0, 0x20, 0x09, 0xC1, 0, 0x08]),
  hexLine(0, 0xC00B, [1, 2, 3, 4, 5]),
  hexLine(1, 0, []),
].join('\n');

test('hexToImage matches the Python tool', () => {
  const img = P.hexToImage(HEX);
  assert.equal(img.length, 16);
  assert.deepEqual([...img.subarray(8, 11)], [0xFF, 0xFF, 0xFF]);
  assert.equal(img[15], 0xFF);
  const py = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, 'tools/dsoq'); import protocol
sys.stdout.write(protocol.hex_to_image(sys.stdin.read()).hex())`], { cwd: root, input: HEX }).toString();
  assert.equal(Buffer.from(img).toString('hex'), py);
});

test('hexToImage refuses images outside APP1 and bad records', () => {
  assert.throws(() => P.hexToImage([hexLine(4, 0, [0x08, 0x01]), hexLine(0, 0xC000, [1, 2])].join('\n')), /not an APP1 image/);
  assert.throws(() => P.hexToImage([hexLine(4, 0, [0x08, 0x00]), hexLine(0, 0xC000, [1, 2]), hexLine(0, 0xFFFE, [1, 2, 3, 4])].join('\n')), /not an APP1 image/);
  assert.throws(() => P.hexToImage(':0400000001020304FF'), /bad hex record/);
});

test('crc32 is zlib CRC-32', () => {
  assert.equal(P.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('the bundled firmware matches its manifest', { skip: !existsSync(`${root}web/firmware/manifest.json`) }, () => {
  const m = JSON.parse(readFileSync(`${root}web/firmware/manifest.json`, 'utf8'));
  const img = P.hexToImage(readFileSync(`${root}web/firmware/${m.file}`, 'utf8'));
  assert.equal(img.length, m.size);
  assert.equal(P.crc32(img).toString(16).padStart(8, '0'), m.crc32);
  assert.equal(P.imageVersion(img), m.fw);
});

test('fwUpdate stages every byte, then commits with the right size and CRC', async () => {
  const image = new Uint8Array(3000).map((_, i) => (i * 7) & 0xFF);
  const staged = new Uint8Array(image.length).fill(0xFF);
  const log = [];
  const t = {
    label: 'fake',
    open: async () => {}, close: async () => {},
    write: async (bytes) => {
      const { type, seq, body } = P.decode(bytes.subarray(0, bytes.length - 1));
      const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
      log.push(type);
      if (type === P.FW_DATA) staged.set(body.subarray(4), v.getUint32(0, true));
      if (type === P.FW_BEGIN || type === P.FW_COMMIT) {
        assert.equal(v.getUint32(0, true), image.length);
        assert.equal(v.getUint32(4, true), P.crc32(image));
      }
      queueMicrotask(() => t.onbytes(P.encode(P.ACK, seq, new Uint8Array([P.ACK_NAMES.indexOf('OK')]))));
    },
  };
  const d = new Device(t);
  await d.open();
  const seen = [];
  await d.fwUpdate(image, (f) => seen.push(f));
  assert.deepEqual(staged, image);
  assert.deepEqual(log, [P.SET_ACQ, P.FW_BEGIN, P.FW_DATA, P.FW_DATA, P.FW_DATA, P.FW_COMMIT]);
  assert.equal(seen.at(-1), 1);
});
