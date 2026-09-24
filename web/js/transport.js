// Byte transports. Each one has open(), write(bytes), close(), and calls
// onbytes(Uint8Array) / ondisconnect(reason). SimTransport and PlaybackTransport run a
// VirtualDevice in the page, so the UI can be developed without hardware.
import * as P from './protocol.js';

export const USB_FILTER = { usbVendorId: 0x1209, usbProductId: 0x0001 };

export class SerialTransport {
  constructor(port) {
    this.port = port;
    this.label = 'USB';
    this.onbytes = null;
    this.ondisconnect = null;
    this._closing = false;
  }

  static supported() { return 'serial' in navigator; }

  /** Ports this origin was already granted (no prompt). */
  static async grantedPorts() {
    if (!SerialTransport.supported()) return [];
    const ports = await navigator.serial.getPorts();
    return ports.filter((p) => {
      const i = p.getInfo();
      return i.usbVendorId === USB_FILTER.usbVendorId && i.usbProductId === USB_FILTER.usbProductId;
    });
  }

  static async request() {
    return new SerialTransport(await navigator.serial.requestPort({ filters: [USB_FILTER] }));
  }

  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 1 << 16 });
    // The firmware only streams while DTR is set (tud_cdc_connected).
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    this.writer = this.port.writable.getWriter();
    this._loop = this._readLoop();
  }

  async _readLoop() {
    let reason = 'closed';
    try {
      while (this.port.readable && !this._closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && this.onbytes) this.onbytes(value);
          }
        } finally {
          this.reader.releaseLock();
        }
      }
    } catch (e) {
      reason = e.message || String(e);
    }
    if (!this._closing) {
      await this._release();
      this.ondisconnect?.(reason);
    }
  }

  write(bytes) { return this.writer.write(bytes); }

  async _release() {
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    try { await this.port.close(); } catch { /* already closed or lost */ }
  }

  async close() {
    this._closing = true;
    try { await this.reader?.cancel(); } catch { /* lost */ }
    await this._loop;  // the reader's lock must be released before the port can close
    await this._release();
  }
}

// ------------------------------------------------------------------ in-page devices

/** Base for in-page devices: decodes requests and answers them like the firmware. */
class VirtualTransport {
  constructor() {
    this.onbytes = null;
    this.ondisconnect = null;
    this.splitter = new P.FrameSplitter();
    this.state = {
      acqMode: 0, ch: [{ range: 4, coupling: 0, offset: 154 }, { range: 4, coupling: 0, offset: 154 }],
      rateReq: 1e6, rateActual: 1e6, trigSource: 0, trigKind: 1, trigLevel: 154, trigWidth: 0,
      autoMs: 100, genMode: 0, genFreq: 1000, genDuty: 50, backlight: 50, beep: 0, frames: 0,
    };
    this.t0 = performance.now();
  }

  async open() { this._timer = setInterval(() => this.tick(), 10); }

  async close() { clearInterval(this._timer); }

  send(type, seq, body = new Uint8Array(0)) {
    const m = P.encode(type, seq, body);
    queueMicrotask(() => this.onbytes?.(m));
  }

  ack(seq, status = 0) { this.send(P.ACK, seq, Uint8Array.of(status)); }

  async write(bytes) {
    for (const f of this.splitter.push(bytes)) {
      let m;
      try { m = P.decode(f); } catch { this.ack(0, 4); continue; }
      this.handle(m.type, m.seq, m.body);
    }
  }

  handle(type, seq, b) {
    const s = this.state, v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    switch (type) {
      case P.HELLO: this.send(P.INFO, seq, this.infoBody()); break;
      case P.PING: this.send(P.PONG, seq, b); break;
      case P.GET_STATE: this.send(P.STATE, seq, this.stateBody()); break;
      case P.GET_TABLES:
        for (const t of this.tableBodies()) this.send(P.TABLE, seq, t);
        this.ack(seq);
        break;
      case P.SET_CHANNEL: s.ch[b[0]] = { range: b[1], coupling: b[2], offset: b[3] }; this.ack(seq); break;
      case P.SET_TIMEBASE: s.rateReq = v.getUint32(0, true); s.rateActual = P.actualRate(s.rateReq); this.rollT0 = undefined; this.ack(seq); break;
      case P.SET_TRIGGER:
        Object.assign(s, { trigSource: b[0], trigKind: b[1], trigLevel: b[2], trigWidth: v.getUint16(3, true) });
        this.ack(seq);
        break;
      case P.SET_ACQ: s.acqMode = b[0]; s.autoMs = v.getUint16(1, true) || 100; this.armedAt = performance.now(); this.rollT0 = undefined; this.ack(seq); break;
      case P.SET_GEN:
        if (b[0] === P.GEN_ANALOG && !(this.wave?.length >= 2)) { this.ack(seq, 2); break; }
        Object.assign(s, { genMode: b[0], genFreq: v.getUint32(1, true), genDuty: b[5] });
        this.ack(seq);
        break;
      case P.SET_WAVE:
        if (b.length % 2 || b.length < 4 || b.length > 2 * P.WAVE_MAX) { this.ack(seq, 2); break; }
        this.wave = Array.from({ length: b.length / 2 }, (_, i) => v.getUint16(2 * i, true));
        this.ack(seq);
        break;
      case P.STORE_READ: {
        const d = this.store(), out = new Uint8Array(2 + d.length);
        out[0] = d.length & 0xFF; out[1] = d.length >> 8; out.set(d, 2);
        this.send(P.STORE_DATA, seq, out);
        break;
      }
      case P.STORE_WRITE:
        if (b.length > P.STORE_MAX) { this.ack(seq, 1); break; }
        this.store(b);
        this.ack(seq);
        break;
      case P.SET_SYSTEM:
        if (b[0] <= 100) s.backlight = b[0];
        if (b[1] <= 100) s.beep = b[1];
        this.ack(seq);
        break;
      default: this.ack(seq, 3);
    }
  }

