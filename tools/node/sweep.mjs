// A frequency-response sweep on the DSO with the page's analyzer code:
//   node tools/node/sweep.mjs [from Hz] [to Hz] [points per decade]
// Prints f, B/A in dB and degrees, and each channel's range per point, with the channel match
// stored on the DSO applied (if any). DSOQ_CSV=file also writes f,re,im of B/A; DSOQ_LEVEL=0..1
// sets the generator level (0.9), DSOQ_AC=1 AC coupling.
import * as Cal from '../../web/js/calibration.js';
import { Device } from '../../web/js/device.js';
import { logFreqs, planSweep } from '../../web/js/analyzer/sweep.js';
import { runSweep } from '../../web/js/analyzer/run.js';
import { cabs, carg } from '../../web/js/analyzer/detect.js';
import * as Match from '../../web/js/analyzer/match.js';
import fs from 'node:fs';
import { openDevice } from './tty.mjs';

const [from = 20, to = 100000, ppd = 5] = process.argv.slice(2).map(Number);
process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
const dev = await openDevice(Device, process.env.DSOQ_TTY || undefined);
const cal = await Cal.loadFrom(dev);
const ranges = (await dev.tables())[1].map((r) => r.voltsPerDiv);
const match = await Match.loadFrom(dev).catch(() => null);
console.log(match ? `channel match from ${match.created}` : 'no channel match on the DSO');
const { points, seconds } = planSweep(logFreqs(from, to, ppd));
console.log(`${points.length} points, estimated ${seconds.toFixed(1)} s`);
const t0 = performance.now();
console.log('       Hz     B/A dB    phase °   A V/div  B V/div  spread dB/°');
const all = await runSweep({ dev, cal, ranges, amp: Number(process.env.DSOQ_LEVEL || 0.9), coupling: process.env.DSOQ_AC ? 1 : 0, match }, points, {}, (p) => {
  console.log(`${p.f.toFixed(1).padStart(9)} ${(20 * Math.log10(cabs(p.h))).toFixed(4).padStart(10)} ${(carg(p.h) * 180 / Math.PI).toFixed(3).padStart(10)} ${String(ranges[p.a.range]).padStart(8)} ${String(ranges[p.b.range]).padStart(8)}   ${p.spreadDb.toFixed(4)}/${p.spreadDeg.toFixed(3)}${p.a.clip || p.b.clip ? '  CLIPPED' : ''}`);
});
if (process.env.DSOQ_CSV) fs.writeFileSync(process.env.DSOQ_CSV, all.map((p) => `${p.f},${p.h.re},${p.h.im}`).join('\n') + '\n');
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
await dev.close();
process.exit(0);
