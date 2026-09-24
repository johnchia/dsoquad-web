// DSO Quad web UI: settings (owned by the page, persisted in localStorage and pushed to the
// device on connect), connection handling, rendering and measurements.
import * as P from './protocol.js';
import { Device, DeviceError } from './device.js';
import { PlaybackTransport, SerialTransport, SimTransport } from './transport.js';
import { COLORS, HDIV, VDIV, ScopeView, fmtSI } from './view.js';
import * as Cal from './calibration.js';
import { openCalDialog } from './cal-ui.js';
import { openFwDialog, bundledFirmware } from './fw-ui.js';
import * as Gen from './wavegen.js';
import { WINDOWS, peak as fftPeak, spectrum } from './fft.js';
import { SpectrumView } from './spectrum.js';
import { autoset } from './autoset.js';
import { MEASUREMENTS, measure } from './measure.js';
import { download, frameCsv, sharedSettings, shareLink, snapshotPng, stamp } from './export.js';

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
  math: { op: 'off', vdiv: 1, posDiv: 4 },
  xy: false,
  persist: 'off',
  cursors: { mode: 'off', trace: 'a', tDiv: [3, 7], vDiv: [5, 3] },
  meas: ['pp', 'mean', 'rms', 'max', 'min', 'freq'],
  backlight: 50,
};

// ------------------------------------------------------------------ state

let settings = loadSettings();
let cal = Cal.nominal();   // vertical calibration, read from the device's flash store
let calSupported = false;  // firmware >= 0.4 has the store
let suspended = false;     // a dialog (calibration, firmware update) drives the device; the app keeps off
const live = () => (suspended ? null : dev);
let fwExpected = null;
let devFw = null;     // version being installed: the next connect reports whether it took
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
  if (typeof v !== typeof def) return def;
  return v;
}

/** merge() for arrays of any length (the measurement list): keep known string items. */
function mergeList(def, v, known) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && known.includes(x)) : def.slice();
}

function mergeSettings(v) {
  const s = merge(DEFAULTS, v);
  s.meas = mergeList(DEFAULTS.meas, v?.meas, Object.keys(MEASUREMENTS));
  return s;
}

function loadSettings() {
  try { return mergeSettings(JSON.parse(localStorage.getItem(STORE_KEY))); } catch { return mergeSettings(null); }
}

function saveSettings() {
  if (!persist) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// ------------------------------------------------------------------ derived values

/** Channel B's ADC is needed unless B, math and XY are all off; then fast timebases can
 * interleave both ADCs on channel A (72 MS/s). */
const needB = () => settings.ch[1].on || settings.math.op !== 'off' || settings.xy;
const sampleRate = () => Math.min(needB() ? P.MAX_RATE : P.IL_RATE, SAMPLES_PER_DIV / settings.tdiv);
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

const ROLL_TDIV = 0.1;   // Auto mode rolls at this time/div and slower

/** Roll mode: continuous untriggered streaming (explicit, or Auto at slow timebases). */
const rolling = () => settings.mode === 'roll' || (settings.mode === 'auto' && settings.tdiv >= ROLL_TDIV);

function acqMode() {
  if (!settings.running) return P.ACQ_STOP;
  if (rolling()) return P.ACQ_ROLL;
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
  acq() { roll = null; if (!singleArmed) live()?.setAcq(acqMode(), autoMs()).catch(report); },
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
  view.clearPersistence();
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
    d.addEventListener('roll', (e) => onRoll(e.detail));
    d.addEventListener('disconnect', (e) => onLost(e.detail));
    const info = await d.hello();
    $('dev-fw').textContent = info.fw;
    devFw = info.fw;
    if (fwExpected !== null) {
      toast(info.fw === fwExpected || !fwExpected ? `Firmware updated: ${info.fw}` : `Firmware is ${info.fw}, expected ${fwExpected}`, info.fw === fwExpected || !fwExpected ? 'info' : undefined);
      fwExpected = null;
    }
    const serial = transport instanceof SerialTransport;
    bundledFirmware().then((m) => { $('firmware').textContent = serial && m && m.fw !== devFw ? 'Update firmware…' : 'Firmware…'; });
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
  suspended = false;
  document.getElementById('cal-dialog').close();
  if (fwExpected !== null) status('Restarting into the new firmware…');
  else status('Device lost, will reconnect when it reappears', 'err');
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
    if (!suspended && settings.running && !singleArmed && st.acqMode === P.ACQ_STOP) send.acq();
  } catch (e) { report(e); }
}

