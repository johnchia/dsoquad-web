"""Codec for the DSO Quad control protocol (docs/protocol.md)."""
import binascii
import struct
from dataclasses import dataclass

# Host -> device
HELLO, PING, GET_STATE = 0x01, 0x02, 0x03
SET_CHANNEL, SET_TIMEBASE, SET_TRIGGER, SET_ACQ, SET_GEN, SET_SYSTEM, SET_WAVE = 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16
GET_TABLES, STORE_READ, STORE_WRITE = 0x20, 0x21, 0x22
FW_BEGIN, FW_DATA, FW_COMMIT = 0x23, 0x24, 0x25
REG_SET, REG_GET, PARAM_SET, PEEK, POKE, REBOOT = 0x30, 0x31, 0x32, 0x33, 0x34, 0x3F
# Device -> host
INFO, PONG, STATE, FRAME, TABLE, STORE_DATA, LOG, ACK, REG_VALUE = 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x8E, 0xA0, 0xB1
MEM_DATA, ROLL = 0xB3, 0x87

ACK_NAMES = ['OK', 'BAD_LENGTH', 'BAD_VALUE', 'UNKNOWN_TYPE', 'BAD_FRAME', 'BUSY', 'FLASH_ERROR']
ACQ_STOP, ACQ_NORMAL, ACQ_AUTO, ACQ_SINGLE, ACQ_ROLL = range(5)
TRIG_KINDS = ['falling', 'rising', 'low', 'high', 'low<w', 'low>w', 'high<w', 'high>w']

APP_BASE, APP_LIMIT = 0x0800C000, 0x0801C000   # APP1 up to the APP3 fallback
FW_CHUNK = 1024

ADC_ZERO = 54        # SYS convention: code 54 = screen bottom
CODES_PER_DIV = 25


def crc16(data: bytes, crc: int = 0xFFFF) -> int:
    """CRC-16/CCITT-FALSE (binascii.crc_hqx is the same polynomial, unreflected)."""
    return binascii.crc_hqx(data, crc)


def cobs_encode(data: bytes) -> bytes:
    out, block = bytearray(), bytearray()
    for b in data:
        if b == 0:
            out += bytes([len(block) + 1]) + block
            block.clear()
        else:
            block.append(b)
            if len(block) == 254:
                out += b'\xff' + block
                block.clear()
    out += bytes([len(block) + 1]) + block  # final block is always emitted
    return bytes(out)


def cobs_decode(data: bytes) -> bytes:
    out, i = bytearray(), 0
    while i < len(data):
        code = data[i]
        if code == 0 or i + code > len(data):
            raise ValueError('bad COBS')
        out += data[i + 1:i + code]
        i += code
        if code < 0xFF and i < len(data):
            out.append(0)
    return bytes(out)


def encode(msg_type: int, seq: int, body: bytes = b'') -> bytes:
    raw = bytes([msg_type, seq & 0xFF]) + body
    return cobs_encode(raw + struct.pack('<H', crc16(raw))) + b'\x00'


def decode(frame: bytes):
    """Decode one COBS frame (without the 0x00). Returns (type, seq, body) or raises ValueError."""
    raw = cobs_decode(frame)
    if len(raw) < 4:
        raise ValueError('short message')
    if crc16(raw[:-2]) != struct.unpack('<H', raw[-2:])[0]:
        raise ValueError('bad CRC')
    return raw[0], raw[1], raw[2:-2]


@dataclass
class Channel:
    range: int
    coupling: int
    offset: int


@dataclass
class State:
    acq_mode: int
    running: bool
    ch: list
    rate_req: int
    rate_actual: int
    psc: int
    arr: int
    trig_source: int
    trig_kind: int
    trig_level: int
    trig_width: int
    auto_ms: int
    gen_mode: int
    gen_freq: int
    gen_duty: int
    backlight: int
    beep: int
    frames: int
    battery_mv: int = 0
    charging: int = 0
    uptime_s: int = 0
    gen_psc: int = 0
    gen_arr: int = 0
    wave_len: int = 0

    @classmethod
    def parse(cls, b: bytes):
        f = struct.unpack_from('<BB6BIIHHBBBHHBIBBBI', b)
        extra = struct.unpack_from('<HBI', b, 39) if len(b) >= 46 else ()
        extra += struct.unpack_from('<HHH', b, 46) if len(b) >= 52 else ()
        ch = [Channel(*f[2:5]), Channel(*f[5:8])]
        return cls(f[0], bool(f[1]), ch, *f[8:], *extra)


