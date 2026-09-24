// Vertical calibration. Stored on the device (record tag 1 of the flash store, see
// docs/protocol.md), so it follows the DSO to any computer; the firmware only deals in raw codes.
//
// Model, per channel and range:
//   zero code (0 V input)   = a + b * offsetReg      (offset DAC scale and zero error; the
//                                                     Community Edition's K3 and K1)
//   code for input V        = zero + V / Vdiv * 25 * gain   (gain: its K2, as a ratio)
// Uncalibrated: a = 0, b = 1, gain = 1 (the SYS convention the firmware and M3 assumed).
import * as P from './protocol.js';

export const RANGES = 8;
export const TAG = 1;
const REC_LEN = 4 + 2 * RANGES * 13;

export function nominal() {
  const ch = () => Array.from({ length: RANGES }, () => ({ a: 0, b: 1, gain: 1, zeroCal: false, gainCal: false }));
  return { created: null, ch: [ch(), ch()] };
}

export function encode(cal) {
  const out = new Uint8Array(REC_LEN), v = new DataView(out.buffer);
  v.setUint32(0, Math.floor((cal.created ? Date.parse(cal.created) : Date.now()) / 1000), true);
  cal.ch.flat().forEach((e, k) => {
    const o = 4 + 13 * k;
    v.setFloat32(o, e.a, true); v.setFloat32(o + 4, e.b, true); v.setFloat32(o + 8, e.gain, true);
    v.setUint8(o + 12, (e.zeroCal ? 1 : 0) | (e.gainCal ? 2 : 0));
  });
  return out;
}

export function decode(rec) {
  if (rec.length < REC_LEN) throw new Error('short calibration record');
  const v = new DataView(rec.buffer, rec.byteOffset, rec.byteLength), cal = nominal();
  cal.created = new Date(v.getUint32(0, true) * 1000).toISOString();
  for (let k = 0; k < 2 * RANGES; k++) {
    const o = 4 + 13 * k, f = v.getUint8(o + 12);
    const e = { a: v.getFloat32(o, true), b: v.getFloat32(o + 4, true), gain: v.getFloat32(o + 8, true), zeroCal: !!(f & 1), gainCal: !!(f & 2) };
    // Reject nonsense rather than draw garbage (a torn or foreign record).
    if (!(Math.abs(e.a) < 200 && e.b > 0.5 && e.b < 2 && e.gain > 0.5 && e.gain < 2)) throw new Error('implausible calibration record');
    cal.ch[k >> 3][k & 7] = e;
  }
  return cal;
}

/** Calibration stored on the device, or nominal() if there's none. */
export async function loadFrom(dev) {
  const rec = P.parseStore(await dev.storeRead()).get(TAG);
  return rec ? decode(rec) : nominal();
}

/** Writes the calibration record, keeping any other records in the store. */
export async function saveTo(dev, cal) {
  const recs = P.parseStore(await dev.storeRead());
  if (cal) recs.set(TAG, encode(cal)); else recs.delete(TAG);
  await dev.storeWrite(P.buildStore(recs));
}

const entry = (cal, ch, range) => cal.ch[ch][range] ?? { a: 0, b: 1, gain: 1 };

/** Code that 0 V reads as, for a channel at `range` with offset register `offsetReg`. */
export function zeroCode(cal, ch, range, offsetReg) {
  const e = entry(cal, ch, range);
  return e.a + e.b * offsetReg;
}

/** Codes per division (25 when uncalibrated). */
export function codesPerDiv(cal, ch, range) {
  return P.CODES_PER_DIV * entry(cal, ch, range).gain;
}

/** Offset register that puts 0 V at `targetCode`, clamped to what the register holds. */
export function offsetFor(cal, ch, range, targetCode) {
  const e = entry(cal, ch, range);
  return Math.round(Math.min(255, Math.max(0, (targetCode - e.a) / e.b)));
}

/** The status shown in the UI: 'none', 'zero' (offsets only) or 'full'. */
export function status(cal) {
  const all = cal.ch.flat();
  if (all.every((e) => e.zeroCal && e.gainCal)) return 'full';
  if (all.some((e) => e.zeroCal)) return all.some((e) => e.gainCal) ? 'partial' : 'zero';
  return 'none';
}

// ------------------------------------------------------------------ measurement procedures

/** Mean code of each channel over `n` frames captured with the given channel settings,
 * after skipping `skip` of them so the front end settles. */