// ------------------------------------------------------------------ frames

const MATH_OPS = {
  'a+b': { label: 'A + B', unit: 'V', f: (a, b) => a + b },
  'a-b': { label: 'A − B', unit: 'V', f: (a, b) => a - b },
  'b-a': { label: 'B − A', unit: 'V', f: (a, b) => b - a },
  'a*b': { label: 'A × B', unit: 'V²', f: (a, b) => a * b },
};
const MATH_VDIVS = [];
for (let e = -2; e <= 2; e++) for (const m of [1, 2, 5]) MATH_VDIVS.push(+(m * 10 ** e).toPrecision(1));

const voltsCache = new WeakMap();
/** Calibrated volts of a frame's analog channels: {a, b (null if interleaved), m (math or null)}. */
function frameVolts(f) {
  let v = voltsCache.get(f);
  if (v) return v;
  const conv = (codes, i) => {
    if (!codes) return null;
    const { zero, cpd } = frameScale(i, f.ch[i]);
    const k = (ranges[f.ch[i].range] ?? 1) / cpd, out = new Float32Array(codes.length);
    for (let j = 0; j < codes.length; j++) out[j] = (codes[j] - zero) * k;
    return out;
  };
  v = { a: conv(f.a, 0), b: conv(f.b, 1), math: {} };
  voltsCache.set(f, v);
  return v;
}

/** Math trace data for the current operation (null without channel B). */
function mathVolts(f) {
  const v = frameVolts(f), op = MATH_OPS[settings.math.op];
  if (!op || !v.b) return null;
  let m = v.math[settings.math.op];
  if (!m) {
    m = v.math[settings.math.op] = new Float32Array(v.a.length);
    for (let j = 0; j < m.length; j++) m[j] = op.f(v.a[j], v.b[j]);
  }
  return m;
}

/** The traces on screen for frame f: [{key, label, color, posDiv, vdiv, unit, data}]. */
function frameTraces(f) {
  if (!f) return [];
  const v = frameVolts(f), out = [];
  if (settings.ch[0].on) out.push({ key: 'a', label: 'A', color: COLORS.a, posDiv: settings.ch[0].posDiv, vdiv: ranges[settings.ch[0].range] ?? 1, unit: 'V', data: v.a });
  if (settings.ch[1].on && v.b) out.push({ key: 'b', label: 'B', color: COLORS.b, posDiv: settings.ch[1].posDiv, vdiv: ranges[settings.ch[1].range] ?? 1, unit: 'V', data: v.b });
  const m = mathVolts(f);
  if (m) out.push({ key: 'm', label: 'M', color: COLORS.m, posDiv: settings.math.posDiv, vdiv: settings.math.vdiv, unit: MATH_OPS[settings.math.op].unit, data: m });
  return out;
}

// ------------------------------------------------------------------ FFT

let fftAvg = [null, null], fftKey = '', fftTraces = [];

function fftReset() { fftAvg = [null, null]; fftTraces = []; spectrumView.invalidate(); }

