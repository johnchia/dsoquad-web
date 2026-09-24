// DSO Quad web UI: settings (owned by the page, persisted in localStorage and pushed to the
// device on connect), connection handling, rendering and measurements.
import * as P from './protocol.js';
import { Device, DeviceError } from './device.js';
import { PlaybackTransport, SerialTransport, SimTransport } from './transport.js';
import { COLORS, HDIV, ScopeView, fmtSI } from './view.js';
import * as Cal from './calibration.js';
import { openCalDialog } from './cal-ui.js';
import * as Gen from './wavegen.js';
import { WINDOWS, peak as fftPeak, spectrum } from './fft.js';
import { SpectrumView } from './spectrum.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SAMPLES_PER_DIV = 200;   // 10 div use 2000 of the 4096 samples; the rest is pan room
const TDIVS = [];
for (let e = -7; e <= 0; e++) for (const m of [1, 2, 5]) TDIVS.push(+(m * 10 ** e).toPrecision(1));
TDIVS.splice(TDIVS.indexOf(2), 2);  // up to 1 s/div
const FALLBACK_RANGES = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
const STORE_KEY = 'dsoq.settings.v1';

const DEFAULTS = {
  ch: [{ on: true, range: 4, coupling: 0, posDiv: 5 }, { on: true, range: 4, coupling: 0, posDiv: 2 }],
  digital: false,
  tdiv: 1e-3,
  trigPosDiv: 1,
  trig: { source: 0, kind: 1, levelDiv: 0.5, widthUs: 10 },
  mode: 'auto',
  running: true,
  gen: { shape: 'off', freq: 1000, duty: 50, amp: 100, offset: 50 },
  fft: { on: false, window: 'hann', scale: 'db', span: 1, avg: 1 },
  backlight: 50,
};

// ------------------------------------------------------------------ state

let settings = loadSettings();
let cal = Cal.nominal();   // vertical calibration, read from the device's flash store
let calSupported = false;  // firmware >= 0.4 has the store
let calibrating = false;   // the calibration dialog drives the device; the app keeps off
const live = () => (calibrating ? null : dev);
let ranges = FALLBACK_RANGES.slice();
let dev = null;            // connected Device
let persist = true;        // false during playback: its settings aren't the user's
let userDisconnected = false;
let singleArmed = false;
let lastFrame = null, lastFrameAt = 0;
const frameTimes = [];
let pollTimer = null;

function merge(def, v) {
  if (Array.isArray(def)) return def.map((d, i) => merge(d, Array.isArray(v) ? v[i] : undefined));
  if (def && typeof def === 'object') {
    const out = {};
    for (const k of Object.keys(def)) out[k] = merge(def[k], v && typeof v === 'object' ? v[k] : undefined);
    return out;
  }
  return typeof v === typeof def ? v : def;
}

function loadSettings() {
  try { return merge(DEFAULTS, JSON.parse(localStorage.getItem(STORE_KEY))); } catch { return merge(DEFAULTS, null); }
}