  /** The device's flash store; the simulator keeps it in localStorage so it survives reloads. */
  store(write) {
    const key = `dsoq.sim.store.${this.fwName}`;
    if (write) this._store = write.slice();
    try {
      if (write) localStorage.setItem(key, btoa(String.fromCharCode(...write)));
      const v = localStorage.getItem(key);
      if (v != null) return Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
    } catch { /* no localStorage (node, private mode): memory only */ }
    return this._store ?? new Uint8Array(0);
  }

  infoBody() {
    const fw = new TextEncoder().encode(this.fwName + '\0');
    const b = new Uint8Array(6 + fw.length);
    const v = new DataView(b.buffer);
    v.setUint16(0, 1, true);
    v.setUint32(2, 0x51A7D5A0, true);
    b.set(fw, 6);
    return b;
  }

  stateBody() {
    const s = this.state, b = new Uint8Array(52), v = new DataView(b.buffer);
    v.setUint16(50, this.wave?.length ?? 0, true);
    v.setUint8(0, s.acqMode); v.setUint8(1, s.acqMode ? 1 : 0);
    s.ch.forEach((c, i) => { b[2 + 3 * i] = c.range; b[3 + 3 * i] = c.coupling; b[4 + 3 * i] = c.offset; });
    v.setUint32(8, s.rateReq, true); v.setUint32(12, s.rateActual, true);
    b[20] = s.trigSource; b[21] = s.trigKind; b[22] = s.trigLevel; v.setUint16(23, s.trigWidth, true);
    v.setUint16(25, s.autoMs, true);
    b[27] = s.genMode; v.setUint32(28, s.genFreq, true); b[32] = s.genDuty;
    b[33] = s.backlight; b[34] = s.beep; v.setUint32(35, s.frames, true);
    v.setUint16(39, 4100, true); b[41] = 0; v.setUint32(42, Math.floor((performance.now() - this.t0) / 1000), true);
    return b;
  }

  /** Called every 10 ms; emits frames when acquisition is running. */
  tick() {
    const s = this.state;
    if (s.acqMode !== P.ACQ_ROLL) this.rollT0 = undefined;
    if (!s.acqMode) return;
    const now = performance.now();
    if (s.acqMode === P.ACQ_ROLL) {
      if (!this.nextRoll) return;   // playback has no roll data
      for (let body; (body = this.nextRoll(now));) this.send(P.ROLL, 0, body);
      return;
    }
    if (now - (this.lastFrameAt || 0) < this.frameInterval()) return;
    const frame = this.nextFrame(now);
    if (!frame) return;
    this.lastFrameAt = now;
    this.send(P.FRAME, s.frames & 0xFF, frame);
    s.frames++;
    if (s.acqMode === P.ACQ_SINGLE) s.acqMode = P.ACQ_STOP;
    this.armedAt = now;
  }

  frameInterval() { return Math.max(46, 4096 / this.state.rateActual * 1000); }  // ~21.8 fps like the real thing

  /** Builds a FRAME body from sample arrays. */
  frameBody(flags, a, b, cd, pretrigger = 150) {
    const s = this.state, n = a.length, out = new Uint8Array(22 + 3 * n), v = new DataView(out.buffer);
    v.setUint32(0, s.frames, true); out[4] = flags | (s.acqMode === P.ACQ_SINGLE ? 4 : 0);
    v.setUint32(5, s.rateActual, true);
    s.ch.forEach((c, i) => { out[9 + 3 * i] = c.range; out[10 + 3 * i] = c.coupling; out[11 + 3 * i] = c.offset; });
    out[15] = s.trigSource; out[16] = s.trigKind; out[17] = s.trigLevel;
    v.setUint16(18, pretrigger, true); v.setUint16(20, n, true);
    for (let i = 0, o = 22; i < n; i++, o += 3) { out[o] = a[i]; out[o + 1] = b[i]; out[o + 2] = cd[i]; }
    return out;
  }
}