export function collect(dev, expect, { n = 3, skip = 2, timeout = 4000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const sums = [0, 0], sq = [0, 0], counts = [0, 0];
    const mins = [255, 255], maxs = [0, 0];
    const done = (err, v) => {
      dev.removeEventListener('frame', onFrame);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(v);
    };
    const onAbort = () => done(new DOMException('cancelled', 'AbortError'));
    const onFrame = (e) => {
      const f = e.detail;
      const ok = expect.every((c, i) => !c || (f.ch[i].range === c.range && f.ch[i].offset === c.offset && f.ch[i].coupling === c.coupling));
      if (!ok || ++seen <= skip) return;
      [f.a, f.b].forEach((codes, i) => {
        for (let k = P.STALE_SAMPLES; k < codes.length; k++) {
          const c = codes[k];
          sums[i] += c; sq[i] += c * c; counts[i]++;
          if (c < mins[i]) mins[i] = c;
          if (c > maxs[i]) maxs[i] = c;
        }
      });
      if (seen - skip >= n) {
        done(null, [0, 1].map((i) => {
          const mean = sums[i] / counts[i];
          return { mean, sd: Math.sqrt(Math.max(0, sq[i] / counts[i] - mean * mean)), min: mins[i], max: maxs[i] };
        }));
      }
    };
    const timer = setTimeout(() => done(new Error('no frames from the device (timeout)')), timeout);
    signal?.addEventListener('abort', onAbort);
    dev.addEventListener('frame', onFrame);
  });
}

/** Puts the device into free-running capture for calibration: 1 MS/s, auto mode. */
export async function freeRun(dev) {
  await dev.setRate(1e6);
  // "High level, threshold 0" fires at once (measured: ~50 ms per frame instead of the
  // 100 ms auto timeout).
  await dev.setTrigger(0, 3, 0, 0);
  await dev.setAcq(P.ACQ_AUTO, 100);
}

/** Least-squares line through points [x, y]: returns {a, b, resid} (max |residual|). */
export function fitLine(pts) {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  return { a, b, resid: Math.max(...pts.map(([x, y]) => Math.abs(y - (a + b * x)))) };
}

export const ZERO_OFFSETS = [79, 154, 229];   // offset registers used for the zero fit (1, 4, 7 div)

/** Zero calibration: inputs open (or grounded), DC coupling. Both channels at once. */
export async function runZero(dev, cal, { onProgress, signal } = {}) {
  const out = structuredClone(cal);
  const report = [];
  await freeRun(dev);
  const steps = RANGES * ZERO_OFFSETS.length;
  let step = 0;
  for (let r = 0; r < RANGES; r++) {
    const pts = [[], []];
    for (const off of ZERO_OFFSETS) {
      onProgress?.(step++ / steps, `Range ${r + 1}/${RANGES}, offset ${off}`);
      const expect = [0, 1].map(() => ({ range: r, coupling: 0, offset: off }));
      await dev.setChannel(0, r, 0, off);
      await dev.setChannel(1, r, 0, off);
      const m = await collect(dev, expect, { signal });
      m.forEach((v, i) => pts[i].push([off, v.mean, v.sd]));
    }
    for (let i = 0; i < 2; i++) {
      const fit = fitLine(pts[i].map(([x, y]) => [x, y]));
      const noise = Math.max(...pts[i].map((p) => p[2]));
      Object.assign(out.ch[i][r], { a: fit.a, b: fit.b, zeroCal: true });
      report.push({ ch: i, range: r, a: fit.a, b: fit.b, resid: fit.resid, noise, points: pts[i].map((p) => p.slice(0, 2)) });
    }
  }
  onProgress?.(1, 'Done');
  out.created = new Date().toISOString();
  return { cal: out, report };
}

/** Gain calibration for one channel against a known DC voltage `volts` on its input.
 * Calibrates every range on which the voltage lands between 1.5 and 7.6 divisions. */
export async function runGain(dev, cal, ch, volts, rangeVolts, { onProgress, signal } = {}) {
  const out = structuredClone(cal);
  const report = [];
  await freeRun(dev);
  const usable = rangeVolts.map((vd, r) => ({ r, div: Math.abs(volts) / vd })).filter((x) => x.div >= 1.5 && x.div <= 7.6);
  if (!usable.length) throw new Error(`${volts} V doesn't give 1.5–7.6 divisions on any range`);
  let step = 0;
  for (const { r } of usable) {
    onProgress?.(step++ / usable.length, `Range ${rangeVolts[r]} V/div`);
    // 0 V near the bottom for positive references, near the top for negative ones.
    const target = P.ADC_ZERO + (volts >= 0 ? 0.2 : 7.8) * P.CODES_PER_DIV;
    const off = offsetFor(out, ch, r, target);
    await dev.setChannel(ch, r, 0, off);
    const expect = [null, null];
    expect[ch] = { range: r, coupling: 0, offset: off };
    const m = (await collect(dev, expect, { signal }))[ch];
    const zero = zeroCode(out, ch, r, off);
    const gain = (m.mean - zero) / (volts / rangeVolts[r] * P.CODES_PER_DIV);
    const clipped = m.max >= 255 || m.min <= 0;
    report.push({ ch, range: r, zero, mean: m.mean, sd: m.sd, gain, clipped, used: !clipped && gain > 0.8 && gain < 1.25 });
    if (report.at(-1).used) Object.assign(out.ch[ch][r], { gain, gainCal: true, gainRef: volts });
  }
  onProgress?.(1, 'Done');
  return { cal: out, report };
}
