// The Analyzer view: sweep setup, wiring diagram, Bode plot, readouts and export. The app
// hands it the device and suspends its own scope while the view is open.
import { download, stamp } from '../export.js';
import { logFreqs, MAX_HZ, MIN_HZ, planSweep } from './sweep.js';
import { runSweep } from './run.js';
import { curve, readouts, refineFreqs } from './response.js';
import { BodePlot } from './plot.js';
import { DUTS } from './duts.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'dsoq.analyzer.v1';
const DEFAULTS = { from: 20, to: 20000, ppd: 10, level: 90, settleMs: 0, average: 2, coupling: 0, refine: true, sim: 'rc' };

const fmtHz = (f) => (!Number.isFinite(f) ? '–' : f >= 1e3 ? `${+(f / 1e3).toPrecision(4)} kHz` : `${+f.toPrecision(4)} Hz`);
const fmtS = (s) => (s < 60 ? `${Math.ceil(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

function load(key, def) {
  try { return { ...def, ...JSON.parse(localStorage.getItem(key)) }; } catch { return { ...def }; }
}
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } }

const PANES = [
  { label: 'Gain', unit: 'dB', key: 'gainDb', steps: [1, 2, 5, 10, 20], minSpan: 6, fmt: (v, hover) => (hover ? v.toFixed(2) : `${+v.toFixed(1)}`) },
  { label: 'Phase', unit: '°', key: 'phaseDeg', steps: [15, 30, 45, 90, 180], minSpan: 90, fmt: (v, hover) => (hover ? v.toFixed(1) : `${Math.round(v)}`) },
];

/**
 * ctx: {getDev() → Device|null, getCal(), getRanges(), getSim() → SimTransport|null,
 *       suspend(on), toast(msg, kind)}
 * Returns {open(on), connected()} for the app.
 */
export function initAnalyzer(ctx) {
  const s = load(STORE_KEY, DEFAULTS);
  let run = null;           // AbortController while sweeping
  let result = load(`${STORE_KEY}.last`, { pts: [] }).pts;       // [{f, freq, h, a, b, …}]
  let reference = load(`${STORE_KEY}.ref`, { pts: [] }).pts;
  const plot = new BodePlot($('an-plot'), PANES);

  // ---------------------------------------------------------------- controls

  const fields = {
    from: $('an-from'), to: $('an-to'), ppd: $('an-ppd'), level: $('an-level'), settleMs: $('an-settle'), average: $('an-average'),
  };
  for (const [k, el] of Object.entries(fields)) {
    el.value = s[k];
    el.onchange = () => {
      let v = Number(el.value);
      if (k === 'from' || k === 'to') v = Math.round(Math.min(MAX_HZ, Math.max(MIN_HZ, v || DEFAULTS[k])));
      s[k] = v; el.value = v;
      save(STORE_KEY, s);
      update();
    };
  }
  $('an-level').oninput = () => { $('an-level-out').textContent = `${$('an-level').value} %`; };
  $('an-level').oninput();
  $('an-refine').checked = s.refine;
  $('an-refine').onchange = () => { s.refine = $('an-refine').checked; save(STORE_KEY, s); };
  const seg = $('an-coupling');
  const syncSeg = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.value) === s.coupling));
  seg.querySelectorAll('button').forEach((b) => { b.onclick = () => { s.coupling = Number(b.value); save(STORE_KEY, s); syncSeg(); }; });
  syncSeg();

  const simSel = $('an-sim');
  simSel.innerHTML = Object.entries(DUTS).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
  simSel.value = s.sim;
  simSel.onchange = () => { s.sim = simSel.value; save(STORE_KEY, s); applySim(); };
  const applySim = () => { const t = ctx.getSim(); if (t) t.dut = open ? s.sim : null; };

  $('an-start').onclick = () => (run ? run.abort() : start());
  $('an-ref-set').onclick = () => { reference = result.slice(); save(`${STORE_KEY}.ref`, { pts: reference }); update(); };
  $('an-ref-clear').onclick = () => { reference = []; save(`${STORE_KEY}.ref`, { pts: [] }); update(); };
  $('an-csv').onclick = saveCsv;
  $('an-png').onclick = () => $('an-plot').toBlob((b) => download(b, `dsoquad-response-${stamp()}.png`));

  let open = false;

  function plan() {
    return planSweep(logFreqs(Math.min(s.from, s.to), Math.max(s.from, s.to), s.ppd), { settle: s.settleMs / 1000, average: s.average });
  }

  function update() {
    const dev = ctx.getDev();
    const p = plan();
    $('an-estimate').textContent = `${p.points.length} points, about ${fmtS(p.seconds)}`;
    $('an-start').textContent = run ? 'Stop' : 'Start sweep';
    $('an-start').classList.toggle('primary', !run);
    $('an-start').disabled = !dev && !run;
    $('an-sim-row').hidden = !ctx.getSim();
    for (const el of [...Object.values(fields), ...seg.querySelectorAll('button'), $('an-refine')]) el.disabled = !!run;
    $('an-ref-set').disabled = !result.length || !!run;
    $('an-ref-clear').disabled = !reference.length;
    $('an-csv').disabled = $('an-png').disabled = !result.length;

    const c = result.length ? curve(result) : [];
    const series = [{ label: reference.length ? 'Now' : '', pts: c }];
    if (reference.length) series.push({ label: 'Ref', pts: curve(reference), color: '#8b949e', dashed: true });
    const r = c.length >= 2 ? readouts(c) : null;
    const markers = r ? [
      { f: r.lowF, label: `−3 dB ${fmtHz(r.lowF)}` }, { f: r.highF, label: `−3 dB ${fmtHz(r.highF)}` },
    ].filter((m) => Number.isFinite(m.f)) : [];
    const xs = [...result, ...reference].map((q) => q.f);
    plot.setData({
      series, markers,
      f0: Math.min(s.from, s.to, ...xs), f1: Math.max(s.from, s.to, ...xs),
    });
    const thdMax = result.length ? Math.max(...result.map((q) => q.a.thd).filter(Number.isFinite)) : NaN;
    $('an-readouts').innerHTML = r ? `
      <dt>Peak</dt><dd>${r.peakDb.toFixed(2)} dB at ${fmtHz(r.peakF)}</dd>
      <dt>−3 dB low</dt><dd>${Number.isFinite(r.lowF) ? fmtHz(r.lowF) : 'below the sweep'}</dd>
      <dt>−3 dB high</dt><dd>${Number.isFinite(r.highF) ? fmtHz(r.highF) : 'above the sweep'}</dd>
      <dt>Source THD</dt><dd>${Number.isFinite(thdMax) ? `≤ ${(100 * thdMax).toFixed(1)} % (the generator's own)` : '–'}</dd>
      <dt>Clipped</dt><dd>${result.some((q) => q.a.clip || q.b.clip) ? '<span class="err">yes: some points are unreliable</span>' : 'no'}</dd>`
      : '<dt>Results</dt><dd>–</dd>';
  }

  async function start() {
    const dev = ctx.getDev();
    if (!dev) return;
    const { points } = plan();
    run = new AbortController();
    result = [];
    update();
    const t0 = performance.now();
    const prog = $('an-progress');
    prog.max = points.length; prog.value = 0;
    const msg = (t) => { $('an-msg').textContent = t; };
    msg(`Starting (${points.length} points)…`);
    const sweepCtx = { dev, cal: ctx.getCal(), ranges: ctx.getRanges(), amp: s.level / 100, coupling: s.coupling };
    const opts = { settle: s.settleMs / 1000, average: s.average };
    const add = (p) => { result.push(p); result.sort((a, b) => a.f - b.f); update(); };
    try {
      await runSweep(sweepCtx, points, opts, (p, i, n) => {
        add(p);
        prog.value = i;
        msg(`${i} / ${n}: ${fmtHz(p.f)}`);
      }, run.signal);
      // Refine: more points where the readouts are interpolated (the −3 dB points and the peak).
      const extra = s.refine && result.length >= 3 ? planSweep(refineFreqs(curve(result), readouts(curve(result)))).points : [];
      if (extra.length) {
        prog.max = points.length + extra.length;
        await runSweep(sweepCtx, extra, opts, (p, i, n) => {
          add(p);
          prog.value = points.length + i;
          msg(`Refining ${i} / ${n}: ${fmtHz(p.f)}`);
        }, run.signal);
      }
      msg(`Done: ${result.length} points in ${fmtS((performance.now() - t0) / 1000)}`);
    } catch (e) {
      if (e.name === 'AbortError') msg(`Stopped after ${result.length} points`);
      else { msg(''); ctx.toast(`Sweep failed: ${e.message}`); }
      try { await dev.setGen(0, 1000, 50); } catch { /* disconnected */ }
    } finally {
      run = null;
      save(`${STORE_KEY}.last`, { pts: result });
      update();
    }
  }

  function saveCsv() {
    const c = curve(result);
    const rows = [['freq_set_hz', 'freq_hz', 'a_vpk', 'b_vpk', 'gain_vv', 'gain_db', 'phase_deg', 'a_thd_pct', 'b_thd_pct', 'a_vdiv', 'b_vdiv', 'spread_db', 'spread_deg', 'readings'].join(',')];
    const ranges = ctx.getRanges();
    for (const q of c) {
      rows.push([q.freq, q.f.toPrecision(8), q.a.amp.toPrecision(5), q.b.amp.toPrecision(5), q.gain.toPrecision(6), q.gainDb.toFixed(3),
        q.phaseDeg.toFixed(2), (100 * q.a.thd).toFixed(2), (100 * q.b.thd).toFixed(2), ranges[q.a.range], ranges[q.b.range],
        q.spreadDb.toFixed(3), q.spreadDeg.toFixed(2), q.n].join(','));
    }
    download(new Blob([`${rows.join('\n')}\n`], { type: 'text/csv' }), `dsoquad-response-${stamp()}.csv`);
  }

  update();
  return {
    open(on) {
      open = on;
      if (!on) run?.abort();
      applySim();
      update();
      plot.draw();
    },
    /** The device changed (connected, lost, or a different transport). */
    connected() { if (!ctx.getDev()) run?.abort(); applySim(); update(); },
  };
}
