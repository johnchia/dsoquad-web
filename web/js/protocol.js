// Codec for the DSO Quad control protocol (docs/protocol.md). No DOM use: also runs under node.

// Host -> device
export const HELLO = 0x01, PING = 0x02, GET_STATE = 0x03;
export const SET_CHANNEL = 0x10, SET_TIMEBASE = 0x11, SET_TRIGGER = 0x12, SET_ACQ = 0x13,
  SET_GEN = 0x14, SET_SYSTEM = 0x15, SET_WAVE = 0x16;
export const GET_TABLES = 0x20, STORE_READ = 0x21, STORE_WRITE = 0x22;
export const FW_BEGIN = 0x23, FW_DATA = 0x24, FW_COMMIT = 0x25;
export const REG_SET = 0x30, REG_GET = 0x31, PARAM_SET = 0x32, PEEK = 0x33, POKE = 0x34, REBOOT = 0x3F;
// Device -> host
export const INFO = 0x81, PONG = 0x82, STATE = 0x83, FRAME = 0x84, TABLE = 0x85, STORE_DATA = 0x86, ROLL = 0x87, LOG = 0x8E,
  ACK = 0xA0, REG_VALUE = 0xB1, MEM_DATA = 0xB3;

export const ACK_NAMES = ['OK', 'BAD_LENGTH', 'BAD_VALUE', 'UNKNOWN_TYPE', 'BAD_FRAME', 'BUSY', 'FLASH_ERROR'];
export const STORE_MAX = 1024;
export const ACQ_STOP = 0, ACQ_NORMAL = 1, ACQ_AUTO = 2, ACQ_SINGLE = 3, ACQ_ROLL = 4;
export const TRIG_KINDS = ['falling', 'rising', 'low', 'high', 'low<w', 'low>w', 'high<w', 'high>w'];

export const ADC_ZERO = 54;       // SYS convention: code 54 = screen bottom
export const CODES_PER_DIV = 25;
export const TIMER_HZ = 72e6;
export const MAX_RATE = 36e6;         // per ADC; interleaved (channel A only) doubles it
export const IL_RATE = 72e6;
export const FRAME_INTERLEAVED = 0x20;
// Interleaved frames: ADC B's sample of each word comes first in time (measured on HW 2.6 with
// FPGA 2.61: B falls between the previous word's A and this word's A).
export const IL_B_FIRST = true;
export const GEN_OFF = 0, GEN_SQUARE = 1, GEN_ANALOG = 2;
export const WAVE_MAX = 512, DAC_MAX_RATE = 2e6;     // separate-channel mode (interleave is M4)
export const APP_BASE = 0x0800C000, APP_LIMIT = 0x0801C000;  // APP1, up to the APP3 fallback
export const FW_CHUNK = 1024;
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
    batteryMv: null, charging: null, uptimeS: null, genPsc: null, genArr: null, waveLen: null,
  };
  if (b.length >= 46) {  // appended in firmware 0.3.0
    s.batteryMv = v.getUint16(39, true);
    s.charging = v.getUint8(41);
    s.uptimeS = v.getUint32(42, true);
  }
  if (b.length >= 52) {  // firmware 0.5.0
    s.genPsc = v.getUint16(46, true);
    s.genArr = v.getUint16(48, true);
    s.waveLen = v.getUint16(50, true);
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
  const f = {
    frameNo: v.getUint32(0, true), flags,
    triggered: !!(flags & 1), auto: !!(flags & 2), last: !!(flags & 4), roll: !!(flags & 8), gap: !!(flags & 16),
    interleaved: false,
    rate: v.getUint32(5, true), ch: readChannels(v, 9),
    trigSource: v.getUint8(15), trigKind: v.getUint8(16), trigLevel: v.getUint8(17),
    pretrigger: v.getUint16(18, true), count, stale: STALE_SAMPLES, a, b: bb, cd,
  };
  return flags & FRAME_INTERLEAVED ? deinterleave(f) : f;
}

/** Interleaved frame: each word holds two samples of channel A, one per ADC, half a clock
 * apart. Merges them into one channel A at the combined rate. The two ADCs have their own zero
 * error; ADC B is shifted by the difference of the means (both sample the same signal). */
