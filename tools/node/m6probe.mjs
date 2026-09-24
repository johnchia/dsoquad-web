// M6.1 hardware facts, with both probes on the wave out (DC coupling):
//   node tools/node/m6probe.mjs [match|purity|settle|all]
// match: A/B gain and phase (skew) mismatch per frequency; purity: generator THD per table
// length; settle: readings after a frequency change, frame by frame.
import * as P from '../../web/js/protocol.js';
import * as Cal from '../../web/js/calibration.js';
import { Device } from '../../web/js/device.js';
import { table } from '../../web/js/wavegen.js';
import { planPoint, logFreqs } from '../../web/js/analyzer/sweep.js';
import { analyse, cabs, carg, cdiv, clipped } from '../../web/js/analyzer/detect.js';
import { TtyTransport } from './tty.mjs';

const RANGE = 3, VDIV = 0.5;          // 0.5 V/div: the 0.04–2.72 V wave out in ~5.4 div
const what = process.argv[2] ?? 'all';
const dev = new Device(new TtyTransport(process.env.DSOQ_TTY));
await dev.open();
const cal = await Cal.loadFrom(dev);
const offs = [0, 1].map((ch) => Cal.offsetFor(cal, ch, RANGE, 25));
for (const ch of [0, 1]) await dev.setChannel(ch, RANGE, 0, offs[ch]);
await dev.setTrigger(0, 3, 0, 0);
await dev.setAcq(P.ACQ_AUTO, 100);

const volts = (f, ch) => {
  const c = f.ch[ch], z = Cal.zeroCode(cal, ch, c.range, c.offset), k = VDIV / Cal.codesPerDiv(cal, ch, c.range);
  return Float64Array.from(ch ? f.b : f.a, (x) => (x - z) * k);
};
const rateOf = (div) => Math.floor((P.TIMER_HZ + Math.floor(div / 2)) / div);

/** The next `n` frames at the plan's rate, after skipping `skip`. */
function frames(plan, n, skip = 1, timeout = 3000 + 4 * plan.captureS * 1000 * (n + skip)) {
  return new Promise((resolve, reject) => {
    const out = [];
    let seen = 0;
    const on = (e) => {
      const f = e.detail;
      if (f.rate !== rateOf(plan.capDiv) || ++seen <= skip) return;
      out.push(f);
      if (out.length >= n) { dev.removeEventListener('frame', on); clearTimeout(t); resolve(out); }
    };
    const t = setTimeout(() => { dev.removeEventListener('frame', on); reject(new Error(`no frames at ${plan.rateReq} S/s`)); }, timeout);
    dev.addEventListener('frame', on);
  });
}

async function setup(plan, amp = 0.9) {
  await dev.setGenWave(table('sine', plan.points, amp), plan.freq);
  await dev.setRate(plan.rateReq);
  const st = await dev.state();
  if (st.waveLen !== plan.points || st.genPsc !== plan.genPsc || st.genArr !== plan.genArr) {
    throw new Error(`generator ${st.waveLen}/${st.genPsc}/${st.genArr}, planned ${plan.points}/${plan.genPsc}/${plan.genArr}`);
  }
}

const read = (f, plan) => [0, 1].map((ch) => {
  const K = Math.min(plan.samples, f.count - f.stale);
  if (K !== plan.samples) throw new Error(`frame of ${f.count}`);
  return { ...analyse(volts(f, ch), f.stale, K, plan.cycles), clip: clipped(ch ? f.b : f.a, f.stale, K) };
});

if (what === 'match' || what === 'all') {
  console.log('\nA/B match, both probes on the wave out (3 frames per point)');
  console.log('      Hz   A Vpk    B/A dB     phase °   skew ns   spread dB/°');
  for (const freq of logFreqs(20, 100000, 5)) {
    const plan = planPoint(freq);
    await setup(plan);
    const hs = [];
    let a0;
    for (const f of await frames(plan, 3, 2)) {
      const [a, b] = read(f, plan);
      if (a.clip || b.clip) console.log('  clipped!');
      hs.push(cdiv(b.fund, a.fund)); a0 = a;
    }
    const g = hs.map((h) => 20 * Math.log10(cabs(h))), ph = hs.map((h) => carg(h) * 180 / Math.PI);
    const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length, spread = (v) => Math.max(...v) - Math.min(...v);
    const skew = -mean(ph) / 360 / plan.actual * 1e9;
    console.log(`${String(freq).padStart(8)} ${cabs(a0.fund).toFixed(3).padStart(7)} ${mean(g).toFixed(4).padStart(9)} ${mean(ph).toFixed(3).padStart(10)} ${skew.toFixed(1).padStart(9)}   ${spread(g).toFixed(4)}/${spread(ph).toFixed(3)}`);
  }
}

if (what === 'purity' || what === 'all') {
  console.log('\nGenerator purity at 1 kHz (channel A) per table length');
  console.log('  points   Vpk     THD %   H2 mV  H3 mV  noise mV rms');
  for (const n of [16, 32, 64, 128, 256, 500]) {
    const plan = planPoint(1000, { points: n });
    await setup(plan);
    const [a] = read((await frames(plan, 1, 2))[0], plan);
    console.log(`${String(n).padStart(8)} ${cabs(a.fund).toFixed(3)} ${(100 * a.thd).toFixed(3).padStart(8)} ${(1e3 * a.harmonics[0]).toFixed(2).padStart(7)} ${(1e3 * a.harmonics[1]).toFixed(2).padStart(6)} ${(1e3 * a.rmsNoise).toFixed(2).padStart(8)}`);
  }
}

if (what === 'settle' || what === 'all') {
  console.log('\nSettling: 1 kHz → f, channel A amplitude and B/A for the first frames after the change');
  for (const freq of [100, 10000]) {
    const p0 = planPoint(1000), plan = planPoint(freq);
    await setup(p0); await frames(p0, 1, 1);
    const t0 = Date.now();
    await setup(plan);
    const fs = await frames(plan, 5, 0);
    console.log(`  → ${freq} Hz (${Date.now() - t0} ms for 5 frames):`);
    for (const f of fs) {
      const [a, b] = read(f, plan), h = cdiv(b.fund, a.fund);
      console.log(`     frame ${f.frameNo}: A ${cabs(a.fund).toFixed(4)} V   B/A ${(20 * Math.log10(cabs(h))).toFixed(4)} dB ${(carg(h) * 180 / Math.PI).toFixed(3)}°`);
    }
  }
}

await dev.setGen(P.GEN_OFF, 1000, 50);
await dev.close();
process.exit(0);
