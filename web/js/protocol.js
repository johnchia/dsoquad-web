// Codec for the DSO Quad control protocol (docs/protocol.md). No DOM use: also runs under node.

// Host -> device
export const HELLO = 0x01, PING = 0x02, GET_STATE = 0x03;
export const SET_CHANNEL = 0x10, SET_TIMEBASE = 0x11, SET_TRIGGER = 0x12, SET_ACQ = 0x13,
  SET_GEN = 0x14, SET_SYSTEM = 0x15;
export const GET_TABLES = 0x20;
export const REG_SET = 0x30, REG_GET = 0x31, PARAM_SET = 0x32, REBOOT = 0x3F;
// Device -> host
export const INFO = 0x81, PONG = 0x82, STATE = 0x83, FRAME = 0x84, TABLE = 0x85, LOG = 0x8E,
  ACK = 0xA0, REG_VALUE = 0xB1;

export const ACK_NAMES = ['OK', 'BAD_LENGTH', 'BAD_VALUE', 'UNKNOWN_TYPE', 'BAD_FRAME', 'BUSY'];
export const ACQ_STOP = 0, ACQ_NORMAL = 1, ACQ_AUTO = 2, ACQ_SINGLE = 3;
export const TRIG_KINDS = ['falling', 'rising', 'low', 'high', 'low<w', 'low>w', 'high<w', 'high>w'];

export const ADC_ZERO = 54;       // SYS convention: code 54 = screen bottom
export const CODES_PER_DIV = 25;
export const TIMER_HZ = 72e6;
export const MAX_RATE = 36e6;     // separate-channel mode (interleave is M4)
export const STALE_SAMPLES = 4;   // the FIFO's first few samples are left over from before the capture

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    t[i] = c & 0xFFFF;
  }
  return t;
})();

/** CRC-16/CCITT-FALSE. */
export function crc16(data, crc = 0xFFFF) {
  for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ data[i]) & 0xFF]) & 0xFFFF;
  return crc;
}

export function cobsEncode(data) {
  const out = new Uint8Array(data.length + Math.ceil(data.length / 254) + 1);
  let o = 1, codeAt = 0, code = 1;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) {
      out[codeAt] = code; codeAt = o++; code = 1;
    } else {
      out[o++] = data[i];
      if (++code === 0xFF) { out[codeAt] = code; codeAt = o++; code = 1; }
    }
  }
  out[codeAt] = code;  // final block is always emitted
  return out.subarray(0, o);
}

export function cobsDecode(data) {
  const out = new Uint8Array(data.length);
  let i = 0, o = 0;
  while (i < data.length) {
    const code = data[i];
    if (code === 0 || i + code > data.length) throw new Error('bad COBS');
    out.set(data.subarray(i + 1, i + code), o);
    o += code - 1;
    i += code;
    if (code < 0xFF && i < data.length) out[o++] = 0;
  }
  return out.subarray(0, o);
}

/** Encode one message, including the trailing 0x00 delimiter. */
export function encode(type, seq, body = new Uint8Array(0)) {
  const raw = new Uint8Array(body.length + 4);
  raw[0] = type; raw[1] = seq & 0xFF; raw.set(body, 2);
  const crc = crc16(raw.subarray(0, raw.length - 2));
  raw[raw.length - 2] = crc & 0xFF; raw[raw.length - 1] = crc >> 8;
  const enc = cobsEncode(raw);
  const out = new Uint8Array(enc.length + 1);
  out.set(enc);
  return out;
}

/** Decode one COBS frame (without the 0x00). Returns {type, seq, body}; throws on bad input. */
export function decode(frame) {
  const raw = cobsDecode(frame);
  if (raw.length < 4) throw new Error('short message');
  const crc = raw[raw.length - 2] | raw[raw.length - 1] << 8;
  if (crc16(raw.subarray(0, raw.length - 2)) !== crc) throw new Error('bad CRC');
  return { type: raw[0], seq: raw[1], body: raw.slice(2, raw.length - 2) };
}

/** Splits a byte stream on 0x00 delimiters. push() returns the complete frames seen so far. */
export class FrameSplitter {
  constructor(maxLen = 64 * 1024) {
    this.buf = new Uint8Array(maxLen);
    this.len = 0;
    this.overflow = false;
  }

  push(chunk) {
    const frames = [];
    let start = 0;
    for (;;) {
      const z = chunk.indexOf(0, start);
      const end = z < 0 ? chunk.length : z;
      const n = end - start;
      if (this.len + n <= this.buf.length) this.buf.set(chunk.subarray(start, end), this.len);
      else this.overflow = true;
      this.len += n;
      if (z < 0) break;
      if (this.len && !this.overflow) frames.push(this.buf.slice(0, this.len));
      this.len = 0;
      this.overflow = false;
      start = z + 1;
    }
    return frames;
  }
}

// ------------------------------------------------------------------ message bodies

const le = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function readChannels(v, off) {
  const ch = [];
  for (let i = 0; i < 2; i++) {
    ch.push({ range: v.getUint8(off + 3 * i), coupling: v.getUint8(off + 3 * i + 1), offset: v.getUint8(off + 3 * i + 2) });
  }
  return ch;
}

export function parseInfo(b) {
  const v = le(b);
  let end = b.indexOf(0, 6);
  if (end < 0) end = b.length;
  return {
    proto: v.getUint16(0, true),
    serial: v.getUint32(2, true).toString(16).toUpperCase().padStart(8, '0'),
    fw: new TextDecoder().decode(b.subarray(6, end)),
  };
}