function deinterleave(f) {
  const n = f.count, s = f.stale;
  let sa = 0, sb = 0;
  for (let i = s; i < n; i++) { sa += f.a[i]; sb += f.b[i]; }
  const d = n > s ? (sa - sb) / (n - s) : 0;
  const a = new Float32Array(2 * n), cd = new Uint8Array(2 * n);
  const [first, second] = IL_B_FIRST ? [f.b, f.a] : [f.a, f.b];
  const [d1, d2] = IL_B_FIRST ? [d, 0] : [0, d];
  for (let i = 0; i < n; i++) {
    a[2 * i] = first[i] + d1; a[2 * i + 1] = second[i] + d2;
    cd[2 * i] = cd[2 * i + 1] = f.cd[i];
  }
  return { ...f, interleaved: true, ilBalance: d, count: 2 * n, pretrigger: 2 * f.pretrigger, stale: 2 * s, a, b: null, cd };
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
  fwRange: (size, crc) => { const b = new Uint8Array(8), v = le(b); v.setUint32(0, size, true); v.setUint32(4, crc, true); return b; },
  fwData: (offset, data) => { const b = new Uint8Array(4 + data.length); le(b).setUint32(0, offset, true); b.set(data, 4); return b; },
  channel: (ch, range, coupling, offset) => Uint8Array.of(ch, range, coupling, offset),
  timebase: (hz) => pack(4, (v) => v.setUint32(0, Math.round(hz), true)),
  trigger: (source, kind, level, width = 0) => pack(5, (v) => {
    v.setUint8(0, source); v.setUint8(1, kind); v.setUint8(2, level); v.setUint16(3, width, true);
  }),
  acq: (mode, autoMs = 100) => pack(3, (v) => { v.setUint8(0, mode); v.setUint16(1, autoMs, true); }),
  gen: (mode, freq, duty) => pack(6, (v) => { v.setUint8(0, mode); v.setUint32(1, Math.round(freq), true); v.setUint8(5, duty); }),
  system: (backlight = 255, beep = 255) => Uint8Array.of(backlight, beep),
  wave: (codes) => pack(2 * codes.length, (v) => codes.forEach((c, i) => v.setUint16(2 * i, c, true))),
  reboot: (target) => Uint8Array.of(target),
};

/** Actual sample rate the firmware will pick for a requested rate (mirrors scope_set_rate). */
export function actualRate(hz) {
  if (hz > MAX_RATE) return IL_RATE;
  const psc = Math.floor(Math.floor(TIMER_HZ / 65536) / hz);
  let arr = Math.floor((Math.floor(TIMER_HZ / (psc + 1)) + hz - 1) / hz) - 1;
  arr = Math.min(Math.max(arr, 1), 65535);
  const div = (psc + 1) * (arr + 1);
  return Math.floor((TIMER_HZ + Math.floor(div / 2)) / div);
}

// ------------------------------------------------------------------ persistent store records

/** Store blob -> Map(tag -> Uint8Array). */
export function parseStore(blob) {
  const out = new Map();
  for (let i = 0; i + 3 <= blob.length;) {
    const n = blob[i + 1] | blob[i + 2] << 8;
    out.set(blob[i], blob.slice(i + 3, i + 3 + n));
    i += 3 + n;
  }
  return out;
}

/** Map(tag -> Uint8Array) -> store blob. */
export function buildStore(records) {
  const n = [...records.values()].reduce((k, r) => k + 3 + r.length, 0);
  const out = new Uint8Array(n);
  let i = 0;
  for (const [tag, r] of records) {
    out[i] = tag; out[i + 1] = r.length & 0xFF; out[i + 2] = r.length >> 8;
    out.set(r, i + 3);
    i += 3 + r.length;
  }
  return out;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE, as zlib): the firmware image checksum. */
export function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ CRC32_TABLE[(c ^ data[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Intel HEX text -> APP1 image from APP_BASE (gaps 0xFF, even length). Throws on anything
 * that isn't an APP1 image. */
export function hexToImage(text) {
  let base = 0, lo = Infinity, hi = 0;
  const recs = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(':')) continue;
    const r = new Uint8Array(line.length / 2 | 0);
    for (let i = 0; i < r.length; i++) r[i] = parseInt(line.substr(1 + 2 * i, 2), 16);
    if (r.reduce((a, b) => a + b, 0) & 0xFF || r.length < 5 || r.length !== r[0] + 5) throw new Error(`bad hex record: ${line}`);
    const n = r[0], addr = r[1] << 8 | r[2], type = r[3], data = r.subarray(4, 4 + n);
    if (type === 0) {
      recs.push([base + addr, data]);
      lo = Math.min(lo, base + addr); hi = Math.max(hi, base + addr + n);
    } else if (type === 1) break;
    else if (type === 2) base = (data[0] << 8 | data[1]) << 4;
    else if (type === 4) base = (data[0] << 8 | data[1]) * 65536;
  }
  if (!recs.length) throw new Error('empty hex file');
  const hx = (a) => `0x${a.toString(16).toUpperCase().padStart(8, '0')}`;
  if (lo !== APP_BASE || hi > APP_LIMIT) throw new Error(`not an APP1 image: ${hx(lo)}-${hx(hi - 1)} (APP1 is ${hx(APP_BASE)}-${hx(APP_LIMIT - 1)})`);
  const img = new Uint8Array((hi - lo + 1) & ~1).fill(0xFF);
  for (const [a, d] of recs) img.set(d, a - lo);
  return img;
}

/** The firmware version string embedded in an image ("0.6.0+<git>-<mmddHHMM>"), or null. */
export function imageVersion(img) {
  const s = new TextDecoder('latin1').decode(img);
  const m = s.match(/\d+\.\d+\.\d+[\w.-]*\+[0-9a-f]{7,}(?:-dirty)?-\d{8}/);
  return m ? m[0] : null;
}