/** Spectrum of each shown channel, power-averaged over settings.fft.avg frames. */
function updateSpectrum(f) {
  const s = settings.fft;
  const key = `${f.rate}/${f.interleaved}/${f.ch.map((c) => `${c.range}.${c.coupling}`).join()}/${s.window}/${s.avg}`;
  if (key !== fftKey) { fftKey = key; fftAvg = [null, null]; }
  fftTraces = [];
  const v = frameVolts(f);
  [[v.a, 0], [v.b, 1]].forEach(([volts, i]) => {
    if (!settings.ch[i].on || !volts) return;
    const sp = spectrum(volts.subarray(f.stale), s.window);
    let acc = fftAvg[i];
    if (!acc || acc.length !== sp.rms.length) acc = fftAvg[i] = Float64Array.from(sp.rms, (x) => x * x);
    else { const a = 1 / s.avg; for (let j = 0; j < acc.length; j++) acc[j] += (sp.rms[j] ** 2 - acc[j]) * a; }
    const rms = Float64Array.from(acc, Math.sqrt);
    fftTraces.push({ name: 'AB'[i], color: COLORS[i ? 'b' : 'a'], rms, binHz: sp.binHz(f.rate), peak: fftPeak(rms) });
  });
  spectrumView.invalidate();
}

// ------------------------------------------------------------------ roll mode

const ROLL_CAP = 8192;
const ROLL_JUNK = 150;
let roll = null;   // {a, b, cd, n, next, key, rate, chunks, gaps}