function saveSettings() {
  if (!persist) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// ------------------------------------------------------------------ derived values

const sampleRate = () => Math.min(P.MAX_RATE, SAMPLES_PER_DIV / settings.tdiv);
/** Offset register that puts the channel's 0 V at its position marker. */
const offsetCode = (ch) => Cal.offsetFor(cal, ch, settings.ch[ch].range, P.ADC_ZERO + settings.ch[ch].posDiv * P.CODES_PER_DIV);

/** Code of 0 V and codes per division for a channel as captured in a frame. */
function frameScale(ch, fc) {
  return { zero: Cal.zeroCode(cal, ch, fc.range, fc.offset), cpd: Cal.codesPerDiv(cal, ch, fc.range) };
}
const autoMs = () => Math.round(clamp(20 * settings.tdiv * 1000, 100, 60000));
const isPulse = (kind) => kind >= 4;

function trigLevelCode() {
  const t = settings.trig;
  if (t.source > 1) return 128;
  const c = settings.ch[t.source];
  const zero = Cal.zeroCode(cal, t.source, c.range, offsetCode(t.source));
  return Math.round(clamp(zero + t.levelDiv * Cal.codesPerDiv(cal, t.source, c.range), 0, 255));
}

function trigWidthSamples() {
  return Math.round(clamp(settings.trig.widthUs * 1e-6 * P.actualRate(sampleRate()), 0, 65535));
}

function acqMode() {
  if (!settings.running) return P.ACQ_STOP;
  return settings.mode === 'normal' ? P.ACQ_NORMAL : P.ACQ_AUTO;
}

// ------------------------------------------------------------------ device commands

function report(e) {
  if (e instanceof DeviceError && !dev?.connected) return;  // disconnect already reported
  toast(e.message || String(e));
}

const send = {
  channel(i) {
    const c = settings.ch[i];
    live()?.setChannel(i, c.range, c.coupling, offsetCode(i)).catch(report);
    if (settings.trig.source === i) send.trigger();  // level follows the channel's zero
  },
  rate() {
    live()?.setRate(sampleRate()).catch(report);
    send.trigger();   // pulse width is in samples
    send.acq();       // auto timeout scales with the timebase
  },
  trigger() {
    const t = settings.trig;
    live()?.setTrigger(t.source, t.kind, trigLevelCode(), trigWidthSamples()).catch(report);
  },
  acq() { if (!singleArmed) live()?.setAcq(acqMode(), autoMs()).catch(report); },
  gen() {
    const g = settings.gen, d = live();
    if (!d) return;
    if (g.shape === 'off' || g.shape === 'square') {
      d.setGen(g.shape === 'off' ? P.GEN_OFF : P.GEN_SQUARE, g.freq, g.duty).catch(report);
      return;
    }
    const plan = Gen.planPoints(g.freq);
    if (!plan) { toast(`Analog output goes up to ${fmtSI(Gen.MAX_ANALOG_HZ, 'Hz')}`); return; }
    d.setGenWave(Gen.table(g.shape, plan.n, g.amp / 100, g.offset / 100), g.freq).catch(report);
  },
  system() { live()?.setSystem(settings.backlight, 255).catch(report); },
  all() { send.channel(0); send.channel(1); send.rate(); send.gen(); send.system(); },
};

/** After editing `settings`: send what changed, persist, refresh the UI. */
function changed(apply) {
  apply?.();
  saveSettings();
  syncControls();
  view.invalidate();
}

// ------------------------------------------------------------------ connection

async function connect(transport) {
  if (dev) await disconnect(false);
  userDisconnected = false;
  persist = !(transport instanceof PlaybackTransport);
  if (!persist) settings = loadSettings();
  status(`Connecting (${transport.label})…`);
  const d = new Device(transport);
  try {
    await d.open();
    dev = d;
    d.addEventListener('frame', (e) => onFrame(e.detail));
    d.addEventListener('disconnect', (e) => onLost(e.detail));
    const info = await d.hello();
    $('dev-fw').textContent = info.fw;
    $('dev-serial').textContent = info.serial;
    if (info.proto !== 1) toast(`Device speaks protocol v${info.proto}; this page expects v1`);
    const t = await d.tables();
    if (t[1]?.length) ranges = t[1].map((r) => r.voltsPerDiv);
    fillRangeSelects();
    try {
      cal = await Cal.loadFrom(d);
      calSupported = true;
    } catch (e) {
      cal = Cal.nominal();
      calSupported = false;
      console.warn('no calibration store:', e.message);
    }
    if (!persist) adoptState(await d.state());
    singleArmed = false;
    send.all();
    status(`Connected · ${transport.label}`, 'ok');
    pollTimer = setInterval(pollState, 1000);
    pollState();
  } catch (e) {
    toast(`Connect failed: ${e.message || e}`);
    status('Disconnected', 'err');
    if (dev === d) dev = null;
    try { await d.close(); } catch { /* already closed */ }
  }
  syncControls();
}

async function disconnect(byUser = true) {
  userDisconnected = byUser;
  clearInterval(pollTimer);
  const d = dev;
  dev = null;
  if (d) {
    try { await d.setAcq(P.ACQ_STOP, 100); } catch { /* going anyway */ }
    await d.close();
  }
  persist = true;
  settings = loadSettings();
  cal = Cal.nominal();
  status('Disconnected');
  syncControls();
}

function onLost(reason) {
  clearInterval(pollTimer);
  dev = null;
  calibrating = false;
  document.getElementById('cal-dialog').close();
  status('Device lost, will reconnect when it reappears', 'err');
  console.warn('disconnected:', reason);
  syncControls();
}

/** Playback: show the recording's settings instead of pushing ours. */
function adoptState(st) {
  st.ch.forEach((c, i) => Object.assign(settings.ch[i], { range: c.range, coupling: c.coupling, posDiv: (c.offset - P.ADC_ZERO) / P.CODES_PER_DIV }));
  const want = SAMPLES_PER_DIV / st.rateActual;
  settings.tdiv = TDIVS.reduce((a, b) => (Math.abs(Math.log(b / want)) < Math.abs(Math.log(a / want)) ? b : a));
  Object.assign(settings.trig, {
    source: st.trigSource, kind: st.trigKind,
    levelDiv: st.trigSource < 2 ? (st.trigLevel - st.ch[st.trigSource].offset) / P.CODES_PER_DIV : 0,
  });
}

async function pollState() {
  if (!dev) return;
  try {
    const st = await dev.state();
    if (st.batteryMv != null) {
      const pct = clamp(Math.round((st.batteryMv - 3500) / (4150 - 3500) * 100), 0, 100);
      $('dev-battery').textContent = `${(st.batteryMv / 1000).toFixed(2)} V (~${pct}%)${st.charging ? ' · charging' : ''}`;
      $('dev-uptime').textContent = fmtDuration(st.uptimeS);
    } else {
      $('dev-battery').textContent = 'needs firmware ≥ 0.3';
    }
    // Self-heal: the device stops on its own if it thinks the host went away.
    if (!calibrating && settings.running && !singleArmed && st.acqMode === P.ACQ_STOP) send.acq();
  } catch (e) { report(e); }
}

// ------------------------------------------------------------------ frames

// ------------------------------------------------------------------ FFT

let fftAvg = [null, null], fftKey = '', fftTraces = [];

function fftReset() { fftAvg = [null, null]; fftTraces = []; spectrumView.invalidate(); }

/** Spectrum of each shown channel, power-averaged over settings.fft.avg frames. */
function updateSpectrum(f) {
  const s = settings.fft;
  const key = `${f.rate}/${f.ch.map((c) => `${c.range}.${c.coupling}`).join()}/${s.window}/${s.avg}`;
  if (key !== fftKey) { fftKey = key; fftAvg = [null, null]; }
  fftTraces = [];
  [[f.a, 0], [f.b, 1]].forEach(([codes, i]) => {
    if (!settings.ch[i].on) return;
    const { zero, cpd } = frameScale(i, f.ch[i]);
    const k = (ranges[f.ch[i].range] ?? 1) / cpd;
    const x = new Float64Array(codes.length - P.STALE_SAMPLES);
    for (let j = 0; j < x.length; j++) x[j] = (codes[j + P.STALE_SAMPLES] - zero) * k;
    const sp = spectrum(x, s.window);
    let acc = fftAvg[i];
    if (!acc || acc.length !== sp.rms.length) acc = fftAvg[i] = Float64Array.from(sp.rms, (v) => v * v);
    else { const a = 1 / s.avg; for (let j = 0; j < acc.length; j++) acc[j] += (sp.rms[j] ** 2 - acc[j]) * a; }
    const rms = Float64Array.from(acc, Math.sqrt);
    const binHz = sp.binHz(f.rate);
    fftTraces.push({ name: 'AB'[i], color: COLORS[i ? 'b' : 'a'], rms, binHz, peak: fftPeak(rms) });
  });
  spectrumView.invalidate();
}

function onFrame(f) {
  lastFrame = f;
  if (settings.fft.on) updateSpectrum(f);
  lastFrameAt = performance.now();
  frameTimes.push(lastFrameAt);
  while (frameTimes.length && frameTimes[0] < lastFrameAt - 2000) frameTimes.shift();
  if (f.last || (singleArmed && f.triggered)) {
    singleArmed = false;
    settings.running = false;
    syncControls();
  }
  view.invalidate();
  scheduleMeasure();
}

let measurePending = false, lastMeasure = 0;
function scheduleMeasure() {
  if (measurePending) return;
  measurePending = true;
  setTimeout(() => { measurePending = false; lastMeasure = performance.now(); updateReadouts(); }, Math.max(0, 250 - (performance.now() - lastMeasure)));
}

/** Measurements in volts; `zero` is the code of 0 V and `cpd` the codes per division. */
function measure(codes, zero, cpd, vdiv, rate) {
  const offset = zero;
  let lo = 255, hi = 0, sum = 0, sq = 0;
  for (const c of codes) { if (c < lo) lo = c; if (c > hi) hi = c; sum += c; sq += c * c; }
  const n = codes.length, k = vdiv / cpd;
  const mean = sum / n;
  // Frequency from mid-level crossings with hysteresis (8-bit noise is a few codes).
  let freq = NaN;
  if (hi - lo >= 8) {
    const mid = (lo + hi) / 2, hyst = (hi - lo) / 8;
    const rises = [];
    let armed = false;
    for (let i = 0; i < n; i++) {
      if (codes[i] < mid - hyst) armed = true;
      else if (armed && codes[i] > mid + hyst) { rises.push(i); armed = false; }
    }
    if (rises.length >= 2) freq = (rises.length - 1) * rate / (rises[rises.length - 1] - rises[0]);
  }
  return {
    max: (hi - offset) * k, min: (lo - offset) * k, pp: (hi - lo) * k, mean: (mean - offset) * k,
    rms: Math.sqrt(Math.max(0, sq / n - 2 * offset * mean + offset * offset)) * k,
    freq, clipped: lo === 0 || hi === 255,
  };
}

function updateReadouts() {
  const now = performance.now();
  const fps = frameTimes.length > 1 ? (frameTimes.length - 1) / ((frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000) : 0;
  $('fps').textContent = `${fps.toFixed(1)} fps`;
  const f = lastFrame;
  $('frame-no').textContent = f ? `frame ${f.frameNo}` : 'frame –';
  $('rate').textContent = `${fmtSI(f ? f.rate : P.actualRate(sampleRate()), 'S/s')}`;

  const badge = $('trig-status');
  const frameTime = 4096 / P.actualRate(sampleRate()) * 1000;
  const stale = now - lastFrameAt > Math.max(600, 3 * frameTime);
  let text = 'Stop', cls = '';
  if (dev && singleArmed) { text = 'Armed'; cls = 'wait'; } else if (dev && settings.running) {
    if (!f || stale) { text = settings.mode === 'normal' ? 'Waiting' : 'Acquiring'; cls = 'wait'; } else if (f.auto) { text = 'Auto'; cls = 'auto'; } else { text = "Trig'd"; cls = 'trig'; }
  }
  badge.textContent = text;
  badge.className = `badge ${cls}`;

  const out = $('measure');
  out.replaceChildren();
  if (!f) return;
  const peaks = new Map(fftTraces.map((t) => [t.name, t]));
  [['A', f.a, 0], ['B', f.b, 1]].forEach(([name, codes, i]) => {
    if (!settings.ch[i].on) return;
    const { zero, cpd } = frameScale(i, f.ch[i]);
    const m = measure(codes.subarray(P.STALE_SAMPLES), zero, cpd, ranges[f.ch[i].range] ?? 1, f.rate);
    const div = document.createElement('div');
    div.className = `ch ch-${name.toLowerCase()}`;
    const parts = [
      `<b>${name}</b>`, `Vpp ${fmtSI(m.pp, 'V')}`, `Vavg ${fmtSI(m.mean, 'V')}`, `Vrms ${fmtSI(m.rms, 'V')}`,
      `Max ${fmtSI(m.max, 'V')}`, `Min ${fmtSI(m.min, 'V')}`, `Freq ${Number.isFinite(m.freq) ? fmtSI(m.freq, 'Hz', 5) : '--'}`,
    ];
    const t = settings.fft.on && peaks.get(name);
    if (t) parts.push(`FFT peak ${fmtSI(t.peak.bin * t.binHz, 'Hz', 4)} ${(20 * Math.log10(Math.max(t.peak.rms, 1e-9))).toFixed(1)} dBV`);
    if (m.clipped) parts.push('<span style="color:var(--err)">clipped</span>');
    div.innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
    out.append(div);
  });
}
setInterval(scheduleMeasure, 500);  // keeps the status badge current when frames stop

// ------------------------------------------------------------------ view

const view = new ScopeView($('scope'), () => ({
  frame: lastFrame,
  ch: settings.ch,
  digital: { on: settings.digital },
  trig: { source: settings.trig.source, levelDiv: settings.trig.levelDiv, posDiv: settings.trigPosDiv },
  tdiv: settings.tdiv,
  vdivs: settings.ch.map((c) => ranges[c.range] ?? 1),
  scale: frameScale,
}), (id, value) => {
  if (id === 'pos0' || id === 'pos1') {
    const i = +id[3];
    settings.ch[i].posDiv = +clamp(value, 0, 8).toFixed(2);
    changed(() => send.channel(i));
  } else if (id === 'trigLevel') {
    const src = settings.ch[settings.trig.source];
    settings.trig.levelDiv = +clamp(value - src.posDiv, -8, 8).toFixed(2);
    changed(send.trigger);
  } else if (id === 'trigPos') {
    settings.trigPosDiv = +clamp(value, 0, HDIV).toFixed(2);
    changed();
  }
});

const spectrumView = new SpectrumView($('spectrum'), () => {
  if (!fftTraces.length) return null;
  const vmax = Math.max(...settings.ch.map((c, i) => (c.on ? ranges[c.range] ?? 1 : 0)));
  const fsRms = 4 * vmax / Math.SQRT2;   // full-screen sine
  return {
    traces: fftTraces,
    span: P.actualRate(sampleRate()) / 2 * settings.fft.span,
    scale: settings.fft.scale,
    refDb: Math.ceil(20 * Math.log10(fsRms) / 10) * 10,
    linMax: fsRms,
  };
});

// ------------------------------------------------------------------ controls

function fillRangeSelects() {
  for (const p of ['a', 'b']) {
    const sel = $(`${p}-range`);
    sel.replaceChildren(...ranges.map((v, i) => new Option(fmtSI(v, 'V'), i)));
  }
}

function fillFftSelects() {
  $('fft-window').replaceChildren(...Object.entries(WINDOWS).map(([k, w]) => new Option(w.label, k)));
  $('fft-span').replaceChildren(...[1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01].map((v) => new Option(String(v), v)));
}

/** What the generator actually outputs (integer timer dividers), for the panel. */
function genActualText() {
  const g = settings.gen;
  if (g.shape === 'off') return '';
  if (g.shape === 'square') {
    const psc = Math.floor(Math.floor(P.TIMER_HZ / 65536) / g.freq);
    const arr = Math.max(1, Math.floor((Math.floor(P.TIMER_HZ / (psc + 1)) + Math.floor(g.freq / 2)) / g.freq) - 1);
    return `actual ${fmtSI(P.TIMER_HZ / ((psc + 1) * (arr + 1)), 'Hz', 6)}`;
  }
  const plan = Gen.planPoints(g.freq);
  return plan ? `actual ${fmtSI(plan.actual, 'Hz', 6)} · ${plan.n} points/period` : `max ${fmtSI(Gen.MAX_ANALOG_HZ, 'Hz')} for analog shapes`;
}

function fillTdiv() {
  $('tdiv').replaceChildren(...TDIVS.map((t) => new Option(fmtSI(t, 's'), t)));
}

function segSet(name, value) {
  document.querySelectorAll(`.seg[data-for="${name}"] button`).forEach((b) => b.classList.toggle('active', b.value === String(value)));
}

function syncControls() {
  const s = settings;
  ['a', 'b'].forEach((p, i) => {
    const c = s.ch[i];
    $(`${p}-on`).checked = c.on;
    $(`${p}-range`).value = c.range;
    segSet(`${p}-coupling`, c.coupling);
    $(`${p}-pos`).value = c.posDiv;
    $(`${p}-pos-out`).textContent = `${c.posDiv.toFixed(2)} div`;
    $(`scale-${p}`).textContent = `${p.toUpperCase()} ${fmtSI(ranges[c.range] ?? 1, 'V')}/div ${c.coupling ? 'AC' : 'DC'}`;
    $(`scale-${p}`).style.opacity = c.on ? 1 : 0.4;
  });
  $('dig-on').checked = s.digital;
  $('tdiv').value = s.tdiv;
  $('tpos').value = s.trigPosDiv;
  $('tpos-out').textContent = `${s.trigPosDiv.toFixed(1)} div`;
  $('scale-t').textContent = `${fmtSI(s.tdiv, 's')}/div`;

  const t = s.trig;
  segSet('trig-source', t.source);
  $('trig-kind').value = t.kind;
  $('trig-level-row').hidden = t.source > 1;
  $('trig-level').value = t.levelDiv;
  const vdiv = ranges[s.ch[Math.min(t.source, 1)].range] ?? 1;
  $('trig-level-out').textContent = fmtSI(t.levelDiv * vdiv, 'V');
  $('trig-width-row').hidden = !isPulse(t.kind);
  if (document.activeElement !== $('trig-width')) $('trig-width').value = t.widthUs;
  const kindName = $('trig-kind').selectedOptions[0]?.textContent ?? '';
  $('scale-trig').textContent = `T ${'ABCD'[t.source]} ${kindName.toLowerCase()}${t.source < 2 ? ` ${fmtSI(t.levelDiv * vdiv, 'V')}` : ''}`;

  const g = s.gen, analog = g.shape !== 'off' && g.shape !== 'square';
  segSet('gen-shape', g.shape);
  if (document.activeElement !== $('gen-freq')) $('gen-freq').value = g.freq;
  $('gen-freq').max = analog ? Gen.MAX_ANALOG_HZ : 8e6;
  $('gen-duty-row').hidden = g.shape !== 'square';
  $('gen-amp-row').hidden = $('gen-offset-row').hidden = !analog;
  $('gen-duty').value = g.duty;
  $('gen-duty-out').textContent = `${g.duty}%`;
  $('gen-amp').value = g.amp;
  $('gen-amp-out').textContent = `${g.amp}%`;
  $('gen-offset').value = g.offset;
  $('gen-offset-out').textContent = `${g.offset}%`;
  $('gen-actual').textContent = genActualText();

  const f = s.fft;
  $('fft-on').checked = f.on;
  $('spectrum').hidden = !f.on;
  $('fft-window').value = f.window;
  segSet('fft-scale', f.scale);
  const nyq = P.actualRate(sampleRate()) / 2;
  [...$('fft-span').options].forEach((o) => { o.textContent = `${fmtSI(nyq * +o.value, 'Hz', 3)}${+o.value === 1 ? ' (full)' : ''}`; });
  $('fft-span').value = f.span;
  $('fft-avg').value = f.avg;
  $('backlight').value = s.backlight;
  $('backlight-out').textContent = s.backlight ? `${s.backlight}%` : 'off';

  $('trig-mode').value = s.mode;
  const run = $('run');
  run.textContent = s.running ? 'Stop' : 'Run';
  run.classList.toggle('running', s.running);
  run.disabled = $('single').disabled = !dev;
  $('connect').textContent = dev ? 'Disconnect' : 'Connect';
  $('connect').classList.toggle('primary', !dev);
  $('source').disabled = !!dev;
  if (!dev) {
    ['dev-fw', 'dev-serial', 'dev-battery', 'dev-uptime', 'dev-cal'].forEach((id) => { $(id).textContent = '–'; });
  } else {
    const st = Cal.status(cal);
    $('dev-cal').textContent = !calSupported ? 'needs firmware ≥ 0.4'
      : { none: 'none', zero: 'zero only', partial: 'zero, some gains', full: 'zero and gain' }[st]
        + (cal.created ? ` (${cal.created.slice(0, 10)})` : '');
  }
  $('calibrate').disabled = !dev || !calSupported;
  updateReadouts();
}

function bind() {
  ['a', 'b'].forEach((p, i) => {
    $(`${p}-on`).onchange = (e) => { settings.ch[i].on = e.target.checked; saveSettings(); syncControls(); view.invalidate(); };
    $(`${p}-range`).onchange = (e) => { settings.ch[i].range = +e.target.value; changed(() => send.channel(i)); };
    $(`${p}-pos`).oninput = (e) => { settings.ch[i].posDiv = +e.target.value; changed(() => send.channel(i)); };
  });
  $('dig-on').onchange = (e) => { settings.digital = e.target.checked; saveSettings(); view.invalidate(); };
  $('tdiv').onchange = (e) => { settings.tdiv = +e.target.value; changed(send.rate); };
  $('tpos').oninput = (e) => { settings.trigPosDiv = +e.target.value; changed(); };
  $('trig-kind').onchange = (e) => { settings.trig.kind = +e.target.value; changed(send.trigger); };
  $('trig-level').oninput = (e) => { settings.trig.levelDiv = +e.target.value; changed(send.trigger); };
  $('trig-width').onchange = (e) => { settings.trig.widthUs = Math.max(0, +e.target.value || 0); changed(send.trigger); };
  $('trig-mode').onchange = (e) => { settings.mode = e.target.value; changed(send.acq); };
  $('gen-freq').onchange = (e) => { settings.gen.freq = clamp(Math.round(+e.target.value || 1000), 1, +e.target.max); changed(send.gen); };
  $('gen-duty').oninput = (e) => { settings.gen.duty = +e.target.value; changed(send.gen); };
  $('gen-amp').oninput = (e) => { settings.gen.amp = +e.target.value; changed(send.gen); };
  $('gen-offset').oninput = (e) => { settings.gen.offset = +e.target.value; changed(send.gen); };
  $('fft-on').onchange = (e) => { settings.fft.on = e.target.checked; fftReset(); changed(); };
  $('fft-window').onchange = (e) => { settings.fft.window = e.target.value; fftReset(); changed(); };
  $('fft-span').onchange = (e) => { settings.fft.span = +e.target.value; changed(); };
  $('fft-avg').onchange = (e) => { settings.fft.avg = +e.target.value; fftReset(); changed(); };
  $('backlight').oninput = (e) => { settings.backlight = +e.target.value; changed(send.system); };

  document.querySelectorAll('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const v = +b.value, name = seg.dataset.for;
    if (name === 'a-coupling' || name === 'b-coupling') { const i = name[0] === 'a' ? 0 : 1; settings.ch[i].coupling = v; changed(() => send.channel(i)); }
    if (name === 'trig-source') { settings.trig.source = v; changed(send.trigger); }
    if (name === 'gen-shape') {
      settings.gen.shape = b.value;
      if (b.value !== 'off' && b.value !== 'square' && settings.gen.freq > Gen.MAX_ANALOG_HZ) settings.gen.freq = Gen.MAX_ANALOG_HZ;
      changed(send.gen);
    }
    if (name === 'fft-scale') { settings.fft.scale = b.value; changed(); }
  }));

  $('run').onclick = toggleRun;
  $('single').onclick = single;
  $('connect').onclick = onConnectClick;
  $('playback-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { await connect(new PlaybackTransport(new Uint8Array(await file.arrayBuffer()), file.name)); } catch (err) { toast(err.message); }
  };

  $('calibrate').onclick = () => openCalDialog({
    dev, ranges, cal,
    suspend(on) {
      calibrating = on;
      if (!on && dev) send.all();   // put the user's settings back
    },
    onSaved(c) { cal = c; syncControls(); view.invalidate(); },
    toast,
  });

  $('export').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' }));
    a.download = 'dsoquad-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('import').onclick = () => $('import-file').click();
  $('import-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { applySettings(merge(DEFAULTS, JSON.parse(await file.text()))); toast('Settings imported', 'info'); } catch (err) { toast(`Import failed: ${err.message}`); }
  };
  $('reset').onclick = () => applySettings(merge(DEFAULTS, null));

  document.addEventListener('keydown', (e) => {
    if (calibrating || e.target.closest('input, select, textarea, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); toggleRun(); }
    if (e.key === 's' || e.key === 'S') single();
  });
}

function applySettings(s) {
  settings = s;
  saveSettings();
  if (dev) send.all();
  syncControls();
  view.invalidate();
}

function toggleRun() {
  if (!dev) return;
  singleArmed = false;
  settings.running = !settings.running;
  changed(send.acq);
}

function single() {
  if (!dev) return;
  singleArmed = true;
  settings.running = false;
  dev.setAcq(P.ACQ_SINGLE, autoMs()).catch(report);
  syncControls();
}

async function onConnectClick() {
  if (dev) { await disconnect(true); return; }
  const src = $('source').value;
  if (src === 'sim') return connect(new SimTransport());
  if (src === 'file') { $('playback-file').click(); return; }
  if (!SerialTransport.supported()) { toast('Web Serial is not available: use Chrome or Edge on desktop, over https or localhost'); return; }
  let t;
  try { t = await SerialTransport.request(); } catch { return; }  // chooser cancelled
  await connect(t);
}

// ------------------------------------------------------------------ misc UI

function status(text, cls = '') {
  const el = $('conn-status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 4000);
}

function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}

// ------------------------------------------------------------------ start

fillRangeSelects();
fillTdiv();
fillFftSelects();
bind();
syncControls();
document.documentElement.style.setProperty('--a', COLORS.a);
document.documentElement.style.setProperty('--b', COLORS.b);

const params = new URLSearchParams(location.search);
if (params.has('sim')) {
  $('source').value = 'sim';
  connect(new SimTransport());
} else if (params.has('play')) {
  // ?play=recordings/square-1khz.dsoq (same origin)
  $('source').value = 'file';
  const url = params.get('play');
  fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); })
    .then((b) => connect(new PlaybackTransport(new Uint8Array(b), url.split('/').pop())))
    .catch((e) => toast(e.message));
} else if (!SerialTransport.supported()) {
  $('source').value = 'sim';
  $('source').querySelector('option[value=usb]').disabled = true;
  status('Web Serial unavailable here (Chrome/Edge only): simulator and playback still work');
} else {
  // A port granted earlier needs no prompt: connect straight away, and again whenever it
  // re-enumerates (device reset, cable replugged).
  SerialTransport.grantedPorts().then((ports) => { if (ports.length) connect(new SerialTransport(ports[0])); });
  navigator.serial.addEventListener('connect', (e) => {
    const i = e.target.getInfo?.() ?? {};
    if (!dev && !userDisconnected && $('source').value === 'usb' && i.usbVendorId === 0x1209 && i.usbProductId === 0x0001) {
      connect(new SerialTransport(e.target));
    }
  });
}