@dataclass
class Frame:
    frame_no: int
    flags: int
    rate: int
    ch: list
    trig_source: int
    trig_kind: int
    trig_level: int
    pretrigger: int
    a: bytes
    b: bytes
    cd: bytes

    triggered = property(lambda s: bool(s.flags & 1))
    auto = property(lambda s: bool(s.flags & 2))
    interleaved = property(lambda s: bool(s.flags & 0x20))

    def channel_a(self):
        """Channel A samples: interleaved frames merge both ADCs (B byte first in time, shifted
        by the difference of the means; see docs/protocol.md), others return `a`."""
        if not self.interleaved:
            return list(self.a)
        d = (sum(self.a[4:]) - sum(self.b[4:])) / max(1, len(self.a) - 4)
        return [v for pair in zip((x + d for x in self.b), self.a) for v in pair]

    @classmethod
    def parse(cls, body: bytes):
        f = struct.unpack_from('<IBI6BBBBHH', body)
        count = f[-1]
        samples = body[22:22 + 3 * count]
        if len(samples) != 3 * count:
            raise ValueError('truncated frame')
        return cls(f[0], f[1], f[2], [Channel(*f[3:6]), Channel(*f[6:9])], f[9], f[10], f[11], f[12],
                   samples[0::3], samples[1::3], samples[2::3])


def parse_table(body: bytes):
    tid, size, count = body[0], body[1], body[2]
    raw = body[3:3 + size * count]
    rows = [raw[i * size:(i + 1) * size] for i in range(count)]
    if tid == 0:
        r = struct.unpack('<8H3Bx4H', rows[0])
        keys = 'LCD_X LCD_Y Yp_Max Xp_Max Tg_Num Yv_Max Xt_Max Co_Max Ya_Num Yd_Num INSERT KpA1 KpA2 KpB1 KpB2'
        return tid, dict(zip(keys.split(), r))
    if tid == 1:
        return tid, [dict(zip(('str', 'KA1', 'KA2', 'KB1', 'KB2', 'scale'),
                              (_s(r[:8]),) + struct.unpack('<hHhHI', r[8:]))) for r in rows]
    if tid == 2:
        return tid, [dict(zip(('str', 'psc', 'arr', 'ccr', 'kp', 'scale'),
                              (_s(r[:8]),) + struct.unpack('<hHHHI', r[8:]))) for r in rows]
    if tid == 3:
        return tid, [dict(str=_s(r[:8]), chx=r[8], cmd=r[9]) for r in rows]
    return tid, rows


def _s(b: bytes) -> str:
    return b.split(b'\x00')[0].decode('latin1').replace('!', '').strip()


def parse_store(blob: bytes) -> dict:
    """Store records (docs/protocol.md): {tag: bytes}."""
    out, i = {}, 0
    while i + 3 <= len(blob):
        tag, n = blob[i], struct.unpack_from('<H', blob, i + 1)[0]
        out[tag] = blob[i + 3:i + 3 + n]
        i += 3 + n
    return out


def parse_calibration(rec: bytes) -> dict:
    created, = struct.unpack_from('<I', rec)
    ch = [[], []]
    for k in range(16):
        a, b, gain, flags = struct.unpack_from('<fffB', rec, 4 + 13 * k)
        ch[k // 8].append({'a': a, 'b': b, 'gain': gain, 'zero_cal': bool(flags & 1), 'gain_cal': bool(flags & 2)})
    return {'created': created, 'ch': ch}


def hex_to_image(text: str) -> bytes:
    """Intel HEX -> APP1 image starting at APP_BASE (gaps 0xFF, padded to an even length).
    Refuses anything outside APP1."""
    base, mem = 0, {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith(':'):
            continue
        rec = bytes.fromhex(line[1:])
        if sum(rec) & 0xFF:
            raise ValueError(f'bad checksum: {line}')
        n, addr, typ, data = rec[0], rec[1] << 8 | rec[2], rec[3], rec[4:4 + rec[0]]
        if typ == 0:
            for i, v in enumerate(data):
                mem[base + addr + i] = v
        elif typ == 1:
            break
        elif typ == 2:
            base = (data[0] << 8 | data[1]) << 4
        elif typ == 4:
            base = (data[0] << 8 | data[1]) << 16
    if not mem:
        raise ValueError('empty hex file')
    lo, hi = min(mem), max(mem) + 1
    if lo != APP_BASE or hi > APP_LIMIT:
        raise ValueError(f'image 0x{lo:08X}-0x{hi - 1:08X} is not an APP1 image (0x{APP_BASE:08X}-0x{APP_LIMIT - 1:08X})')
    img = bytearray(b'\xff' * (hi - lo + (hi - lo) % 2))
    for a, v in mem.items():
        img[a - lo] = v
    return bytes(img)
