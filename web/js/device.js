// Protocol client on top of a transport: matches replies to requests by seq, delivers frames.
import * as P from './protocol.js';

export class DeviceError extends Error {}

export class Device extends EventTarget {
  constructor(transport) {
    super();
    this.t = transport;
    this.splitter = new P.FrameSplitter();
    this.seq = 0;
    this.pending = new Map();   // seq -> {resolve, reject, msgs, timer}
    this.badFrames = 0;
    this.latest = new Map();    // coalescing key -> {type, body, waiters}
    this.inflight = new Set();
    this.connected = false;
  }

  async open() {
    this.t.onbytes = (b) => this._onBytes(b);
    this.t.ondisconnect = (reason) => this._lost(reason);
    await this.t.open();
    this.connected = true;
  }

  async close() {
    this.connected = false;
    await this.t.close();
    this._failAll('closed');
  }

  _lost(reason) {
    if (!this.connected) return;
    this.connected = false;
    this._failAll(reason);
    this.dispatchEvent(new CustomEvent('disconnect', { detail: reason }));
  }

  _failAll(reason) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new DeviceError(reason)); }
    this.pending.clear();
  }

  _onBytes(chunk) {
    for (const f of this.splitter.push(chunk)) {
      let m;
      try { m = P.decode(f); } catch { this.badFrames++; continue; }
      if (m.type === P.FRAME || m.type === P.ROLL) {
        let frame;
        try { frame = P.parseFrame(m.body); } catch { this.badFrames++; continue; }
        this.dispatchEvent(new CustomEvent(m.type === P.ROLL ? 'roll' : 'frame', { detail: frame }));
      } else if (m.type === P.LOG) {
        console.info('device:', new TextDecoder().decode(m.body));
      } else {
        const p = this.pending.get(m.seq);
        if (!p) continue;
        p.msgs.push(m);
        if (m.type !== P.TABLE) {  // TABLEs precede the final ACK
          clearTimeout(p.timer);
          this.pending.delete(m.seq);
          p.resolve(p.msgs);
        }
      }
    }
  }

  request(type, body = new Uint8Array(0), timeout = 2000) {
    if (!this.connected) return Promise.reject(new DeviceError('not connected'));
    do { this.seq = (this.seq % 255) + 1; } while (this.pending.has(this.seq));
    const seq = this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new DeviceError(`timeout waiting for reply to 0x${type.toString(16)}`));
      }, timeout);
      this.pending.set(seq, { resolve, reject, msgs: [], timer });
      this.t.write(P.encode(type, seq, body)).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(e);
      });
    });
  }

  async command(type, body, timeout) {
    const msgs = await this.request(type, body, timeout);
    const last = msgs[msgs.length - 1];
    if (last.type !== P.ACK) throw new DeviceError(`expected ACK, got 0x${last.type.toString(16)}`);
    if (last.body[0]) throw new DeviceError(P.ACK_NAMES[last.body[0]] ?? `status ${last.body[0]}`);
    return msgs.slice(0, -1);
  }

  /** Like command(), but while one with the same key is in flight only the newest waiting
   * request is kept. Dragging a slider sends at most one command per round trip. */
  coalesce(key, type, body) {
    return new Promise((resolve, reject) => {
      const prev = this.latest.get(key);
      const waiters = prev ? prev.waiters : [];
      waiters.push({ resolve, reject });
      this.latest.set(key, { type, body, waiters });
      if (!this.inflight.has(key)) this._drain(key);
    });
  }

  /** coalesce() for a sequence of commands: `fn` runs with the device and is awaited. */
  coalesceTask(key, fn) { return this.coalesce(key, null, fn); }

  async _drain(key) {
    this.inflight.add(key);
    while (this.latest.has(key)) {
      const { type, body, waiters } = this.latest.get(key);
      this.latest.delete(key);
      try {
        if (type === null) await body(this); else await this.command(type, body);
        waiters.forEach((w) => w.resolve());
      } catch (e) {
        waiters.forEach((w) => w.reject(e));
      }
    }
    this.inflight.delete(key);
  }

  // ------------------------------------------------------------------ API

  async hello() {
    const [m] = await this.request(P.HELLO);
    if (m.type !== P.INFO) throw new DeviceError('bad HELLO reply');
    return P.parseInfo(m.body);
  }

  async state() {
    const [m] = await this.request(P.GET_STATE);
    if (m.type !== P.STATE) throw new DeviceError('bad GET_STATE reply');
    return P.parseState(m.body);
  }

  async tables() {
    const out = {};
    for (const m of await this.command(P.GET_TABLES)) {
      if (m.type === P.TABLE) { const t = P.parseTable(m.body); out[t.id] = t.value; }
    }
    return out;
  }

  async storeRead() {
    const [m] = await this.request(P.STORE_READ);
    if (m.type !== P.STORE_DATA) throw new DeviceError('bad STORE_READ reply');
    const n = m.body[0] | m.body[1] << 8;
    return m.body.slice(2, 2 + n);
  }

  async storeWrite(blob) { await this.command(P.STORE_WRITE, blob); }

  /** Install an APP1 image over USB (firmware >= 0.6): stage, verify, commit. The device
   * resets into the new firmware right after the final ACK, so a disconnect follows. */
  async fwUpdate(image, progress = () => {}) {
    const crc = P.crc32(image);
    await this.command(P.SET_ACQ, P.body.acq(P.ACQ_STOP, 100));
    progress(0, 'erasing');
    await this.command(P.FW_BEGIN, P.body.fwRange(image.length, crc), 10000);
    for (let off = 0; off < image.length; off += P.FW_CHUNK) {
      await this.command(P.FW_DATA, P.body.fwData(off, image.subarray(off, off + P.FW_CHUNK)), 5000);
      progress(Math.min(off + P.FW_CHUNK, image.length) / image.length, 'writing');
    }
    await this.command(P.FW_COMMIT, P.body.fwRange(image.length, crc), 5000);
  }

  setChannel(ch, range, coupling, offset) {
    return this.coalesce(`ch${ch}`, P.SET_CHANNEL, P.body.channel(ch, range, coupling, offset));
  }

  setRate(hz) { return this.coalesce('rate', P.SET_TIMEBASE, P.body.timebase(hz)); }

  setTrigger(source, kind, level, width) {
    return this.coalesce('trig', P.SET_TRIGGER, P.body.trigger(source, kind, level, width));
  }

  setAcq(mode, autoMs) { return this.coalesce('acq', P.SET_ACQ, P.body.acq(mode, autoMs)); }

  setGen(mode, freq, duty) { return this.coalesce('gen', P.SET_GEN, P.body.gen(mode, freq, duty)); }

  /** Analog output: uploads the DAC table, then starts it (one coalesced step, so the table
   * always arrives before the SET_GEN that uses it). */
  setGenWave(codes, freq) {
    return this.coalesceTask('gen', async (d) => {
      await d.command(P.SET_WAVE, P.body.wave(codes));
      await d.command(P.SET_GEN, P.body.gen(P.GEN_ANALOG, freq, 50));
    });
  }

  setSystem(backlight, beep) { return this.coalesce('sys', P.SET_SYSTEM, P.body.system(backlight, beep)); }
}
