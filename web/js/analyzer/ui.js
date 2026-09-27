// The Analyzer view: frequency response (B/A), impedance (Z = R·B/(A−B)) and level (an
// amplifier's gain and distortion against output) sweeps, the channel match, wiring diagrams,
// plots, readouts and export. The app hands it the device and suspends its own scope while the
// view is open.
import { download, stamp } from '../export.js';
import { logFreqs, MAX_HZ, MIN_HZ, planPoint, planSweep } from './sweep.js';
import { measureDc, measureRangeGains, runSweep } from './run.js';
import { curve, phaseCrossings, readouts, refineFreqs, valueAt } from './response.js';
import { BodePlot } from './plot.js';
import { DUTS } from './duts.js';
import { cabs, carg, cx, polar } from './detect.js';
import * as Match from './match.js';
import { coneArea, fitDriver, fromVas, impedance, model, outputZ, reFromDc, vasAddedMass, vasSealed } from './speaker.js';
import { driverResponse, frd, MIN_POINTS } from './frd.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'dsoq.analyzer.v1';
const DEFAULTS = {
  mode: 'response', from: 20, to: 20000, ppd: 10, level: 90, settleMs: 0, average: 2, coupling: 0, refine: true,
  applyMatch: true, R: 47, zFrom: 10, zTo: 20000, sim: 'rc', vasMethod: 'mass', coneCm: 13, massG: 10, boxL: 10, zoutOn: false, RL: 8,
  lvlF: 1000, lvlFrom: 10, lvlTo: 100, lvlN: 16, lvlRL: 8,
};
const MODES = { response: 'Frequency response', impedance: 'Impedance', level: 'Level' };
const SIM_FOR = { response: 'rc', impedance: 'speaker', level: 'ampClip' };
// Simulated circuits that suit each mode (the loopback suits all).
const SIM_SUITS = { response: (k) => !k.startsWith('speaker'), impedance: (k) => k.startsWith('speaker'), level: (k) => k.startsWith('amp') };