export function parseState(b) {
  if (b.length < 39) throw new Error('short STATE');
  const v = le(b);
  const s = {
    acqMode: v.getUint8(0), running: !!v.getUint8(1), ch: readChannels(v, 2),
    rateReq: v.getUint32(8, true), rateActual: v.getUint32(12, true),
    psc: v.getUint16(16, true), arr: v.getUint16(18, true),
    trigSource: v.getUint8(20), trigKind: v.getUint8(21), trigLevel: v.getUint8(22), trigWidth: v.getUint16(23, true),
    autoMs: v.getUint16(25, true),
    genMode: v.getUint8(27), genFreq: v.getUint32(28, true), genDuty: v.getUint8(32),
    backlight: v.getUint8(33), beep: v.getUint8(34), frames: v.getUint32(35, true),
    batteryMv: null, charging: null, uptimeS: null,
  };
  if (b.length >= 46) {  // appended in firmware 0.3.0
    s.batteryMv = v.getUint16(39, true);
    s.charging = v.getUint8(41);
    s.uptimeS = v.getUint32(42, true);
  }
  return s;
}

export function parseFrame(b) {
  const v = le(b);
  const count = v.getUint16(20, true);
  if (b.length < 22 + 3 * count) throw new Error('truncated frame');
  const a = new Uint8Array(count), bb = new Uint8Array(count), cd = new Uint8Array(count);
  for (let i = 0, o = 22; i < count; i++, o += 3) { a[i] = b[o]; bb[i] = b[o + 1]; cd[i] = b[o + 2]; }
  const flags = v.getUint8(4);
  return {
    frameNo: v.getUint32(0, true), flags,
    triggered: !!(flags & 1), auto: !!(flags & 2), last: !!(flags & 4),
    rate: v.getUint32(5, true), ch: readChannels(v, 9),
    trigSource: v.getUint8(15), trigKind: v.getUint8(16), trigLevel: v.getUint8(17),
    pretrigger: v.getUint16(18, true), count, a, b: bb, cd,
  };
}

const cstr = (b) => {
  const z = b.indexOf(0);
  return String.fromCharCode(...(z < 0 ? b : b.subarray(0, z))).replace(/!/g, '').trim();
};

/** Returns {id, value}: G_attr as an object, the others as arrays of row objects. */
export function parseTable(b) {
  const [id, size, count] = b;
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(b.subarray(3 + i * size, 3 + (i + 1) * size));
  if (id === 0) {
    const v = le(rows[0]);
    const keys = ['LCD_X', 'LCD_Y', 'Yp_Max', 'Xp_Max', 'Tg_Num', 'Yv_Max', 'Xt_Max', 'Co_Max'];
    const g = {};
    keys.forEach((k, i) => { g[k] = v.getUint16(2 * i, true); });
    return { id, value: g };
  }
  if (id === 1) {
    return {
      id, value: rows.map((r) => {
        const v = le(r);
        const scale = v.getUint32(16, true);
        // SCALE is in units of 1/40000 V per division (50 mV range = 2000).
        return { str: cstr(r.subarray(0, 8)), KA1: v.getInt16(8, true), KA2: v.getUint16(10, true),
          KB1: v.getInt16(12, true), KB2: v.getUint16(14, true), scale, voltsPerDiv: scale / 40000 };
      }),
    };
  }
  if (id === 2) {
    return {
      id, value: rows.map((r) => {
        const v = le(r);
        return { str: cstr(r.subarray(0, 8)), psc: v.getInt16(8, true), arr: v.getUint16(10, true),
          ccr: v.getUint16(12, true), kp: v.getUint16(14, true), scale: v.getUint32(16, true) };
      }),
    };
  }
  if (id === 3) return { id, value: rows.map((r) => ({ str: cstr(r.subarray(0, 8)), chx: r[8], cmd: r[9] })) };
  return { id, value: rows };
}

// Request bodies. Each returns a Uint8Array.
const pack = (n, fill) => { const b = new Uint8Array(n); fill(new DataView(b.buffer)); return b; };
export const body = {
  channel: (ch, range, coupling, offset) => Uint8Array.of(ch, range, coupling, offset),
  timebase: (hz) => pack(4, (v) => v.setUint32(0, Math.round(hz), true)),
  trigger: (source, kind, level, width = 0) => pack(5, (v) => {
    v.setUint8(0, source); v.setUint8(1, kind); v.setUint8(2, level); v.setUint16(3, width, true);
  }),
  acq: (mode, autoMs = 100) => pack(3, (v) => { v.setUint8(0, mode); v.setUint16(1, autoMs, true); }),
  gen: (mode, freq, duty) => pack(6, (v) => { v.setUint8(0, mode); v.setUint32(1, Math.round(freq), true); v.setUint8(5, duty); }),
  system: (backlight = 255, beep = 255) => Uint8Array.of(backlight, beep),
  reboot: (target) => Uint8Array.of(target),
};

/** Actual sample rate the firmware will pick for a requested rate (mirrors scope_set_rate). */
export function actualRate(hz) {
  const psc = Math.floor(Math.floor(TIMER_HZ / 65536) / hz);
  let arr = Math.floor((Math.floor(TIMER_HZ / (psc + 1)) + hz - 1) / hz) - 1;
  arr = Math.min(Math.max(arr, 1), 65535);
  const div = (psc + 1) * (arr + 1);
  return Math.floor((TIMER_HZ + Math.floor(div / 2)) / div);
}