/** Real table bodies captured from the target unit (SYS 1.52), so the simulator matches it. */
const RANGE_V = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
const SIM_DAC_VFS = 2.5;   // simulated wave-out span (the real unit: ~2.7 V, see wavegen.js)
function simTables() {
  const g = new Uint8Array(3 + 28);
  g.set([0, 28, 1]);
  const gv = new DataView(g.buffer, 3);
  [400, 240, 7, 21, 15, 200, 4096, 1].forEach((x, i) => gv.setUint16(2 * i, x, true));
  const y = new Uint8Array(3 + 20 * 8);
  y.set([1, 20, 8]);
  RANGE_V.forEach((vd, i) => {
    const r = y.subarray(3 + 20 * i, 23 + 20 * i), rv = new DataView(r.buffer, r.byteOffset, 20);
    r.set(new TextEncoder().encode(vd < 0.1 ? `${vd * 1000}mV` : `${vd}V`));
    rv.setUint16(10, 1024, true); rv.setUint16(14, 1024, true); rv.setUint32(16, vd * 40000, true);
  });
  return [g, y, Uint8Array.of(2, 20, 0), Uint8Array.of(3, 10, 0)];
}

/** Synthesises signals: CH A is wired to the generator output (square wave when it's on,
 * otherwise a 1 kHz sine), CH B a 2.7 kHz 1.5 V sine plus a harmonic, C/D counters. */
export class SimTransport extends VirtualTransport {
  constructor() {
    super();
    this.label = 'Simulator';
    this.fwName = 'simulator';
    this.simulated = true;
    this.inputsOpen = false;   // true: nothing connected to CH A/B (0 V), as for zero calibration
  }

  tableBodies() { return simTables(); }

  voltsA(t) {
    const s = this.state;
    if (this.inputsOpen) return 0;
    if (s.genMode === P.GEN_ANALOG) {
      const w = this.wave, p = (t * s.genFreq) % 1;
      return w[Math.floor(p * w.length)] / 4095 * SIM_DAC_VFS;
    }
    if (s.genMode) {
      const p = (t * s.genFreq) % 1;
      return p < s.genDuty / 100 ? 3.0 : 0.0;
    }
    return 1.2 * Math.sin(2 * Math.PI * 1000 * t);
  }

  voltsB(t) {
    if (this.inputsOpen) return 0;
    return 1.5 * Math.sin(2 * Math.PI * 2700 * t) + 0.3 * Math.sin(2 * Math.PI * 8100 * t);
  }

  code(ch, volts) {
    const c = this.state.ch[ch];
    const vdiv = RANGE_V[c.range] ?? 1;
    const noise = (Math.random() - 0.5) * 1.6;
    const ac = c.coupling ? (ch === 0 && this.state.genMode ? -1.5 : 0) : 0;  // crude AC: remove the square's mean
    // Front-end errors of the size the real unit has, so calibration has something to fix.
    const zero = (ch ? 14 - c.range * 0.5 : 9 + c.range * 0.4) + (ch ? 0.985 : 1.012) * c.offset;
    const gain = ch ? 1.03 - c.range * 0.004 : 0.975 + c.range * 0.003;
    return Math.min(255, Math.max(0, Math.round(zero + (volts + ac) / vdiv * P.CODES_PER_DIV * gain + noise)));
  }

  sampleAt(t) {
    const k = Math.floor(t * 50000);
    return [this.code(0, this.voltsA(t)), this.code(1, this.voltsB(t)), (k & 1) | ((k >> 2) & 1) << 1];
  }

  /** Roll mode: the samples due since the last chunk, from a continuous clock. */
  nextRoll(now) {
    const s = this.state;
    if (this.rollT0 === undefined) { this.rollT0 = now; this.rollIndex = 0; }
    const due = Math.floor((now - this.rollT0) / 1000 * s.rateActual) - this.rollIndex;
    if (due <= 0) return null;
    const n = Math.min(due, 256), a = new Uint8Array(n), b = new Uint8Array(n), cd = new Uint8Array(n);
    for (let i = 0; i < n; i++) [a[i], b[i], cd[i]] = this.sampleAt((this.rollIndex + i) / s.rateActual);
    const body = this.frameBody(8, a, b, cd, 0);
    new DataView(body.buffer).setUint32(0, this.rollIndex, true);
    this.rollIndex += n;
    return body;
  }