const fmtHz = (f) => (!Number.isFinite(f) ? '–' : f >= 1e3 ? `${+(f / 1e3).toPrecision(4)} kHz` : `${+f.toPrecision(4)} Hz`);
const fmtS = (s) => (s < 60 ? `${Math.ceil(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const fmtOhm = (z) => (Number.isFinite(z) ? `${z < 10 ? z.toFixed(2) : z.toFixed(1)} Ω` : '–');
const fmtH = (l) => (l >= 1e-3 ? `${(l * 1e3).toFixed(2)} mH` : `${(l * 1e6).toFixed(0)} µH`);

function load(key, def) {
  try { return { ...def, ...JSON.parse(localStorage.getItem(key)) }; } catch { return { ...def }; }
}
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } }

const PHASE = { label: 'Phase', unit: '°', key: 'phaseDeg', steps: [15, 30, 45, 90, 180], minSpan: 90, fmt: (v, hover) => (hover ? v.toFixed(1) : `${Math.round(v)}`) };
const PANES = {
  response: [{ label: 'Gain', unit: 'dB', key: 'gainDb', steps: [1, 2, 5, 10, 20], minSpan: 6, fmt: (v, hover) => (hover ? v.toFixed(2) : `${+v.toFixed(1)}`) }, PHASE],
  impedance: [{ label: '|Z|', unit: 'Ω', key: 'zAbs', steps: [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000], minSpan: 2, fmt: (v, hover) => (hover ? v.toPrecision(4) : `${+v.toPrecision(3)}`) },
    { ...PHASE, minSpan: 60 }],
  level: [{ label: 'Gain', unit: 'dB', key: 'gainDb', steps: [0.1, 0.2, 0.5, 1, 2, 5, 10], minSpan: 1, fmt: (v, hover) => (hover ? v.toFixed(2) : `${+v.toFixed(1)}`) },
    { label: 'THD added', unit: '%', key: 'thdPct', steps: [0.1, 0.2, 0.5, 1, 2, 5, 10, 20], minSpan: 1, fmt: (v, hover) => (hover ? v.toFixed(2) : `${+v.toFixed(1)}`) }],
};
const X_UNIT = { response: 'Hz', impedance: 'Hz', level: 'V rms' };

/**
 * ctx: {getDev() → Device|null, getCal(), getRanges(), getSim() → SimTransport|null, toast(msg, kind)}
 * Returns {open(on), connected()} for the app.
 */
export function initAnalyzer(ctx) {
  const s = load(STORE_KEY, DEFAULTS);
  let run = null;             // AbortController while sweeping
  let busy = '';              // what's running (for the status line)
  // Raw sweeps per mode ({pts, R} with pts' h = B/A without the match), and reference sweeps.
  const runs = load(`${STORE_KEY}.runs`, { response: { pts: [] }, impedance: { pts: [], R: s.R, reDc: null }, level: { pts: [] } });
  const refs = load(`${STORE_KEY}.refs`, { response: { pts: [] }, impedance: { pts: [], R: s.R }, level: { pts: [] } });
  let match = null;           // channel match from the device
  let open = false;
  const plot = new BodePlot($('an-plot'), PANES[s.mode]);

  // ---------------------------------------------------------------- controls

  const fields = {
    from: $('an-from'), to: $('an-to'), ppd: $('an-ppd'), level: $('an-level'), settleMs: $('an-settle'), average: $('an-average'), R: $('an-r'),
    coneCm: $('an-cone'), massG: $('an-mass'), boxL: $('an-box'), RL: $('an-rl'),
    lvlF: $('an-lvl-f'), lvlFrom: $('an-lvl-from'), lvlTo: $('an-lvl-to'), lvlN: $('an-lvl-n'), lvlRL: $('an-lvl-rl'),
  };
  const key = (k) => (s.mode === 'impedance' && (k === 'from' || k === 'to') ? (k === 'from' ? 'zFrom' : 'zTo') : k);
  const fillFields = () => { for (const [k, el] of Object.entries(fields)) el.value = s[key(k)]; };
  for (const [k, el] of Object.entries(fields)) {
    el.onchange = () => {
      let v = Number(el.value);
      if (k === 'from' || k === 'to' || k === 'lvlF') v = Math.round(Math.min(MAX_HZ, Math.max(MIN_HZ, v || DEFAULTS[key(k)])));
      if (['R', 'coneCm', 'massG', 'boxL', 'RL', 'lvlRL'].includes(k)) v = v > 0 ? v : DEFAULTS[k];
      if (k === 'lvlFrom' || k === 'lvlTo') v = Math.round(Math.min(100, Math.max(5, v || DEFAULTS[k])));
      if (k === 'lvlN') v = Math.round(Math.min(40, Math.max(3, v || DEFAULTS[k])));
      s[key(k)] = v; el.value = v;
      save(STORE_KEY, s);
      update();
    };
  }
  fillFields();
  $('an-level').oninput = () => { $('an-level-out').textContent = `${$('an-level').value} %`; };
  $('an-level').oninput();
  $('an-refine').checked = s.refine;
  $('an-refine').onchange = () => { s.refine = $('an-refine').checked; save(STORE_KEY, s); };
  $('an-zout-on').checked = s.zoutOn;
  $('an-zout-on').onchange = () => { s.zoutOn = $('an-zout-on').checked; save(STORE_KEY, s); update(); };
  $('an-apply-match').checked = s.applyMatch;
  $('an-apply-match').onchange = () => { s.applyMatch = $('an-apply-match').checked; save(STORE_KEY, s); update(); };

  const segSync = (id, v) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.value === String(v)));
  $('an-coupling').querySelectorAll('button').forEach((b) => { b.onclick = () => { s.coupling = Number(b.value); save(STORE_KEY, s); update(); }; });
  $('an-mode').querySelectorAll('button').forEach((b) => { b.onclick = () => setMode(b.value); });
  $('an-vas-method').querySelectorAll('button').forEach((b) => { b.onclick = () => { s.vasMethod = b.value; save(STORE_KEY, s); update(); }; });

  const simSel = $('an-sim');
  simSel.innerHTML = Object.entries(DUTS).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
  simSel.value = s.sim;
  simSel.onchange = () => { s.sim = simSel.value; save(STORE_KEY, s); applySim(); };
  const applySim = (dut = s.sim) => { const t = ctx.getSim(); if (t) t.dut = open ? dut : null; };

  $('an-start').onclick = () => (run ? run.abort() : start());
  $('an-ref-set').onclick = () => { refs[s.mode] = structuredClone(runs[s.mode]); save(`${STORE_KEY}.refs`, refs); update(); };
  $('an-ref-clear').onclick = () => { refs[s.mode] = { pts: [], R: s.R }; save(`${STORE_KEY}.refs`, refs); update(); };
  $('an-csv').onclick = saveCsv;
  $('an-frd').onclick = saveFrd;
  $('an-png').onclick = () => $('an-plot').toBlob((b) => download(b, `dsoquad-${s.mode}-${stamp()}.png`));
  $('an-match-measure').onclick = measureMatch;
  $('an-match-delete').onclick = deleteMatch;
  $('an-re-dc').onclick = measureRe;
  $('an-re-clear').onclick = () => { runs.impedance.reDc = null; save(`${STORE_KEY}.runs`, runs); update(); };

  function setMode(m) {
    if (run || !MODES[m]) return;
    s.mode = m;
    // In the simulator, switch to a circuit that suits the mode.
    if (ctx.getSim() && s.sim !== 'through' && !SIM_SUITS[m](s.sim)) { s.sim = SIM_FOR[m]; simSel.value = s.sim; applySim(); }
    save(STORE_KEY, s);
    plot.setPanes(PANES[m]);
    fillFields();
    update();
  }

  // ---------------------------------------------------------------- derived curves

  /** B/A of a sweep point with the channel match applied (if on). */
  const hOf = (p) => (s.applyMatch && match ? Match.correct(match, p.f, p.h, p.a.range, p.b.range) : p.h);

  /** Plot points for a sweep in the current mode. */
  function points(r) {
    if (s.mode === 'level') {
      // x: B's output in V rms; gain and the THD B adds to the generator's.
      return r.pts.map((p) => ({ ...p, hz: p.f, f: p.b.amp / Math.SQRT2, gainDb: 20 * Math.log10(cabs(hOf(p))), thdPct: 100 * p.b.thdAdded, floorPct: 100 * (p.b.thdFloor ?? NaN) }))
        .sort((a, b) => a.f - b.f);
    }
    const c = curve(r.pts.map((p) => ({ ...p, h: hOf(p) })));
    if (s.mode !== 'impedance') return c;
    let prev = null, turns = 0;
    return c.map((q) => {
      const z = impedance(cx(1), q.h, r.R ?? s.R);
      let deg = carg(z) * 180 / Math.PI;
      if (prev !== null) { while (deg + 360 * turns - prev > 180) turns--; while (deg + 360 * turns - prev < -180) turns++; }
      deg += 360 * turns; prev = deg;
      return { ...q, z, zAbs: cabs(z), phaseDeg: deg, gainDb: 20 * Math.log10(cabs(z)) };
    });
  }

  /** Driver fit when the |Z| curve has a resonance inside the sweep, else null. */
  function driverFit(c) {
    if (c.length < 8) return null;
    let k = 0;
    for (let i = 1; i < c.length; i++) if (c[i].zAbs > c[k].zAbs) k = i;
    const below = Math.min(...c.slice(0, k + 1).map((q) => q.zAbs));
    if (k === 0 || k === c.length - 1 || c[k].zAbs < 1.5 * below) return null;
    try {
      const fit = fitDriver(c.map((q) => ({ f: q.f, z: q.z })), { Re: runs.impedance.reDc ?? undefined });
      return Number.isFinite(fit.params.fs) && fit.rms < 0.2 ? fit : null;
    } catch { return null; }
  }

  /** Level sweep readouts: gain, compression, added THD, and where it reaches 1 % (the power
   * rating's usual limit) with the output power into the load. */
  function levelHtml(c, r) {
    const lo = c[0], hi = c[c.length - 1], P = (v) => v * v / s.lvlRL;
    const fmtW = (w) => (w >= 1 ? `${w.toFixed(w < 10 ? 2 : 1)} W` : `${(w * 1e3).toFixed(w < 0.01 ? 2 : 0)} mW`);
    let at1 = null;
    for (let i = 1; i < c.length && at1 === null; i++) {
      const a = c[i - 1], b = c[i];
      if (a.thdPct < 1 && b.thdPct >= 1) at1 = a.f * (b.f / a.f) ** ((Math.log(1) - Math.log(a.thdPct)) / (Math.log(b.thdPct) - Math.log(a.thdPct)));
    }
    if (at1 === null && lo.thdPct >= 1) at1 = NaN;
    const genThd = Math.max(...r.pts.map((x) => x.a.thd).filter(Number.isFinite));
    return `
      <dt>At</dt><dd>${fmtHz(lo.freq)}, ${fmtOhm(s.lvlRL)} load</dd>
      <dt>Gain</dt><dd>${lo.gainDb.toFixed(2)} dB at ${lo.f.toPrecision(3)} V rms out</dd>
      <dt>Compression</dt><dd>${(hi.gainDb - lo.gainDb).toFixed(2)} dB at ${hi.f.toPrecision(3)} V rms out</dd>
      <dt>THD added</dt><dd>${lo.thdPct.toFixed(2)} % at the lowest level, ${hi.thdPct.toFixed(2)} % at the highest</dd>
      <dt>Floor</dt><dd>noise ${Math.min(...c.map((q) => q.floorPct)).toFixed(2)}–${Math.max(...c.map((q) => q.floorPct)).toFixed(2)} % (dashed); on top of that the two 8-bit ADCs distort differently by 0.1–0.7 % (measured through a flat path, worst on small signals), so below about 1 % read it as clean</dd>
      <dt>1 % THD</dt><dd>${at1 === null ? `not reached: up to ${hi.f.toPrecision(3)} V rms, ${fmtW(P(hi.f))}`
        : Number.isNaN(at1) ? 'already over 1 % at the lowest level' : `${at1.toPrecision(3)} V rms out, ${fmtW(P(at1))} into ${fmtOhm(s.lvlRL)}`}</dd>
      <dt>Source THD</dt><dd>${Number.isFinite(genThd) ? `${(100 * genThd).toFixed(1)} % (the generator's own; taken out above)` : '–'}</dd>`;
  }

  /** Output impedance from the loaded sweep c and the unloaded reference (interpolated onto c). */
  function zoutHtml(c, ref) {
    const head = '<dt class="sep">Zout</dt>';
    const z = c.filter((q) => q.f >= ref[0].f && q.f <= ref[ref.length - 1].f).map((q) => {
      const h0 = polar(10 ** (valueAt(ref, q.f, 'gainDb') / 20), valueAt(ref, q.f, 'phaseDeg') * Math.PI / 180);
      return { f: q.f, z: outputZ(h0, q.h, s.RL) };
    });
    if (!z.length) return `${head}<dd>the reference doesn't cover this sweep</dd>`;
    const drop = z.reduce((a, q) => a + cabs(q.z), 0) / z.length;
    if (drop < 1e-3 * s.RL) return `${head}<dd>now sweep with ${fmtOhm(s.RL)} across the output; this sweep and the reference are alike</dd>`;
    const near = (f) => z.reduce((a, q) => (Math.abs(Math.log(q.f / f)) < Math.abs(Math.log(a.f / f)) ? q : a));
    const at = [100, 1000, 10000].map(near).filter((q, i, a) => a.indexOf(q) === i);
    const fmtZ = (q) => { const w = 2 * Math.PI * q.f, x = q.z.im; return `${cabs(q.z).toFixed(3)} Ω <span class="note">(${q.z.re.toFixed(3)} Ω ${x >= 0 ? `+ ${(x / w * 1e6).toFixed(1)} µH` : `− j${(-x).toFixed(3)} Ω`})</span>`; };
    const k = near(1000), worst = z.reduce((a, q) => (cabs(q.z) > cabs(a.z) ? q : a));
    return `${head}<dd>${fmtZ(at[0])} at ${fmtHz(at[0].f)}</dd>`
      + at.slice(1).map((q) => `<dt></dt><dd>${fmtZ(q)} at ${fmtHz(q.f)}</dd>`).join('')
      + `<dt>Highest</dt><dd>${cabs(worst.z).toFixed(3)} Ω at ${fmtHz(worst.f)}</dd>`
      + `<dt>Damping</dt><dd>${(8 / cabs(k.z)).toFixed(0)} into 8 Ω at ${fmtHz(k.f)}</dd>`;
  }

  /** Vas and the rest of the Thiele-Small set from this sweep's fit and the reference's: free air
   * against added mass (the free one has the higher fs) or a sealed box (the lower). */
  function vasHtml(a, b) {
    const head = '<dt class="sep">Vas</dt>';
    if (!b) return `${head}<dd>the reference sweep has no driver fit</dd>`;
    const mass = s.vasMethod === 'mass';
    const [free, other] = (a.params.fs > b.params.fs) === mass ? [a, b] : [b, a];
    const shift = mass ? free.params.fs / other.params.fs : other.params.fs / free.params.fs;
    if (!(shift > 1.02)) return `${head}<dd>now sweep ${mass ? `with the ${s.massG} g on the cone` : `in the ${s.boxL} L box`}; this sweep and the reference are alike</dd>`;
    if (!(shift > 1.08)) return `${head}<dd>fs moved by only ${(100 * Math.abs(1 - shift)).toFixed(1)} % between the two sweeps: ${mass ? 'add more mass' : 'use a smaller box'} (aim for 25 % or more)</dd>`;
    const P = free.params, D = free.derived, Sd = coneArea(s.coneCm / 100);
    const Vas = mass ? vasAddedMass({ fs: P.fs, fsMass: other.params.fs, m: s.massG / 1000, Sd }).Vas
      : vasSealed({ fs: P.fs, Qes: D.Qes, fc: other.params.fs, Qec: other.derived.Qes, Vb: s.boxL / 1000 }).Vas;
    if (!(Vas > 0)) return `${head}<dd>no answer from these two sweeps (Qec below Qes?)</dd>`;
    const t = fromVas({ Re: P.Re, fs: P.fs, Qms: P.Qms, Qes: D.Qes, Vas, Sd });
    return `${head}<dd>${(Vas * 1e3).toPrecision(3)} L <span class="note">(free air fs ${fmtHz(P.fs)}, ${mass ? `with the mass` : 'in the box'} ${fmtHz(other.params.fs)}; Sd ${(Sd * 1e4).toFixed(0)} cm²)</span></dd>
      <dt>Mms</dt><dd>${(t.Mms * 1e3).toFixed(1)} g</dd>
      <dt>Cms</dt><dd>${(t.Cms * 1e3).toFixed(3)} mm/N</dd>
      <dt>Rms</dt><dd>${t.Rms.toFixed(2)} kg/s</dd>
      <dt>Bl</dt><dd>${t.Bl.toFixed(2)} T·m</dd>
      <dt>η0</dt><dd>${(100 * t.eta0).toFixed(2)} %</dd>
      <dt>Sensitivity</dt><dd>${t.spl1W.toFixed(1)} dB (1 W), ${t.spl2V83.toFixed(1)} dB (2.83 V) at 1 m <span class="note">(half space, from the model)</span></dd>
      <dt>EBP</dt><dd>${t.ebp.toFixed(0)} <span class="note">(fs/Qes: under 50 sealed, over 100 vented)</span></dd>`;
  }

  /** Readouts to refine in each mode: the −3 dB points, or for |Z| the √r0 points (half the
   * peak's height in dB above the base). */
  function refineReadouts(c) {
    if (s.mode !== 'impedance') return readouts(c);
    const r = readouts(c);
    const base = Math.min(...c.slice(0, r.peakIndex + 1).map((q) => q.gainDb));
    return readouts(c, { drop: (r.peakDb - base) / 2 });
  }

  // ---------------------------------------------------------------- view

  /** Generator levels (0..1) of a level sweep, log spaced. */
  const levels = () => {
    const a = Math.min(s.lvlFrom, s.lvlTo) / 100, b = Math.max(s.lvlFrom, s.lvlTo) / 100, n = s.lvlN;
    return Array.from({ length: n }, (_, i) => a * (b / a) ** (i / (n - 1)));
  };

  function plan() {
    if (s.mode === 'level') {
      const one = planSweep([s.lvlF], { settle: s.settleMs / 1000, average: s.average });
      if (!one.points.length) return { points: [], seconds: 0 };
      const ls = levels();
      return { points: ls.map((amp) => ({ ...one.points[0], amp })), seconds: one.seconds * ls.length };
    }
    const from = s[key('from')], to = s[key('to')];
    return planSweep(logFreqs(Math.min(from, to), Math.max(from, to), s.ppd), { settle: s.settleMs / 1000, average: s.average });
  }

  function update() {
    const dev = ctx.getDev(), imp = s.mode === 'impedance', lvl = s.mode === 'level';
    const p = plan();
    segSync('an-mode', s.mode);
    segSync('an-coupling', s.coupling);
    $('an-mode-legend').textContent = MODES[s.mode];
    $('an-wiring-response').hidden = imp;
    $('an-wiring-impedance').hidden = !imp;
    for (const id of ['an-r-row', 'an-re-row', 'an-vas']) $(id).hidden = !imp;
    $('an-zout').hidden = imp || lvl;
    for (const id of ['an-from-row', 'an-to-row', 'an-ppd-row', 'an-level-row', 'an-refine-row']) $(id).hidden = lvl;
    $('an-lvl-rows').hidden = !lvl;
    $('an-level-note').hidden = !lvl;
    $('an-zout-body').hidden = !s.zoutOn;
    segSync('an-vas-method', s.vasMethod);
    $('an-mass-row').hidden = s.vasMethod !== 'mass';
    $('an-box-row').hidden = s.vasMethod !== 'box';
    $('an-vas-note').textContent = s.vasMethod === 'mass'
      ? 'Sweep the driver in free air, lying flat, and press Keep as reference. Then stick a weighed mass evenly around the dust cap (Blu-Tack, or coins with a dab of it: about the cone\'s own, 10–20 g for a 6.5″) and sweep again. Cone: the effective diameter, the cone plus a third of the surround on each side.'
      : 'Sweep the driver in free air and press Keep as reference. Then seal it into a closed box of known net volume (inside, less the driver and bracing; unstuffed) and sweep again. Cone: the effective diameter, the cone plus a third of the surround on each side.';
    $('an-estimate').textContent = `${p.points.length} points, about ${fmtS(p.seconds)}`;
    $('an-start').textContent = run && busy === 'sweep' ? 'Stop' : 'Start sweep';
    $('an-start').classList.toggle('primary', !run);
    $('an-start').disabled = (!dev && !run) || (run && busy !== 'sweep');
    $('an-sim-row').hidden = !ctx.getSim();
    const controls = [...Object.values(fields), ...document.querySelectorAll('#an-coupling button, #an-mode button'), $('an-refine'), simSel];
    for (const el of controls) el.disabled = !!run;
    const r = runs[s.mode], ref = refs[s.mode];
    $('an-ref-set').disabled = !r.pts.length || !!run;
    $('an-ref-clear').disabled = !ref.pts.length;
    $('an-csv').disabled = $('an-png').disabled = !r.pts.length;
    $('an-match-measure').disabled = !dev || !!run;
    $('an-match-delete').disabled = !dev || !match || !!run;
    $('an-apply-match').disabled = !match;
    $('an-re-dc').disabled = !dev || !!run;
    $('an-re-clear').hidden = runs.impedance.reDc == null;
    $('an-re-value').textContent = runs.impedance.reDc == null ? 'not measured (fitted)' : fmtOhm(runs.impedance.reDc);
    const last = match?.pts[match.pts.length - 1];
    const ranged = match && match.ga.some(Number.isFinite);
    $('an-match-status').innerHTML = match
      ? `Measured ${new Date(match.created).toLocaleDateString()} (${match.coupling ? 'AC' : 'DC'}): B/A ${last.db.toFixed(2)} dB, ${last.deg.toFixed(2)}° at ${fmtHz(last.f)}${ranged ? '; all ranges' : ''}.`
        + (match.coupling !== s.coupling ? ` <span class="err">Measured with ${match.coupling ? 'AC' : 'DC'} coupling: below ~50 Hz it only fits sweeps with the same.</span>` : '')
      : 'Not measured: results include the channels\' own difference (~0.1 dB, ~0.5° at 100 kHz, and each range\'s gain error when uncalibrated).';

    const c = r.pts.length ? points(r) : [];
    const series = [{ label: ref.pts.length ? 'Now' : '', pts: c }];
    if (ref.pts.length) series.push({ label: 'Ref', pts: points(ref), color: '#8b949e', dashed: true });
    let markers = [], html, fit = null;
    if (lvl) {
      html = c.length ? levelHtml(c, r) : '';
      if (c.some((q) => Number.isFinite(q.floorPct))) series.push({ label: 'Noise', pts: c.map((q) => ({ f: q.f, thdPct: q.floorPct })), color: '#6e7681', dashed: true });
    }
    else if (!imp) {
      const q = c.length >= 2 ? readouts(c) : null;
      if (q) markers = [{ f: q.lowF, label: `−3 dB ${fmtHz(q.lowF)}` }, { f: q.highF, label: `−3 dB ${fmtHz(q.highF)}` }].filter((m) => Number.isFinite(m.f));
      const thdMax = c.length ? Math.max(...r.pts.map((x) => x.a.thd).filter(Number.isFinite)) : NaN;
      html = q ? `
        <dt>Peak</dt><dd>${q.peakDb.toFixed(2)} dB at ${fmtHz(q.peakF)}</dd>
        <dt>−3 dB low</dt><dd>${Number.isFinite(q.lowF) ? fmtHz(q.lowF) : 'below the sweep'}</dd>
        <dt>−3 dB high</dt><dd>${Number.isFinite(q.highF) ? fmtHz(q.highF) : 'above the sweep'}</dd>
        ${[-45, 45].flatMap((d) => phaseCrossings(c, d).map((f) => `<dt>${d > 0 ? '+' : '−'}45° at</dt><dd>${fmtHz(f)} <span class="note">(fc of a 1st-order ${d < 0 ? 'low' : 'high'}-pass)</span></dd>`)).join('')}
        ${s.zoutOn && ref.pts.length ? zoutHtml(c, points(ref)) : ''}
        <dt>Source THD</dt><dd>${Number.isFinite(thdMax) ? `≤ ${(100 * thdMax).toFixed(1)} % (the generator's own)` : '–'}</dd>` : '';
    } else if (c.length) {
      const lo = c.reduce((a, b) => (b.zAbs < a.zAbs ? b : a)), hi = c.reduce((a, b) => (b.zAbs > a.zAbs ? b : a));
      fit = driverFit(c);
      html = `<dt>|Z| min</dt><dd>${fmtOhm(lo.zAbs)} at ${fmtHz(lo.f)}</dd><dt>|Z| max</dt><dd>${fmtOhm(hi.zAbs)} at ${fmtHz(hi.f)}</dd>`;
      if (fit) {
        const { params: P, derived: D } = fit;
        markers = [{ f: P.fs, label: `fs ${fmtHz(P.fs)}` }];
        const fs = logFreqs(c[0].f, c[c.length - 1].f, 60);
        series.push({ label: 'Fit', pts: fs.map((f) => { const z = model(P, f); return { f, zAbs: cabs(z), phaseDeg: carg(z) * 180 / Math.PI }; }), color: '#ff8c42', dashed: true });
        html += `
          <dt>Re</dt><dd>${fmtOhm(P.Re)}${runs.impedance.reDc != null ? ' (DC)' : ''}</dd>
          <dt>fs</dt><dd>${fmtHz(P.fs)}</dd>
          <dt>Zmax</dt><dd>${fmtOhm(D.Zmax)}</dd>
          <dt>Qms</dt><dd>${P.Qms.toFixed(2)}</dd>
          <dt>Qes</dt><dd>${D.Qes.toFixed(3)}</dd>
          <dt>Qts</dt><dd>${D.Qts.toFixed(3)}</dd>
          <dt>Le</dt><dd>${fmtH(P.Le)}</dd>
          <dt>Fit</dt><dd>${(100 * fit.rms).toFixed(1)} % rms from the model</dd>`;
      } else html += '<dt>Driver</dt><dd>no resonance in the sweep: no Thiele-Small fit</dd>';
      if (fit && ref.pts.length) html += vasHtml(fit, driverFit(points(ref)));
    }
    if (html && r.pts.some((x) => x.a.clip || x.b.clip)) html += '<dt>Clipped</dt><dd><span class="err">yes: some points are unreliable</span></dd>';
    $('an-readouts').innerHTML = html || '<dt>Results</dt><dd>–</dd>';
    const frdWhy = frdProblem(r, fit);
    $('an-frd').disabled = !!frdWhy;
    $('an-frd').title = frdWhy || (imp
      ? 'The driver\'s modelled response (infinite baffle, from the Thiele-Small fit) as an FRD file, for an equaliser such as esp32-airplay\'s "Fit to a measurement"'
      : 'This sweep as an FRD file (frequency, dB, phase) for REW, VituixCAD or esp32-airplay\'s "Fit to a measurement"');
    if (lvl) {
      const xs = [...c, ...(ref.pts.length ? points(ref) : [])].map((q) => q.f).filter((x) => x > 0);
      const x0 = xs.length ? Math.min(...xs) / 1.2 : 0.1, x1 = xs.length ? Math.max(...xs) * 1.2 : 10;
      plot.setData({ series, markers, f0: x0, f1: x1, xUnit: X_UNIT.level });
      return;
    }
    const xs = [...r.pts, ...ref.pts].map((q) => q.f), from = s[key('from')], to = s[key('to')];
    plot.setData({ series, markers, f0: Math.min(from, to, ...xs), f1: Math.max(from, to, ...xs), xUnit: X_UNIT[s.mode] });
  }

  const msg = (t) => { $('an-msg').textContent = t; };
  const sweepCtx = (dev) => ({ dev, cal: ctx.getCal(), ranges: ctx.getRanges(), amp: s.level / 100, coupling: s.coupling });

  /** Runs `fn(signal)` as the one operation in progress; handles stop, errors and cleanup. */
  async function operation(what, fn) {
    const dev = ctx.getDev();
    if (!dev || run) return;
    run = new AbortController();
    busy = what;
    update();
    try {
      await fn(dev, run.signal);
    } catch (e) {
      if (e.name === 'AbortError') msg('Stopped');
      else { msg(''); ctx.toast(`${what === 'sweep' ? 'Sweep' : 'Measurement'} failed: ${e.message}`); }
      try { await dev.setGen(0, 1000, 50); } catch { /* disconnected */ }
    } finally {
      run = null;
      busy = '';
      applySim();
      update();
    }
  }

  function start() {
    return operation('sweep', async (dev, signal) => {
      const { points: pl } = plan(), mode = s.mode;
      const r = runs[mode] = { ...runs[mode], pts: [], R: s.R };
      const t0 = performance.now(), prog = $('an-progress');
      prog.max = pl.length; prog.value = 0;
      msg(`Starting (${pl.length} points)…`);
      const opts = { settle: s.settleMs / 1000, average: s.average };
      const add = (p) => { r.pts.push(p); r.pts.sort((a, b) => a.f - b.f); update(); };
      try {
        await runSweep(sweepCtx(dev), pl, opts, (p, i, n) => { add(p); prog.value = i; msg(`${i} / ${n}: ${fmtHz(p.f)}`); }, signal);
        // Refine: more points where readouts are interpolated (−3 dB or √r0 points, the peak).
        const c = points(r);
        const extra = s.refine && mode !== 'level' && c.length >= 3 ? planSweep(refineFreqs(c, refineReadouts(c))).points : [];
        if (extra.length) {
          prog.max = pl.length + extra.length;
          await runSweep(sweepCtx(dev), extra, opts, (p, i, n) => { add(p); prog.value = pl.length + i; msg(`Refining ${i} / ${n}: ${fmtHz(p.f)}`); }, signal);
        }
        msg(`Done: ${r.pts.length} points in ${fmtS((performance.now() - t0) / 1000)}`);
      } finally { save(`${STORE_KEY}.runs`, runs); }
    });
  }

  function measureMatch() {
    if (!confirm(`Channel match: clip probes A and B both onto the wave out, with nothing else connected, then press OK.\n\nIt sweeps 10 Hz to 125 kHz with ${s.coupling ? 'AC' : 'DC'} coupling, then steps through the ranges (about 30 s), and stores the result on the DSO.`)) return;
    operation('match', async (dev, signal) => {
      applySim('through');
      const pl = planSweep(logFreqs(Match.FROM_HZ, Match.TO_HZ, Match.PER_DECADE)).points;
      const nr = ctx.getRanges().length, prog = $('an-progress');
      prog.max = pl.length + 2 * nr - 1; prog.value = 0;
      const pts = await runSweep({ ...sweepCtx(dev), amp: 0.9 }, pl, { average: 4 }, (p, i, n) => { prog.value = i; msg(`Channel match ${i} / ${n}: ${fmtHz(p.f)}`); }, signal);
      const gains = await measureRangeGains(sweepCtx(dev), planPoint(1000), pts[0].a.range, (t) => { prog.value++; msg(`Channel match: ${t}`); }, signal);
      const m = Match.fromSweep(pts, gains, s.coupling);
      await Match.saveTo(dev, m);
      match = m;
      msg('Channel match stored on the DSO');
    });
  }

  function deleteMatch() {
    if (!confirm('Delete the channel match stored on the DSO?')) return;
    operation('match', async (dev) => { await Match.saveTo(dev, null); match = null; msg('Channel match deleted'); });
  }

  function measureRe() {
    operation('dc', async (dev, signal) => {
      msg('Measuring Re at DC…');
      const { levels: [[a1, b1], [a2, b2]], ranges: [rA, rB] } = await measureDc(sweepCtx(dev), signal);
      // B's gain relative to A at DC on those ranges: the match's lowest point.
      const k = s.applyMatch && match ? cabs(Match.ratio(match, 0, rA, rB)) : 1;
      const re = reFromDc(a1, b1 / k, a2, b2 / k, s.R);
      if (!(re > 0 && re < 1e4)) throw new Error(`Re came out as ${re.toFixed(2)} Ω: is there a capacitor in the circuit, or R wrong?`);
      runs.impedance.reDc = re;
      save(`${STORE_KEY}.runs`, runs);
      msg(`Re = ${fmtOhm(re)} at DC`);
    });
  }

  function saveCsv() {
    const c = points(runs[s.mode]), ranges = ctx.getRanges();
    const head = s.mode === 'impedance' ? ['freq_set_hz', 'freq_hz', 'z_ohm', 'z_phase_deg', 'z_re_ohm', 'z_im_ohm']
      : s.mode === 'level' ? ['freq_set_hz', 'freq_hz', 'level_pct', 'out_vrms', 'gain_db', 'thd_added_pct', `power_w_${s.lvlRL}ohm`]
        : ['freq_set_hz', 'freq_hz', 'gain_vv', 'gain_db', 'phase_deg'];
    const rows = [[...head, 'a_vpk', 'b_vpk', 'a_thd_pct', 'b_thd_pct', 'a_vdiv', 'b_vdiv', 'spread_db', 'spread_deg', 'readings', 'match_applied'].join(',')];
    for (const q of c) {
      const main = s.mode === 'impedance' ? [q.zAbs.toPrecision(6), q.phaseDeg.toFixed(2), q.z.re.toPrecision(6), q.z.im.toPrecision(6)]
        : s.mode === 'level' ? [(100 * q.level).toFixed(1), q.f.toPrecision(5), q.gainDb.toFixed(3), q.thdPct.toFixed(3), (q.f * q.f / s.lvlRL).toPrecision(4)]
          : [q.gain.toPrecision(6), q.gainDb.toFixed(3), q.phaseDeg.toFixed(2)];
      rows.push([q.freq, (q.hz ?? q.f).toPrecision(8), ...main, q.a.amp.toPrecision(5), q.b.amp.toPrecision(5), (100 * q.a.thd).toFixed(2), (100 * q.b.thd).toFixed(2),
        ranges[q.a.range], ranges[q.b.range], q.spreadDb.toFixed(3), q.spreadDeg.toFixed(2), q.n, s.applyMatch && match ? 1 : 0].join(','));
    }
    download(new Blob([`${rows.join('\n')}\n`], { type: 'text/csv' }), `dsoquad-${s.mode}-${stamp()}.csv`);
  }

  /** Why the sweep can't be exported as an FRD file, or ''. */
  function frdProblem(r, fit) {
    if (!r.pts.length) return 'No sweep yet';
    if (s.mode === 'level') return 'Only for frequency sweeps';
    if (s.mode === 'impedance') return fit ? '' : 'Needs a driver fit: sweep across the speaker\'s resonance';
    return r.pts.length < MIN_POINTS ? `Needs at least ${MIN_POINTS} points: sweep with more points per decade` : '';
  }

  /** FRD file: the measured B/A (with a microphone on B, a speaker's acoustic response), or in
   * impedance mode the driver's response modelled from its Thiele-Small fit. */
  function saveFrd() {
    const r = runs[s.mode], c = points(r), when = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    let rows, head;
    if (s.mode === 'impedance') {
      const { params: P, derived: D } = driverFit(c);
      rows = driverResponse({ fs: P.fs, Qts: D.Qts });
      head = [`DSO Quad: driver response modelled from an impedance sweep, ${when}`,
        `Re ${P.Re.toFixed(3)} ohm, fs ${P.fs.toFixed(2)} Hz, Qms ${P.Qms.toFixed(3)}, Qes ${D.Qes.toFixed(4)}, Qts ${D.Qts.toFixed(4)}, Le ${(P.Le * 1e3).toFixed(3)} mH`,
        'Small signal, voltage drive, infinite baffle (or a large sealed box): the low-frequency roll-off only.',
        'Break-up, baffle step, directivity and the room are not in it: fit the EQ below a few times fs.'];
    } else {
      rows = c.map((q) => ({ f: q.f, db: q.gainDb, deg: q.phaseDeg }));
      head = [`DSO Quad: frequency response B/A, ${when}`,
        `Channel match ${s.applyMatch && match ? 'applied' : 'not applied'}; stepped sine at ${s.level} % level, ${s.coupling ? 'AC' : 'DC'} coupled`,
        'For a speaker: A on the amplifier input, B on a measurement microphone\'s preamp (level is relative).'];
    }
    download(new Blob([frd(rows, head)], { type: 'text/plain' }), `dsoquad-${s.mode === 'impedance' ? 'driver-model' : 'response'}-${stamp()}.frd`);
  }

  setMode(s.mode);
  return {
    open(on) {
      open = on;
      if (!on) run?.abort();
      applySim();
      update();
      plot.draw();
    },
    /** The device changed (connected, lost, or a different transport): reload its match. */
    async connected() {
      const dev = ctx.getDev();
      if (!dev) { run?.abort(); match = null; }
      applySim();
      update();
      if (dev) {
        try { match = await Match.loadFrom(dev); } catch (e) { match = null; console.warn('channel match:', e.message); }
        update();
      }
    },
  };
}
