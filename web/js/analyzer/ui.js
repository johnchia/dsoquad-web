// The Analyzer view: frequency response (B/A) and impedance (Z = R·B/(A−B)) sweeps, the channel
// match, wiring diagrams, plots, readouts and export. The app hands it the device and suspends
// its own scope while the view is open.
import { download, stamp } from '../export.js';
import { logFreqs, MAX_HZ, MIN_HZ, planPoint, planSweep } from './sweep.js';
import { measureDc, measureRangeGains, runSweep } from './run.js';
import { curve, phaseCrossings, readouts, refineFreqs } from './response.js';
import { BodePlot } from './plot.js';
import { DUTS } from './duts.js';
import { cabs, carg, cx } from './detect.js';
import * as Match from './match.js';
import { fitDriver, impedance, model, reFromDc } from './speaker.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'dsoq.analyzer.v1';
const DEFAULTS = {
  mode: 'response', from: 20, to: 20000, ppd: 10, level: 90, settleMs: 0, average: 2, coupling: 0, refine: true,
  applyMatch: true, R: 47, zFrom: 10, zTo: 20000, sim: 'rc',
};
const MODES = { response: 'Frequency response', impedance: 'Impedance' };
const SIM_FOR = { response: 'rc', impedance: 'speaker' };

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
};

/**
 * ctx: {getDev() → Device|null, getCal(), getRanges(), getSim() → SimTransport|null, toast(msg, kind)}
 * Returns {open(on), connected()} for the app.
 */
