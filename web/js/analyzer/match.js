// Channel match: B/A with both probes on the same signal (the wave out), per frequency. Every
// later B/A is divided by it, which removes the two channels' gain and delay difference. Stored
// on the DSO as record tag 2 of the flash store, beside calibration (tag 1):
//   u8 version (2), u8 count, u32 unix time, u8 coupling, u8 A range, u8 B range (of the
//   frequency sweep), u8 nr, nr × i16 A gain, nr × i16 B gain (1e-4 dB, per range, relative to
//   A on its sweep range; 0x7FFF: not measured), count × {f32 Hz, i16 gain (1e-4 dB), i16 phase (1e-3°)}
// The range gains let a point measured with the channels on other ranges (B finer than A, as
// in impedance sweeps) be corrected too, without gain calibration.
import * as P from '../protocol.js';
import { cabs, carg, cdiv, cx, polar } from './detect.js';

export const TAG = 2;
export const MAX_POINTS = 64;
export const FROM_HZ = 10, TO_HZ = 125000, PER_DECADE = 5;   // the loopback sweep
const LIMIT_DB = 3.2, LIMIT_DEG = 32;                        // what the record's i16s hold

const NONE = 0x7FFF;

/** From loopback sweep points [{f, h, a: {range}, b: {range}}] and range gains ({ga, gb} in dB,
 * or null): {created, coupling, rA, rB, ga, gb, pts: [{f, db, deg}]}. */
export function fromSweep(points, gains = null, coupling = 0, created = new Date().toISOString()) {
  const pts = points.map((p) => ({ f: p.f, db: 20 * Math.log10(cabs(p.h)), deg: carg(p.h) * 180 / Math.PI }));
  const bad = pts.find((p) => !(Math.abs(p.db) < LIMIT_DB && Math.abs(p.deg) < LIMIT_DEG));
  if (bad) throw new Error(`A and B differ by ${bad.db.toFixed(2)} dB, ${bad.deg.toFixed(1)}° at ${Math.round(bad.f)} Hz: are both probes on the wave out?`);
  if (pts.length > MAX_POINTS) throw new Error(`${pts.length} points: at most ${MAX_POINTS}`);
  const rA = points[0].a?.range ?? 0, rB = points[0].b?.range ?? 0;
  if (points.some((p) => p.a?.range !== rA || p.b?.range !== rB)) throw new Error('the loopback sweep changed ranges');
  return { created, coupling, rA, rB, ga: gains?.ga ?? [], gb: gains?.gb ?? [], pts };
}

export function encode(m) {
  const nr = m.ga.length, head = 10 + 4 * nr;
  const out = new Uint8Array(head + 8 * m.pts.length), v = new DataView(out.buffer);
  v.setUint8(0, 2); v.setUint8(1, m.pts.length);
  v.setUint32(2, Math.floor(Date.parse(m.created) / 1000), true);
  out.set([m.coupling, m.rA, m.rB, nr], 6);
  const g16 = (x) => (Number.isFinite(x) && Math.abs(x) < 3.2 ? Math.round(x * 1e4) : NONE);
  for (let r = 0; r < nr; r++) { v.setInt16(10 + 2 * r, g16(m.ga[r]), true); v.setInt16(10 + 2 * nr + 2 * r, g16(m.gb[r]), true); }
  m.pts.forEach((p, i) => {
    const o = head + 8 * i;
    v.setFloat32(o, p.f, true);
    v.setInt16(o + 4, Math.round(p.db * 1e4), true);
    v.setInt16(o + 6, Math.round(p.deg * 1e3), true);
  });
  return out;
}

export function decode(rec) {
  const v = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  if (rec.length < 10 || v.getUint8(0) !== 2) throw new Error('unknown channel match record (measure it again)');
  const n = v.getUint8(1), nr = rec[9], head = 10 + 4 * nr;
  if (rec.length < head + 8 * n || n < 1) throw new Error('short channel match record');
  const g = (o) => { const x = v.getInt16(o, true); return x === NONE ? NaN : x / 1e4; };
  const ga = [], gb = [];
  for (let r = 0; r < nr; r++) { ga.push(g(10 + 2 * r)); gb.push(g(10 + 2 * nr + 2 * r)); }
  const pts = [];
  for (let i = 0; i < n; i++) {
    const o = head + 8 * i;
    pts.push({ f: v.getFloat32(o, true), db: v.getInt16(o + 4, true) / 1e4, deg: v.getInt16(o + 6, true) / 1e3 });
  }
  return { created: new Date(v.getUint32(2, true) * 1000).toISOString(), coupling: rec[6], rA: rec[7], rB: rec[8], ga, gb, pts };
}

/** The match's B/A at f (complex), interpolated in log f; the end values outside the sweep. */
export function at(m, f) {
  const p = m.pts;
  let db = p[0].db, deg = p[0].deg;
  if (f >= p[p.length - 1].f) ({ db, deg } = p[p.length - 1]);
  else {
    for (let i = 1; i < p.length; i++) {
      if (f <= p[i].f && f > p[i - 1].f) {
        const t = Math.log(f / p[i - 1].f) / Math.log(p[i].f / p[i - 1].f);
        db = p[i - 1].db + t * (p[i].db - p[i - 1].db);
        deg = p[i - 1].deg + t * (p[i].deg - p[i - 1].deg);
        break;
      }
    }
  }
  return polar(10 ** (db / 20), deg * Math.PI / 180);
}

/** dB to add to the frequency match for channels on ranges rA, rB instead of the sweep's (0
 * where a gain wasn't measured). */
export function rangeDb(m, rA, rB) {
  if (rA == null || rB == null || (rA === m.rA && rB === m.rB)) return 0;
  const d = (m.gb[rB] - m.ga[rA]) - (m.gb[m.rB] - m.ga[m.rA]);
  return Number.isFinite(d) ? d : 0;
}

/** The channels' own B/A at f with A on range rA and B on rB (complex). */
export const ratio = (m, f, rA, rB) => { const x = at(m, f), k = 10 ** (rangeDb(m, rA, rB) / 20); return cx(x.re * k, x.im * k); };

/** B/A with the channel difference removed. */
export const correct = (m, f, h, rA, rB) => (m ? cdiv(h, ratio(m, f, rA, rB)) : h);

/** The match stored on the device, or null. */
export async function loadFrom(dev) {
  const rec = P.parseStore(await dev.storeRead()).get(TAG);
  return rec ? decode(rec) : null;
}

/** Stores (or with null, removes) the match, keeping the other records. */
export async function saveTo(dev, m) {
  const recs = P.parseStore(await dev.storeRead());
  if (m) recs.set(TAG, encode(m)); else recs.delete(TAG);
  await dev.storeWrite(P.buildStore(recs));
}
