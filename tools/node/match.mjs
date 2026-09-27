// Channel match on the DSO, as the Analyzer's Measure… does, both probes on the wave out:
//   node tools/node/match.mjs [--ac] [--store]
// Prints the frequency match and the per-range gains; --store writes it to the DSO (tag 2).
import * as Cal from '../../web/js/calibration.js';
import { Device } from '../../web/js/device.js';
import { logFreqs, planPoint, planSweep } from '../../web/js/analyzer/sweep.js';
import { measureRangeGains, runSweep } from '../../web/js/analyzer/run.js';
import * as Match from '../../web/js/analyzer/match.js';
import { openDevice } from './tty.mjs';

const coupling = process.argv.includes('--ac') ? 1 : 0;
process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
const dev = await openDevice(Device, process.env.DSOQ_TTY || undefined);
const cal = await Cal.loadFrom(dev);
const ranges = (await dev.tables())[1].map((r) => r.voltsPerDiv);
const ctx = { dev, cal, ranges, amp: 0.9, coupling };
const t0 = performance.now();
const pts = await runSweep(ctx, planSweep(logFreqs(Match.FROM_HZ, Match.TO_HZ, Match.PER_DECADE)).points, { average: 4 });
const gains = await measureRangeGains(ctx, planPoint(1000), pts[0].a.range, (t) => process.stdout.write(`\r${t}   `));
const m = Match.fromSweep(pts, gains, coupling);
console.log(`\rmeasured in ${((performance.now() - t0) / 1000).toFixed(1)} s (${coupling ? 'AC' : 'DC'}), sweep on A ${ranges[m.rA]} / B ${ranges[m.rB]} V/div`);
console.log('       Hz    B/A dB   phase °');
for (const p of m.pts) console.log(`${p.f.toFixed(0).padStart(9)} ${p.db.toFixed(4).padStart(9)} ${p.deg.toFixed(3).padStart(9)}`);
console.log('\n  V/div   A gain dB   B gain dB   (relative to A on the sweep range)');
ranges.forEach((v, r) => console.log(`${String(v).padStart(7)} ${m.ga[r].toFixed(4).padStart(11)} ${m.gb[r].toFixed(4).padStart(11)}`));
console.log(`record: ${Match.encode(m).length} bytes`);
if (process.argv.includes('--store')) { await Match.saveTo(dev, m); console.log('stored on the DSO'); }
await dev.close();
process.exit(0);