  nextFrame(now) {
    if (this.state.rateActual > P.MAX_RATE) return this.nextInterleaved(now);
    const s = this.state, n = 4096, pre = 150, rate = s.rateActual;
    // Build a longer buffer at a random phase, then find a trigger event to align on.
    const extra = Math.min(40000, Math.ceil(rate / 50) + 2);
    const t0 = Math.random() * 10;
    const total = n + extra;
    const src = s.trigSource;
    const raw = [new Uint8Array(total), new Uint8Array(total), new Uint8Array(total)];
    for (let i = 0; i < total; i++) [raw[0][i], raw[1][i], raw[2][i]] = this.sampleAt(t0 + i / rate);
    let at = -1;
    if (src < 2) {
      const x = raw[src], L = s.trigLevel;
      for (let i = pre + 1; i < pre + extra; i++) {
        const k = s.trigKind;
        const hit = k === 0 ? x[i - 1] >= L && x[i] < L
          : k === 1 ? x[i - 1] < L && x[i] >= L
            : k === 2 ? x[i] < L
              : k === 3 ? x[i] >= L : x[i - 1] < L && x[i] >= L;
        if (hit) { at = i; break; }
      }
    } else {
      const bit = src - 2, x = raw[2];
      for (let i = pre + 1; i < pre + extra; i++) {
        const a = x[i - 1] >> bit & 1, b = x[i] >> bit & 1;
        if (s.trigKind === 1 ? !a && b : a && !b) { at = i; break; }
      }
    }
    let flags = 1;
    if (at < 0) {
      if (s.acqMode !== P.ACQ_AUTO || now - (this.armedAt || 0) < s.autoMs) return null;
      at = pre;
      flags = 2;
    }
    const sl = (x) => x.slice(at - pre, at - pre + n);
    return this.frameBody(flags, sl(raw[0]), sl(raw[1]), sl(raw[2]), pre);
  }
}

/** 72 MS/s: both ADCs on channel A, alternate samples in the two bytes of each word (ADC B
 * with its own zero error), triggered on channel A's rising edge. */
SimTransport.prototype.nextInterleaved = function nextInterleaved() {
  const s = this.state, n = 4096, pre = 150, rate = s.rateActual;
  const t0 = Math.random() * 10, total = 2 * n + 4000;
  const x = new Uint8Array(total);
  for (let i = 0; i < total; i++) x[i] = this.code(0, this.voltsA(t0 + i / rate));
  let at = -1;
  for (let i = 2 * pre + 1; i < total - 2 * n; i++) if (x[i - 1] < s.trigLevel && x[i] >= s.trigLevel) { at = i & ~1; break; }
  let flags = 1 | P.FRAME_INTERLEAVED;
  if (at < 0) { at = 2 * pre; flags = 2 | P.FRAME_INTERLEAVED; }
  const a = new Uint8Array(n), b = new Uint8Array(n), cd = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = at - 2 * pre + 2 * i;
    const [first, second] = P.IL_B_FIRST ? [b, a] : [a, b];
    first[i] = x[j]; second[i] = x[j + 1];
    b[i] = Math.min(255, b[i] + 3);   // ADC B reads 3 codes high
  }
  return this.frameBody(flags, a, b, cd, pre);
};

/** Replays a recording made with `python3 tools/dsoq record`. Settings are accepted but the
 * frames are what was recorded (each carries the settings it was captured with). */
export class PlaybackTransport extends VirtualTransport {
  constructor(bytes, name) {
    super();
    this.label = `Playback: ${name}`;
    const msgs = new P.FrameSplitter(1 << 17).push(bytes).map((f) => { try { return P.decode(f); } catch { return null; } }).filter(Boolean);
    this.tables = msgs.filter((m) => m.type === P.TABLE).map((m) => m.body);
    this.frames = msgs.filter((m) => m.type === P.FRAME).map((m) => m.body);
    const info = msgs.find((m) => m.type === P.INFO);
    this.fwName = `playback of ${info ? P.parseInfo(info.body).fw : 'unknown'}`;
    const st = msgs.find((m) => m.type === P.STATE);
    if (st) {
      const s = P.parseState(st.body);
      Object.assign(this.state, { ch: s.ch, rateReq: s.rateReq, rateActual: s.rateActual,
        trigSource: s.trigSource, trigKind: s.trigKind, trigLevel: s.trigLevel });
    }
    if (!this.frames.length) throw new Error('no frames in recording');
    this.next = 0;
  }

  tableBodies() { return this.tables.length ? this.tables : simTables(); }

  frameInterval() { return 46; }

  nextFrame() {
    const b = this.frames[this.next++ % this.frames.length].slice();
    new DataView(b.buffer).setUint32(0, this.state.frames, true);
    if (this.state.acqMode === P.ACQ_SINGLE) b[4] |= 4;
    return b;
  }
}
