// Waveform canvas: graticule, traces, persistence, XY, draggable markers (trace positions,
// trigger level and position, cursors) and a hover readout. Knows divisions, not devices: the
// app supplies a model.

export const HDIV = 10, VDIV = 8;
export const COLORS = {
  a: '#f5d90a', b: '#3fd4f4', c: '#e070f0', d: '#5fe07a', m: '#ff7eb6', trig: '#ff8c42',
  cursor: '#e6edf3', grid: '#2c3440', axis: '#4a5563',
};
const M = { l: 30, r: 30, t: 20, b: 8 };   // margins hold the markers
const PERSIST_FADE = { short: 0.25, long: 0.05, inf: 0 };   // alpha removed per new frame

export class ScopeView {
  /**
   * model() returns {
   *   frame: {rate, count, pretrigger, stale, cd, ...} or null,
   *   traces: [{key, label, color, posDiv, vdiv, unit, data: volts per sample}],
   *   digital: {on}, trig: {source, levelDiv, posDiv, levelTrace}, roll, tdiv,
   *   xy: null or {x: trace, y: trace}  (0 V at the centre of the screen),
   *   persist: 'off'|'short'|'long'|'inf',
   *   cursors: {t: bool, v: bool, tDiv: [d, d], vDiv: [d, d], trace: key}
   * }
   * onDrag(id, value in divisions) is called while a marker is dragged.
   */
  constructor(canvas, model, onDrag) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = model;
    this.onDrag = onDrag;
    this.hover = null;
    this.drag = null;
    this.layer = null;       // persistence: an offscreen canvas of older traces
    this._layerFrame = null;
    this._dirty = true;
    new ResizeObserver(() => { this.clearPersistence(); this.invalidate(); }).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.invalidate(); } });
    const loop = () => { if (this._dirty) { this._dirty = false; this._draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  invalidate() { this._dirty = true; }

  /** Forget the persisted traces (the scale or position changed, so they no longer line up). */
  clearPersistence() { if (this.layer) this.layer.getContext('2d').clearRect(0, 0, this.layer.width, this.layer.height); }

  // ---------------------------------------------------------------- geometry

  _geom() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const pw = w - M.l - M.r, ph = h - M.t - M.b;
    return { w, h, x0: M.l, y0: M.t, pw, ph, dx: pw / HDIV, dy: ph / VDIV };
  }

  xOfDiv(g, d) { return g.x0 + d * g.dx; }
  yOfDiv(g, d) { return g.y0 + g.ph - d * g.dy; }   // d = divisions above the bottom

  _markers(g, m) {
    const out = [];
    const cur = m.cursors;
    if (!m.xy) {
      for (const t of m.traces) out.push({ id: `pos:${t.key}`, axis: 'y', side: 'l', color: t.color, label: t.label, y: this.yOfDiv(g, t.posDiv) });
      if (!m.roll) {
        const lt = m.trig.levelTrace;
        if (lt) out.push({ id: 'trigLevel', axis: 'y', side: 'r', color: COLORS.trig, label: 'T', y: this.yOfDiv(g, lt.posDiv + m.trig.levelDiv) });
        out.push({ id: 'trigPos', axis: 'x', color: COLORS.trig, label: 'T', x: this.xOfDiv(g, m.trig.posDiv) });
      }
      if (cur?.t) cur.tDiv.forEach((d, i) => out.push({ id: `curT${i}`, axis: 'x', color: COLORS.cursor, label: `${i + 1}`, x: this.xOfDiv(g, d), line: true }));
    }
    if (cur?.v) cur.vDiv.forEach((d, i) => out.push({ id: `curV${i}`, axis: 'y', side: 'r', color: COLORS.cursor, label: `${i + 1}`, y: this.yOfDiv(g, d), line: true }));
    return out;
  }

  // ---------------------------------------------------------------- drawing

  _draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const g = this._geom();
    if (g.pw < 50 || g.ph < 50) return;
    const m = this.model();

    this._grid(ctx, g);
    if (m.frame) {
      if (m.persist !== 'off') {
        this._updateLayer(g, m, dpr);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 0.55;
        ctx.drawImage(this.layer, 0, 0);
        ctx.restore();
      }
      if (!m.xy) this._noData(ctx, g, m);
      this._signals(ctx, g, m);
    }
    this._drawMarkers(ctx, g, m);
    if (this.hover) this._readout(ctx, g, m);
  }

  /** Traces of the current frame (clipped to the graticule). */
  _signals(ctx, g, m) {
    ctx.save();
    ctx.beginPath(); ctx.rect(g.x0, g.y0, g.pw, g.ph); ctx.clip();
    if (m.xy) this._xy(ctx, g, m);
    else {
      if (m.digital.on) this._digital(ctx, g, m);
      for (const t of [...m.traces].reverse()) this._trace(ctx, g, m, t);
    }
    ctx.restore();
  }

  /** Persistence: fade the older traces a step and add this frame's, once per new frame. */
  _updateLayer(g, m, dpr) {
    const c = this.canvas;
    if (!this.layer || this.layer.width !== c.width || this.layer.height !== c.height) {
      this.layer = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height });
      this._layerFrame = null;
    }
    if (this._layerFrame === m.frame) return;
    this._layerFrame = m.frame;
    const lc = this.layer.getContext('2d');
    lc.setTransform(1, 0, 0, 1, 0, 0);
    const fade = PERSIST_FADE[m.persist] ?? 0;
    if (fade) {
      lc.globalCompositeOperation = 'destination-out';
      lc.fillStyle = `rgba(0,0,0,${fade})`;
      lc.fillRect(0, 0, this.layer.width, this.layer.height);
      lc.globalCompositeOperation = 'source-over';
    }
    lc.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._signals(lc, g, m);
  }

  _grid(ctx, g) {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= HDIV; i++) { const x = Math.round(this.xOfDiv(g, i)) + 0.5; ctx.moveTo(x, g.y0); ctx.lineTo(x, g.y0 + g.ph); }
    for (let i = 0; i <= VDIV; i++) { const y = Math.round(this.yOfDiv(g, i)) + 0.5; ctx.moveTo(g.x0, y); ctx.lineTo(g.x0 + g.pw, y); }
    ctx.stroke();
    // Minor ticks on the centre lines.
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    const cx = Math.round(this.xOfDiv(g, HDIV / 2)) + 0.5, cy = Math.round(this.yOfDiv(g, VDIV / 2)) + 0.5;
    for (let i = 0; i <= HDIV * 5; i++) { const x = Math.round(g.x0 + i * g.dx / 5) + 0.5; ctx.moveTo(x, cy - 3); ctx.lineTo(x, cy + 3); }
    for (let i = 0; i <= VDIV * 5; i++) { const y = Math.round(g.y0 + i * g.dy / 5) + 0.5; ctx.moveTo(cx - 3, y); ctx.lineTo(cx + 3, y); }
    ctx.stroke();
  }

  /** Screen x (in divisions) of sample i of the frame. */
  _sampleDiv(m, i) { return m.trig.posDiv + (i - m.frame.pretrigger) / m.frame.rate / m.tdiv; }

  /** Sample index range that's on screen (plus one each side). */
  _visible(m) {
    const f = m.frame;
    const i0 = Math.max(f.stale, Math.floor(f.pretrigger - m.trig.posDiv * m.tdiv * f.rate) - 1);
    const i1 = Math.min(f.count - 1, Math.ceil(f.pretrigger + (HDIV - m.trig.posDiv) * m.tdiv * f.rate) + 1);
    return [i0, i1];
  }

  _noData(ctx, g, m) {
    const f = m.frame;
    const first = this._sampleDiv(m, f.stale), last = this._sampleDiv(m, f.count - 1);
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    if (first > 0) ctx.fillRect(g.x0, g.y0, Math.min(first, HDIV) * g.dx, g.ph);
    if (last < HDIV) { const x = this.xOfDiv(g, Math.max(last, 0)); ctx.fillRect(x, g.y0, g.x0 + g.pw - x, g.ph); }
  }

  _trace(ctx, g, m, t) {
    const f = m.frame, d = t.data;
    // 0 V sits at the trace's current position, so a frame captured at an old position follows
    // the marker at once.
    const yOf = (v) => g.y0 + g.ph - (t.posDiv + v / t.vdiv) * g.dy;
    const pxPerSample = g.dx / (f.rate * m.tdiv);
    const [i0, i1] = this._visible(m);
    if (i1 <= i0) return;
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    if (pxPerSample >= 0.5) {
      for (let i = i0; i <= i1; i++) {
        const x = this.xOfDiv(g, this._sampleDiv(m, i)), y = yOf(d[i]);
        if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    } else {
      // Many samples per pixel: draw the min..max envelope of each column.
      let col = -1, lo = 0, hi = 0, started = false;
      const flush = () => {
        const x = col + 0.5;
        if (!started) { ctx.moveTo(x, yOf(lo)); started = true; } else ctx.lineTo(x, yOf(lo));
        ctx.lineTo(x, yOf(hi));
      };
      for (let i = i0; i <= i1; i++) {
        const c = Math.floor(this.xOfDiv(g, this._sampleDiv(m, i)));
        if (c !== col) { if (col >= 0) flush(); col = c; lo = hi = d[i]; } else { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
      }
      if (col >= 0) flush();
    }
    ctx.stroke();
  }

  /** XY: channel A across, B up, 0 V at the centre. */
  _xy(ctx, g, m) {
    const { x: tx, y: ty } = m.xy, f = m.frame;
    const X = (v) => this.xOfDiv(g, HDIV / 2 + v / tx.vdiv), Y = (v) => this.yOfDiv(g, VDIV / 2 + v / ty.vdiv);
    ctx.strokeStyle = COLORS.m;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    for (let i = f.stale; i < f.count; i++) {
      const x = X(tx.data[i]), y = Y(ty.data[i]);
      if (i === f.stale) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _digital(ctx, g, m) {
    const f = m.frame;
    const [i0, i1] = this._visible(m);
    [['c', 0, 1.2], ['d', 1, 0.2]].forEach(([name, bit, base]) => {
      ctx.strokeStyle = COLORS[name];
      ctx.lineWidth = 1;
      ctx.beginPath();
      let prev = -1;
      for (let i = i0; i <= i1; i++) {
        const v = f.cd[i] >> bit & 1;
        if (v === prev && i !== i1) continue;
        const x = this.xOfDiv(g, this._sampleDiv(m, i)), y = this.yOfDiv(g, base + v * 0.6);
        if (prev < 0) ctx.moveTo(x, y);
        else { ctx.lineTo(x, this.yOfDiv(g, base + prev * 0.6)); ctx.lineTo(x, y); }
        prev = v;
      }
      ctx.stroke();
      ctx.fillStyle = COLORS[name];
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(name.toUpperCase(), g.x0 + 4, this.yOfDiv(g, base + 0.7));
    });
  }

  _drawMarkers(ctx, g, m) {
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const mk of this._markers(g, m)) {
      const active = this.drag?.id === mk.id || this.hoverMarker === mk.id;
      ctx.fillStyle = mk.color;
      ctx.beginPath();
      if (mk.axis === 'y') {
        const y = Math.min(Math.max(mk.y, g.y0), g.y0 + g.ph);
        if (mk.side === 'l') { ctx.moveTo(2, y - 8); ctx.lineTo(M.l - 10, y - 8); ctx.lineTo(M.l - 2, y); ctx.lineTo(M.l - 10, y + 8); ctx.lineTo(2, y + 8); }
        else { const x = g.x0 + g.pw; ctx.moveTo(x + 2, y); ctx.lineTo(x + 10, y - 8); ctx.lineTo(x + M.r - 2, y - 8); ctx.lineTo(x + M.r - 2, y + 8); ctx.lineTo(x + 10, y + 8); }
        ctx.fill();
        ctx.fillStyle = '#111';
        ctx.fillText(mk.label, mk.side === 'l' ? (M.l - 8) / 2 : g.x0 + g.pw + (M.r + 8) / 2, y + 0.5);
        if (active || mk.line) this._line(ctx, g, 'h', mk.y, mk.color, active);
      } else {
        const x = Math.min(Math.max(mk.x, g.x0), g.x0 + g.pw);
        ctx.moveTo(x - 8, 2); ctx.lineTo(x + 8, 2); ctx.lineTo(x + 8, M.t - 8); ctx.lineTo(x, M.t - 1); ctx.lineTo(x - 8, M.t - 8);
        ctx.fill();
        ctx.fillStyle = '#111';
        ctx.fillText(mk.label, x, 8);
        this._line(ctx, g, 'v', x, mk.color, active || mk.line ? true : 0.35);
      }
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /** Dashed guide line: 'h' at y or 'v' at x. `strong`: true, false or an alpha. */
  _line(ctx, g, dir, at, color, strong) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = strong === true ? 0.85 : strong || 0.35;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    const p = Math.round(at) + 0.5;
    if (dir === 'h') { ctx.moveTo(g.x0, p); ctx.lineTo(g.x0 + g.pw, p); } else { ctx.moveTo(p, g.y0); ctx.lineTo(p, g.y0 + g.ph); }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  _readout(ctx, g, m) {
    const { x, y } = this.hover;
    if (x < g.x0 || x > g.x0 + g.pw || y < g.y0 || y > g.y0 + g.ph) return;
    const xd = (x - g.x0) / g.dx, yd = (g.y0 + g.ph - y) / g.dy;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, g.y0); ctx.lineTo(Math.round(x) + 0.5, g.y0 + g.ph);
    ctx.moveTo(g.x0, Math.round(y) + 0.5); ctx.lineTo(g.x0 + g.pw, Math.round(y) + 0.5);
    ctx.stroke();
    const lines = [];
    if (m.xy) {
      lines.push([`${m.xy.x.label} ${fmtSI((xd - HDIV / 2) * m.xy.x.vdiv, m.xy.x.unit)}`, m.xy.x.color]);
      lines.push([`${m.xy.y.label} ${fmtSI((yd - VDIV / 2) * m.xy.y.vdiv, m.xy.y.unit)}`, m.xy.y.color]);
    } else {
      lines.push([`t ${fmtSI((xd - m.trig.posDiv) * m.tdiv, 's')}`, '#e6edf3']);
      for (const t of m.traces) lines.push([`${t.label} ${fmtSI((yd - t.posDiv) * t.vdiv, t.unit)}`, t.color]);
    }
    ctx.font = '12px ui-monospace, monospace';
    const bw = Math.max(...lines.map(([l]) => ctx.measureText(l).width)) + 12, bh = lines.length * 16 + 6;
    let bx = x + 12, by = y + 12;
    if (bx + bw > g.x0 + g.pw) bx = x - 12 - bw;
    if (by + bh > g.y0 + g.ph) by = y - 12 - bh;
    ctx.fillStyle = 'rgba(12,16,22,0.85)';
    ctx.fillRect(bx, by, bw, bh);
    lines.forEach(([l, color], i) => { ctx.fillStyle = color; ctx.fillText(l, bx + 6, by + 16 + i * 16); });
  }

  // ---------------------------------------------------------------- pointer

  _pos(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  _hit(p) {
    const g = this._geom(), m = this.model();
    const inPlot = p.x >= g.x0 && p.x <= g.x0 + g.pw && p.y >= g.y0 && p.y <= g.y0 + g.ph;
    let best = null, bestD = 12;
    for (const mk of this._markers(g, m)) {
      let d;
      if (mk.axis === 'y') {
        const inBand = mk.side === 'l' ? p.x < M.l + 4 : p.x > g.x0 + g.pw - 4;
        // Cursor lines can also be grabbed anywhere along their length.
        d = inBand || (mk.line && inPlot) ? Math.abs(p.y - Math.min(Math.max(mk.y, g.y0), g.y0 + g.ph)) : Infinity;
        if (mk.line && !inBand) d += 4;   // tabs win over lines
      } else {
        const inBand = p.y < M.t + 4;
        d = inBand || (mk.line && inPlot) ? Math.abs(p.x - Math.min(Math.max(mk.x, g.x0), g.x0 + g.pw)) : Infinity;
        if (mk.line && !inBand) d += 4;
      }
      if (d < bestD) { best = mk; bestD = d; }
    }
    return best;
  }

  _down(e) {
    const p = this._pos(e), mk = this._hit(p);
    if (!mk) return;
    this.drag = mk;
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.invalidate();
  }

  _move(e) {
    const p = this._pos(e);
    this.hover = p;
    if (this.drag) {
      const g = this._geom();
      const value = this.drag.axis === 'y' ? (g.y0 + g.ph - p.y) / g.dy : (p.x - g.x0) / g.dx;
      this.onDrag(this.drag.id, value);
    } else {
      const mk = this._hit(p);
      this.hoverMarker = mk?.id;
      this.canvas.style.cursor = mk ? (mk.axis === 'y' ? 'ns-resize' : 'ew-resize') : 'crosshair';
    }
    this.invalidate();
  }

  _up(e) {
    if (!this.drag) return;
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    this.invalidate();
  }
}

/** Formats a value with an SI prefix: fmtSI(0.0012, 's') -> "1.2 ms". */
export function fmtSI(v, unit, digits = 3) {
  if (!Number.isFinite(v)) return `-- ${unit}`;
  if (unit === '%') return `${+v.toPrecision(digits)} %`;
  const a = Math.abs(v);
  if (a < 1e-12) return `0 ${unit}`;
  const prefixes = [[1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n']];
  for (const [k, p] of prefixes) {
    if (a >= k * 0.9995 || k === 1e-9) return `${+(v / k).toPrecision(digits)} ${p}${unit}`;
  }
  return `0 ${unit}`;
}