/** Appends a roll chunk and shows the newest screenful as a frame (newest sample at the right). */
function onRoll(c) {
  if (!settings.running || !rolling()) return;   // a chunk still in flight after a change
  if (c.frameNo < ROLL_JUNK) {
    // Firmware 0.5.0 up to b21a47f sends the capture's 146 unfilled pretrigger samples first.
    const k = Math.min(c.count, ROLL_JUNK - c.frameNo);
    c = { ...c, frameNo: c.frameNo + k, count: c.count - k, a: c.a.subarray(k), b: c.b.subarray(k), cd: c.cd.subarray(k) };
    if (!c.count) return;
  }
  const key = `${c.rate}/${c.ch.map((x) => `${x.range}.${x.coupling}.${x.offset}`).join()}`;
  if (!roll || roll.key !== key || c.frameNo < roll.next) {
    roll = { a: new Uint8Array(ROLL_CAP), b: new Uint8Array(ROLL_CAP), cd: new Uint8Array(ROLL_CAP), n: 0, next: c.frameNo, key, rate: c.rate, chunks: 0, gaps: 0 };
  }
  if (c.gap || c.frameNo !== roll.next) roll.gaps++;
  const k = c.count;
  if (roll.n + k > ROLL_CAP) {
    const drop = roll.n + k - ROLL_CAP;
    for (const x of ['a', 'b', 'cd']) roll[x].copyWithin(0, drop, roll.n);
    roll.n -= drop;
  }
  roll.a.set(c.a, roll.n); roll.b.set(c.b, roll.n); roll.cd.set(c.cd, roll.n);
  roll.n += k;
  roll.next = c.frameNo + k;
  roll.chunks++;
  const shown = Math.min(roll.n, Math.ceil(HDIV * settings.tdiv * c.rate) + P.STALE_SAMPLES);
  const from = roll.n - shown;
  onFrame({
    ...c, frameNo: roll.chunks, triggered: false, auto: false, roll: true, pretrigger: shown, count: shown,
    a: roll.a.subarray(from, roll.n), b: roll.b.subarray(from, roll.n), cd: roll.cd.subarray(from, roll.n),
  });
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

function updateReadouts() {
  const now = performance.now();
  const fps = frameTimes.length > 1 ? (frameTimes.length - 1) / ((frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000) : 0;
  $('fps').textContent = lastFrame?.roll ? 'rolling' : `${fps.toFixed(1)} fps`;
  const f = lastFrame;
  $('frame-no').textContent = f ? `frame ${f.frameNo}` : 'frame –';
  $('rate').textContent = `${fmtSI(f ? f.rate : P.actualRate(sampleRate()), 'S/s')}`;

  const badge = $('trig-status');
  const frameTime = 4096 / P.actualRate(sampleRate()) * 1000;
  const stale = now - lastFrameAt > Math.max(600, 3 * frameTime);
  let text = 'Stop', cls = '';
  if (dev && settings.running && rolling()) { text = 'Roll'; cls = 'auto'; } else if (dev && singleArmed) { text = 'Armed'; cls = 'wait'; } else if (dev && settings.running) {
    if (!f || stale) { text = settings.mode === 'normal' ? 'Waiting' : 'Acquiring'; cls = 'wait'; } else if (f.auto) { text = 'Auto'; cls = 'auto'; } else { text = "Trig'd"; cls = 'trig'; }
  }
  badge.textContent = text;
  badge.className = `badge ${cls}`;

  const out = $('measure');
  out.replaceChildren();
  if (!f) return;
  const peaks = new Map(fftTraces.map((t) => [t.name, t]));
  for (const t of frameTraces(f)) {
    const m = measure(t.data.subarray(f.stale), f.rate, t.vdiv / P.CODES_PER_DIV);
    const div = document.createElement('div');
    div.className = `ch ch-${t.key}`;
    const parts = [`<b>${t.label}</b>`];
    for (const k of settings.meas) {
      const d = MEASUREMENTS[k], unit = d.unit === 'V' ? t.unit : d.unit;
      parts.push(`${d.label} ${m.limited.has(k) ? '&lt; ' : ''}${fmtSI(m[k], unit, d.digits ?? 3)}`);
    }
    const pk = settings.fft.on && peaks.get(t.label);
    if (pk) parts.push(`FFT peak ${fmtSI(pk.peak.bin * pk.binHz, 'Hz', 4)} ${(20 * Math.log10(Math.max(pk.peak.rms, 1e-9))).toFixed(1)} dBV`);
    if (t.key !== 'm') {
      const codes = t.key === 'a' ? f.a : f.b;
      let clipped = false;
      for (let i = f.stale; i < codes.length && !clipped; i++) clipped = codes[i] <= 0 || codes[i] >= 255;
      if (clipped) parts.push('<span style="color:var(--err)">clipped</span>');
    }
    div.innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
    out.append(div);
  }
  const cur = cursorText(f);
  if (cur) {
    const div = document.createElement('div');
    div.className = 'ch ch-cursor';
    div.innerHTML = cur.map((p) => `<span>${p}</span>`).join('');
    out.append(div);
  }
}

/** Cursor readout parts, or null when the cursors are off. */
function cursorText(f) {
  const c = settings.cursors;
  if (c.mode === 'off') return null;
  const parts = ['<b>Cursors</b>'];
  if ((c.mode === 't' || c.mode === 'tv') && !settings.xy) {
    const [t1, t2] = c.tDiv.map((d) => (d - trigPosDiv(f)) * settings.tdiv), dt = t2 - t1;
    parts.push(`t1 ${fmtSI(t1, 's')}`, `t2 ${fmtSI(t2, 's')}`, `Δt ${fmtSI(dt, 's')}`, `1/Δt ${fmtSI(1 / Math.abs(dt), 'Hz')}`);
  }
  if (c.mode === 'v' || c.mode === 'tv') {
    const t = cursorTrace();
    if (t) {
      const [v1, v2] = c.vDiv.map((d) => (d - t.posDiv) * t.vdiv);
      parts.push(`${t.label}: V1 ${fmtSI(v1, t.unit)}`, `V2 ${fmtSI(v2, t.unit)}`, `ΔV ${fmtSI(v2 - v1, t.unit)}`);
    }
  }
  return parts;
}

/** The trace the voltage cursors read (XY: the vertical one, channel B). */
function cursorTrace() {
  const key = settings.xy ? 'b' : settings.cursors.trace;
  if (key === 'm') return MATH_OPS[settings.math.op] ? { label: 'M', posDiv: settings.math.posDiv, vdiv: settings.math.vdiv, unit: MATH_OPS[settings.math.op].unit } : null;
  const i = key === 'b' ? 1 : 0, c = settings.ch[i];
  return settings.xy ? { label: 'B', posDiv: VDIV / 2, vdiv: ranges[c.range] ?? 1, unit: 'V' }
    : { label: key.toUpperCase(), posDiv: c.posDiv, vdiv: ranges[c.range] ?? 1, unit: 'V' };
}

const trigPosDiv = (f) => (f?.roll ? HDIV : settings.trigPosDiv);

setInterval(scheduleMeasure, 500);  // keeps the status badge current when frames stop

// ------------------------------------------------------------------ view

const view = new ScopeView($('scope'), () => {
  const f = lastFrame, traces = frameTraces(f), src = settings.trig.source;
  const byKey = (k) => traces.find((t) => t.key === k);
  const c = settings.cursors;
  return {
    frame: f,
    traces,
    digital: { on: settings.digital },
    // Roll: the newest sample sits at the right edge and there's no trigger to mark.
    trig: { source: src, levelDiv: settings.trig.levelDiv, posDiv: trigPosDiv(f), levelTrace: src < 2 ? settings.ch[src] : null },
    roll: !!f?.roll,
    tdiv: settings.tdiv,
    xy: settings.xy && byKey('a') && byKey('b') ? { x: byKey('a'), y: byKey('b') } : null,
    persist: settings.persist,
    cursors: { t: c.mode === 't' || c.mode === 'tv', v: c.mode === 'v' || c.mode === 'tv', tDiv: c.tDiv, vDiv: c.vDiv },
  };
}, (id, value) => {
  if (id === 'pos:a' || id === 'pos:b') {
    const i = id === 'pos:a' ? 0 : 1;
    settings.ch[i].posDiv = +clamp(value, 0, 8).toFixed(2);
    changed(() => send.channel(i));
  } else if (id === 'pos:m') {
    settings.math.posDiv = +clamp(value, 0, 8).toFixed(2);
    changed();
  } else if (id === 'trigLevel') {
    const src = settings.ch[settings.trig.source];
    settings.trig.levelDiv = +clamp(value - src.posDiv, -8, 8).toFixed(2);
    changed(send.trigger);
  } else if (id === 'trigPos') {
    settings.trigPosDiv = +clamp(value, 0, HDIV).toFixed(2);
    changed();
  } else if (id.startsWith('curT') || id.startsWith('curV')) {
    const arr = id[3] === 'T' ? settings.cursors.tDiv : settings.cursors.vDiv;
    arr[+id[4]] = +clamp(value, 0, id[3] === 'T' ? HDIV : VDIV).toFixed(3);
    saveSettings();
    view.invalidate();
    scheduleMeasure();
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

function fillDisplayControls() {
  $('math-vdiv').replaceChildren(...MATH_VDIVS.map((v) => new Option(String(v), v)));
  $('meas-chips').replaceChildren(...Object.entries(MEASUREMENTS).map(([k, d]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.value = k; b.textContent = d.label;
    return b;
  }));
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
  $('gen-amp-out').textContent = `${(g.amp / 100 * Gen.DAC_VSPAN).toFixed(2)} Vpp`;
  $('gen-offset').value = g.offset;
  $('gen-offset-out').textContent = `${(Gen.DAC_V0 + g.offset / 100 * Gen.DAC_VSPAN).toFixed(2)} V`;
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
  $('math-op').value = s.math.op;
  $('math-vdiv-row').hidden = s.math.op === 'off';
  const mu = MATH_OPS[s.math.op]?.unit ?? 'V';
  [...$('math-vdiv').options].forEach((o) => { o.textContent = `${fmtSI(+o.value, mu)}/div`; });
  $('math-vdiv').value = s.math.vdiv;
  $('xy-on').checked = s.xy;
  segSet('persist', s.persist);
  segSet('cur-mode', s.cursors.mode);
  segSet('cur-trace', s.cursors.trace);
  $('cur-trace-row').hidden = !(s.cursors.mode === 'v' || s.cursors.mode === 'tv') || s.xy;
  document.querySelector('.seg[data-for="cur-trace"] button[value="m"]').disabled = s.math.op === 'off';
  document.querySelectorAll('#meas-chips button').forEach((b) => b.classList.toggle('active', s.meas.includes(b.value)));
  const rate = P.actualRate(sampleRate()), want = SAMPLES_PER_DIV / s.tdiv;
  $('rate-note').textContent = rate > P.MAX_RATE ? `${fmtSI(rate, 'S/s')}: both ADCs on channel A`
    : want > P.MAX_RATE && needB() ? `${fmtSI(rate, 'S/s')}; 72 MS/s with B, math and XY off` : `${fmtSI(rate, 'S/s')}`;
  $('backlight').value = s.backlight;
  $('backlight-out').textContent = s.backlight ? `${s.backlight}%` : 'off';

  $('trig-mode').value = s.mode;
  const run = $('run');
  run.textContent = s.running ? 'Stop' : 'Run';
  run.classList.toggle('running', s.running);
  run.disabled = $('single').disabled = $('autoset').disabled = !dev;
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
  $('firmware').disabled = !(dev?.t instanceof SerialTransport);
  updateReadouts();
}

function bind() {

  ['a', 'b'].forEach((p, i) => {
    // B's ADC doubles channel A's rate when B isn't needed, so B on/off can change the rate.
    $(`${p}-on`).onchange = (e) => { settings.ch[i].on = e.target.checked; changed(i ? send.rate : null); };
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
  $('math-op').onchange = (e) => { settings.math.op = e.target.value; changed(send.rate); };
  $('math-vdiv').onchange = (e) => { settings.math.vdiv = +e.target.value; changed(); };
  $('xy-on').onchange = (e) => { settings.xy = e.target.checked; changed(send.rate); };
  $('meas-chips').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const k = b.value, list = settings.meas;
    settings.meas = list.includes(k) ? list.filter((x) => x !== k) : Object.keys(MEASUREMENTS).filter((x) => x === k || list.includes(x));
    changed();
  };
  $('save-png').onclick = savePng;
  $('save-csv').onclick = saveCsv;
  $('share').onclick = async () => {
    const url = shareLink(settings);
    try { await navigator.clipboard.writeText(url); toast('Link with these settings copied', 'info'); } catch { prompt('Link with these settings:', url); }
  };
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
    if (name === 'persist') { settings.persist = b.value; changed(); }
    if (name === 'cur-mode') { settings.cursors.mode = b.value; changed(); }
    if (name === 'cur-trace') { settings.cursors.trace = b.value; changed(); }
  }));

  $('run').onclick = toggleRun;
  $('single').onclick = single;
  $('autoset').onclick = autoSet;
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
      suspended = on;
      if (!on && dev) send.all();   // put the user's settings back
    },
    onSaved(c) { cal = c; syncControls(); view.invalidate(); },
    toast,
  });

  $('firmware').onclick = () => openFwDialog({
    dev, fw: devFw,
    suspend(on) {
      suspended = on;
      if (!on && dev) send.all();
    },
    onCommitted(version) { fwExpected = version ?? ''; },
    toast,
  });

  $('export').onclick = () => download(new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' }), 'dsoquad-settings.json');
  $('import').onclick = () => $('import-file').click();
  $('import-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { applySettings(mergeSettings(JSON.parse(await file.text()))); toast('Settings imported', 'info'); } catch (err) { toast(`Import failed: ${err.message}`); }
  };
  $('reset').onclick = () => applySettings(mergeSettings(null));

  document.addEventListener('keydown', (e) => {
    if (suspended || e.target.closest('input, select, textarea, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); toggleRun(); }
    if (e.key === 's' || e.key === 'S') single();
    if (e.key === 'a' || e.key === 'A') autoSet();
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

/** Auto set: fit the enabled channels, show a few periods, trigger mid-signal. */
async function autoSet() {
  if (!dev || suspended) return;
  const d = dev;
  suspended = true;
  $('autoset').disabled = true;
  try {
    const r = await autoset({
      dev: d, ranges, tdivs: TDIVS,
      on: settings.ch.map((c) => c.on), coupling: settings.ch.map((c) => c.coupling), trigSource: settings.trig.source,
      offsetFor: (ch, range, posDiv) => Cal.offsetFor(cal, ch, range, P.ADC_ZERO + posDiv * P.CODES_PER_DIV),
      volts: (f, i) => frameVolts(f)[i ? 'b' : 'a'],
      progress: (t) => status(t),
    });
    r.ch.forEach((c, i) => { if (c) Object.assign(settings.ch[i], { on: true, range: c.range, posDiv: c.posDiv }); });
    if (r.tdiv) settings.tdiv = r.tdiv;
    if (r.trig) Object.assign(settings.trig, { source: r.trig.source, kind: 1, levelDiv: r.trig.levelDiv });
    if (settings.mode !== 'normal') settings.mode = 'auto';
    settings.running = true;
    singleArmed = false;
    const parts = r.ch.map((c, i) => (c ? `${'AB'[i]} ${fmtSI(ranges[c.range], 'V')}/div` : null)).filter(Boolean);
    toast(`Auto set: ${parts.join(', ')}${r.found ? `, ${fmtSI(settings.tdiv, 's')}/div (period ${fmtSI(r.period, 's')})` : ', no periodic signal found: time/div unchanged'}`, 'info');
  } catch (e) {
    report(e);
  } finally {
    suspended = false;
    $('autoset').disabled = false;
    if (dev === d) {
      status(`Connected · ${d.t.label}`, 'ok');
      changed(send.all);
    }
  }
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

// ------------------------------------------------------------------ saving

/** Text of the scale bar and measurement rows, for captions and CSV headers. */
function screenSummary() {
  const rows = [[['scale-a', 'scale-b', 'scale-t', 'scale-trig'].map((id) => $(id).textContent).join('   '), null]];
  document.querySelectorAll('#measure .ch').forEach((d) => {
    const key = [...d.classList].find((c) => c.startsWith('ch-'))?.slice(3);
    rows.push([[...d.querySelectorAll(':scope > span')].map((x) => x.textContent).join('  '), COLORS[key] ?? null]);
  });
  return rows;
}

async function savePng() {
  const canvases = [$('scope')];
  if (!$('spectrum').hidden) canvases.push($('spectrum'));
  const caption = [...screenSummary(), [`DSO Quad · ${fmtSI(lastFrame?.rate ?? P.actualRate(sampleRate()), 'S/s')} · ${new Date().toLocaleString()}`, '#8b949e']];
  download(await snapshotPng(canvases, caption), `dsoquad_${stamp()}.png`);
}

function saveCsv() {
  const f = lastFrame;
  if (!f) { toast('No capture to save yet'); return; }
  const header = [
    `DSO Quad capture ${new Date().toISOString()}`, `sample rate ${f.rate} S/s${f.interleaved ? ' (interleaved)' : ''}`,
    `trigger at t = 0${f.roll ? ' (roll mode: t = 0 is the newest sample)' : ''}`, ...screenSummary().map(([t]) => t),
  ];
  const traces = frameTraces(f);
  download(new Blob([frameCsv(f, traces, header)], { type: 'text/csv' }), `dsoquad_${stamp()}.csv`);
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
fillDisplayControls();
bind();
syncControls();
document.documentElement.style.setProperty('--a', COLORS.a);
document.documentElement.style.setProperty('--b', COLORS.b);

const shared = sharedSettings(location.hash);
if (shared) {
  settings = mergeSettings(shared);
  saveSettings();
  history.replaceState(null, '', location.pathname + location.search);
  syncControls();
  toast('Settings loaded from the link', 'info');
}

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
