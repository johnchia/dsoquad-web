// FRD export: "frequency dB phase" text, '*' comment lines. REW, VituixCAD and the esp32-airplay
// equaliser's "Fit to a measurement" read it (the last takes the first two numeric columns of
// every line and skips lines starting with * # ; %, needs at least 16 points, and fits only
// the shape, never the level).
import { cabs, carg, cdiv, cx } from './detect.js';

export const MIN_POINTS = 16;     // fewer and the esp32-airplay fitter rejects the file

/** FRD text from rows [{f, db, deg}] with comment lines first. */
export function frd(rows, comments = []) {
  const lines = comments.map((c) => `* ${c}`);
  lines.push('* Freq(Hz)\tSPL(dB)\tPhase(degrees)');
  for (const r of rows) lines.push(`${+r.f.toPrecision(7)}\t${r.db.toFixed(3)}\t${r.deg.toFixed(2)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The small-signal response of a voltage-driven driver in an infinite baffle, from its
 * impedance fit: the second-order high-pass s²/(s² + s·ωs/Qts + ωs²), 0 dB in the passband.
 * That is the cone's acceleration per volt with the motional impedance and Re (the voice
 * coil's inductance, cone break-up, baffle step and directivity are left out: an electrical
 * measurement cannot see the last three, and the first is lossy on real drivers, so a plain
 * Le would invent a treble roll-off). Rows over f0..f1 at 24 per octave.
 */
export function driverResponse({ fs, Qts }, f0 = 10, f1 = 20000) {
  const n = Math.ceil(24 * Math.log2(f1 / f0));
  return Array.from({ length: n + 1 }, (_, i) => {
    const f = f0 * (f1 / f0) ** (i / n), x = f / fs, h = cdiv(cx(-x * x), cx(1 - x * x, x / Qts));
    return { f, db: 20 * Math.log10(cabs(h)), deg: carg(h) * 180 / Math.PI };
  });
}
