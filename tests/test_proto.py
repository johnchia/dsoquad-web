"""Cross-check the firmware framing (proto.c, built for the host) against tools/dsoq/protocol.py."""
import os
import random
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'dsoq'))
import protocol  # noqa: E402

BIN = os.path.join(tempfile.gettempdir(), 'dsoq_proto_host')


def setUpModule():
    subprocess.run(['gcc', '-O1', '-Wall', '-Werror', '-I', os.path.join(ROOT, 'firmware/app/src'),
                    os.path.join(ROOT, 'tests/proto_host.c'), os.path.join(ROOT, 'firmware/app/src/proto.c'),
                    '-o', BIN], check=True)


def bodies():
    rng = random.Random(1234)
    yield b''
    yield b'\x00'
    yield b'\x00' * 300
    yield bytes(range(1, 255))            # exactly one full 254-byte block
    yield bytes(range(1, 255)) + b'\x00'  # full block followed by a zero
    yield b'\x11' * 253 + b'\x00' + b'\x22' * 600
    for _ in range(40):
        n = rng.choice([1, 2, 60, 252, 253, 254, 255, 256, 508, 1000, 12288])
        yield bytes(rng.choice([0, rng.randrange(256)]) for _ in range(n))


class TestProto(unittest.TestCase):
    def test_c_encode_matches_python(self):
        for body in bodies():
            c = subprocess.run([BIN, 'enc', '0x84', '7', body.hex()], capture_output=True, check=True).stdout
            self.assertEqual(c, protocol.encode(0x84, 7, body), f'len {len(body)}')
            self.assertEqual(protocol.decode(c[:-1]), (0x84, 7, body))

    def test_c_decodes_python_frames(self):
        msgs = [(0x10, i, b) for i, b in enumerate(bodies()) if len(b) <= 60]  # host messages are small
        stream = b'\x00'.join(protocol.encode(t, s, b)[:-1] for t, s, b in msgs) + b'\x00'
        stream = b'\x00\x00' + b'\x07\x01\x02' + b'\x00' + stream  # truncated COBS block first
        out = subprocess.run([BIN, 'dec'], input=stream, capture_output=True, check=True).stdout.decode().split('\n')
        self.assertEqual(out[0], 'bad')
        got = [line for line in out[1:] if line]
        self.assertEqual(got, [f'{t} {s} {b.hex()}' for t, s, b in msgs])

    def test_corrupt_crc_rejected(self):
        f = bytearray(protocol.encode(0x02, 1, b'hello'))
        f[3] ^= 0x01
        out = subprocess.run([BIN, 'dec'], input=bytes(f), capture_output=True, check=True).stdout
        self.assertEqual(out, b'bad\n')


if __name__ == '__main__':
    unittest.main()
