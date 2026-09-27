// A level sweep on the DSO with the page's analyzer code:
//   node tools/node/level.mjs [Hz] [from %] [to %] [steps]
// Prints, per generator level, both channels' amplitude, B/A, each channel's THD, the THD B adds
// to A's (the generator's own taken out, assuming a flat device) and the noise floor under it.
import * as Cal from '../../web/js/calibration.js';
import { Device } from '../../web/js/device.js';
import { planSweep } from '../../web/js/analyzer/sweep.js';
import { runSweep } from '../../web/js/analyzer/run.js';
import { cabs } from '../../web/js/analyzer/detect.js';
import * as Match from '../../web/js/analyzer/match.js';
import { openDevice } from './tty.mjs';

const [hz = 1000, from = 10, to = 100, steps = 8] = process.argv.slice(2).map(Number);
process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
const dev = await openDevice(Device, process.env.DSOQ_TTY || undefined);
const cal = await Cal.loadFrom(dev);
const ranges = (await dev.tables())[1].map((r) => r.voltsPerDiv);
const match = await Match.loadFrom(dev).catch(() => null);
const one = planSweep([hz]).points[0];
const levels = Array.from({ length: steps }, (_, i) => from / 100 * (to / from) ** (i / Math.max(1, steps - 1)));
console.log(`${one.actual.toFixed(2)} Hz, ${match ? 'channel match applied' : 'no channel match'}`);
console.log(' level %   A Vpk    B Vpk   B/A dB   A THD %  B THD %  added %  floor %');
await runSweep({ dev, cal, ranges, match }, levels.map((amp) => ({ ...one, amp })), { average: Number(process.env.DSOQ_AVERAGE || 4) }, (p) => {
  const pc = (x) => (100 * x).toFixed(3).padStart(8);
  console.log(`${(100 * p.level).toFixed(1).padStart(8)} ${p.a.amp.toFixed(4).padStart(8)} ${p.b.amp.toFixed(4).padStart(8)} ${(20 * Math.log10(cabs(p.h))).toFixed(3).padStart(8)} ${pc(p.a.thd)} ${pc(p.b.thd)} ${pc(p.b.thdAdded)} ${pc(p.b.thdFloor)}${p.a.clip || p.b.clip ? '  CLIPPED' : ''}`);
});
await dev.close();
process.exit(0);