export function initAnalyzer(ctx) {
  const s = load(STORE_KEY, DEFAULTS);
  let run = null;             // AbortController while sweeping
  let busy = '';              // what's running (for the status line)
  // Raw sweeps per mode ({pts, R} with pts' h = B/A without the match), and reference sweeps.
  const runs = load(`${STORE_KEY}.runs`, { response: { pts: [] }, impedance: { pts: [], R: s.R, reDc: null } });
  const refs = load(`${STORE_KEY}.refs`, { response: { pts: [] }, impedance: { pts: [], R: s.R } });
  let match = null;           // channel match from the device
  let open = false;
  const plot = new BodePlot($('an-plot'), PANES[s.mode]);

  // ---------------------------------------------------------------- controls

  const fields = {
    from: $('an-from'), to: $('an-to'), ppd: $('an-ppd'), level: $('an-level'), settleMs: $('an-settle'), average: $('an-average'), R: $('an-r'),
  };
  const key = (k) => (s.mode === 'impedance' && (k === 'from' || k === 'to') ? (k === 'from' ? 'zFrom' : 'zTo') : k);
  const fillFields = () => { for (const [k, el] of Object.entries(fields)) el.value = s[key(k)]; };
  for (const [k, el] of Object.entries(fields)) {
    el.onchange = () => {
      let v = Number(el.value);
      if (k === 'from' || k === 'to') v = Math.round(Math.min(MAX_HZ, Math.max(MIN_HZ, v || DEFAULTS[key(k)])));
      if (k === 'R') v = v > 0 ? v : DEFAULTS.R;
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
  $('an-apply-match').checked = s.applyMatch;
  $('an-apply-match').onchange = () => { s.applyMatch = $('an-apply-match').checked; save(STORE_KEY, s); update(); };

  const segSync = (id, v) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.value === String(v)));
  $('an-coupling').querySelectorAll('button').forEach((b) => { b.onclick = () => { s.coupling = Number(b.value); save(STORE_KEY, s); update(); }; });
  $('an-mode').querySelectorAll('button').forEach((b) => { b.onclick = () => setMode(b.value); });

  const simSel = $('an-sim');
  simSel.innerHTML = Object.entries(DUTS).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
  simSel.value = s.sim;
  simSel.onchange = () => { s.sim = simSel.value; save(STORE_KEY, s); applySim(); };
  const applySim = (dut = s.sim) => { const t = ctx.getSim(); if (t) t.dut = open ? dut : null; };

  $('an-start').onclick = () => (run ? run.abort() : start());
  $('an-ref-set').onclick = () => { refs[s.mode] = structuredClone(runs[s.mode]); save(`${STORE_KEY}.refs`, refs); update(); };
  $('an-ref-clear').onclick = () => { refs[s.mode] = { pts: [], R: s.R }; save(`${STORE_KEY}.refs`, refs); update(); };
  $('an-csv').onclick = saveCsv;
  $('an-png').onclick = () => $('an-plot').toBlob((b) => download(b, `dsoquad-${s.mode}-${stamp()}.png`));
  $('an-match-measure').onclick = measureMatch;
  $('an-match-delete').onclick = deleteMatch;
  $('an-re-dc').onclick = measureRe;
  $('an-re-clear').onclick = () => { runs.impedance.reDc = null; save(`${STORE_KEY}.runs`, runs); update(); };

  function setMode(m) {
    if (run || !MODES[m]) return;
    s.mode = m;
    // In the simulator, switch to a circuit that suits the mode.
    if (ctx.getSim() && SIM_FOR[m] && s.sim !== SIM_FOR[m] && s.sim !== 'through') { s.sim = SIM_FOR[m]; simSel.value = s.sim; applySim(); }
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

  /** Readouts to refine in each mode: the −3 dB points, or for |Z| the √r0 points (half the
   * peak's height in dB above the base). */
  function refineReadouts(c) {
    if (s.mode !== 'impedance') return readouts(c);
    const r = readouts(c);
    const base = Math.min(...c.slice(0, r.peakIndex + 1).map((q) => q.gainDb));
    return readouts(c, { drop: (r.peakDb - base) / 2 });
  }

  // ---------------------------------------------------------------- view

  function plan() {
    const from = s[key('from')], to = s[key('to')];
    return planSweep(logFreqs(Math.min(from, to), Math.max(from, to), s.ppd), { settle: s.settleMs / 1000, average: s.average });
  }

  function update() {
    const dev = ctx.getDev(), imp = s.mode === 'impedance';
    const p = plan();
    segSync('an-mode', s.mode);
    segSync('an-coupling', s.coupling);
    $('an-mode-legend').textContent = MODES[s.mode];
    $('an-wiring-response').hidden = imp;
    $('an-wiring-impedance').hidden = !imp;
    for (const id of ['an-r-row', 'an-re-row']) $(id).hidden = !imp;
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
    let markers = [], html;
    if (!imp) {
      const q = c.length >= 2 ? readouts(c) : null;
      if (q) markers = [{ f: q.lowF, label: `−3 dB ${fmtHz(q.lowF)}` }, { f: q.highF, label: `−3 dB ${fmtHz(q.highF)}` }].filter((m) => Number.isFinite(m.f));
      const thdMax = c.length ? Math.max(...r.pts.map((x) => x.a.thd).filter(Number.isFinite)) : NaN;
      html = q ? `
        <dt>Peak</dt><dd>${q.peakDb.toFixed(2)} dB at ${fmtHz(q.peakF)}</dd>
        <dt>−3 dB low</dt><dd>${Number.isFinite(q.lowF) ? fmtHz(q.lowF) : 'below the sweep'}</dd>
        <dt>−3 dB high</dt><dd>${Number.isFinite(q.highF) ? fmtHz(q.highF) : 'above the sweep'}</dd>
        ${[-45, 45].flatMap((d) => phaseCrossings(c, d).map((f) => `<dt>${d > 0 ? '+' : '−'}45° at</dt><dd>${fmtHz(f)} <span class="note">(fc of a 1st-order ${d < 0 ? 'low' : 'high'}-pass)</span></dd>`)).join('')}
        <dt>Source THD</dt><dd>${Number.isFinite(thdMax) ? `≤ ${(100 * thdMax).toFixed(1)} % (the generator's own)` : '–'}</dd>` : '';
    } else if (c.length) {
      const lo = c.reduce((a, b) => (b.zAbs < a.zAbs ? b : a)), hi = c.reduce((a, b) => (b.zAbs > a.zAbs ? b : a));
      const fit = driverFit(c);
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
    }
    if (html && r.pts.some((x) => x.a.clip || x.b.clip)) html += '<dt>Clipped</dt><dd><span class="err">yes: some points are unreliable</span></dd>';
    $('an-readouts').innerHTML = html || '<dt>Results</dt><dd>–</dd>';
    const xs = [...r.pts, ...ref.pts].map((q) => q.f), from = s[key('from')], to = s[key('to')];
    plot.setData({ series, markers, f0: Math.min(from, to, ...xs), f1: Math.max(from, to, ...xs) });
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
        const extra = s.refine && c.length >= 3 ? planSweep(refineFreqs(c, refineReadouts(c))).points : [];
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
    const head = s.mode === 'impedance'
      ? ['freq_set_hz', 'freq_hz', 'z_ohm', 'z_phase_deg', 'z_re_ohm', 'z_im_ohm']
      : ['freq_set_hz', 'freq_hz', 'gain_vv', 'gain_db', 'phase_deg'];
    const rows = [[...head, 'a_vpk', 'b_vpk', 'a_thd_pct', 'b_thd_pct', 'a_vdiv', 'b_vdiv', 'spread_db', 'spread_deg', 'readings', 'match_applied'].join(',')];
    for (const q of c) {
      const main = s.mode === 'impedance'
        ? [q.zAbs.toPrecision(6), q.phaseDeg.toFixed(2), q.z.re.toPrecision(6), q.z.im.toPrecision(6)]
        : [q.gain.toPrecision(6), q.gainDb.toFixed(3), q.phaseDeg.toFixed(2)];
      rows.push([q.freq, q.f.toPrecision(8), ...main, q.a.amp.toPrecision(5), q.b.amp.toPrecision(5), (100 * q.a.thd).toFixed(2), (100 * q.b.thd).toFixed(2),
        ranges[q.a.range], ranges[q.b.range], q.spreadDb.toFixed(3), q.spreadDeg.toFixed(2), q.n, s.applyMatch && match ? 1 : 0].join(','));
    }
    download(new Blob([`${rows.join('\n')}\n`], { type: 'text/csv' }), `dsoquad-${s.mode}-${stamp()}.csv`);
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
