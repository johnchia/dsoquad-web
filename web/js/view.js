// Waveform canvas: graticule, traces, draggable markers (channel zeros, trigger level and
// position) and a hover readout. Knows divisions, not devices: the app supplies a model.
import { STALE_SAMPLES } from './protocol.js';

export const HDIV = 10, VDIV = 8;
export const COLORS = { a: '#f5d90a', b: '#3fd4f4', c: '#e070f0', d: '#5fe07a', trig: '#ff8c42', grid: '#2c3440', axis: '#4a5563' };
const M = { l: 30, r: 30, t: 20, b: 8 };   // margins hold the markers

export class ScopeView {
  /** model() must return {frame, ch:[{on, posDiv}], digital, trig:{source, levelDiv, posDiv}, tdiv,
   * vdivs:[V/div A, B], scale(ch, frameChannel) -> {zero: code of 0 V, cpd: codes per div}} */
  constructor(canvas, model, onDrag) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = model;
    this.onDrag = onDrag;
    this.hover = null;
    this.drag = null;
    this._dirty = true;
    new ResizeObserver(() => this.invalidate()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.invalidate(); } });
    const loop = () => { if (this._dirty) { this._dirty = false; this._draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  invalidate() { this._dirty = true; }

  // ---------------------------------------------------------------- geometry

  _geom() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const pw = w - M.l - M.r, ph = h - M.t - M.b;
    return { w, h, x0: M.l, y0: M.t, pw, ph, dx: pw / HDIV, dy: ph / VDIV };
  }

  xOfDiv(g, d) { return g.x0 + d * g.dx; }
  yOfDiv(g, d) { return g.y0 + g.ph - d * g.dy; }   // d = divisions above the bottom

  _markers(g) {
    const m = this.model(), out = [];
    ['a', 'b'].forEach((name, i) => {
      if (m.ch[i].on) out.push({ id: `pos${i}`, axis: 'y', side: 'l', color: COLORS[name], label: name.toUpperCase(), y: this.yOfDiv(g, m.ch[i].posDiv) });
    });
    if (m.roll) return out;   // no trigger in roll mode
    if (m.trig.source < 2) {
      const src = m.ch[m.trig.source];
      out.push({ id: 'trigLevel', axis: 'y', side: 'r', color: COLORS.trig, label: 'T', y: this.yOfDiv(g, src.posDiv + m.trig.levelDiv) });
    }
    out.push({ id: 'trigPos', axis: 'x', color: COLORS.trig, label: 'T', x: this.xOfDiv(g, m.trig.posDiv) });
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
      this._noData(ctx, g, m);
      ctx.save();
      ctx.beginPath(); ctx.rect(g.x0, g.y0, g.pw, g.ph); ctx.clip();
      if (m.digital.on) this._digital(ctx, g, m);
      [1, 0].forEach((i) => { if (m.ch[i].on) this._trace(ctx, g, m, i); });
      ctx.restore();
    }
    this._drawMarkers(ctx, g);
    if (this.hover) this._readout(ctx, g, m);
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

  _noData(ctx, g, m) {
    const f = m.frame;
    const first = this._sampleDiv(m, STALE_SAMPLES), last = this._sampleDiv(m, f.count - 1);
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    if (first > 0) ctx.fillRect(g.x0, g.y0, Math.min(first, HDIV) * g.dx, g.ph);
    if (last < HDIV) { const x = this.xOfDiv(g, Math.max(last, 0)); ctx.fillRect(x, g.y0, g.x0 + g.pw - x, g.ph); }
  }

  _trace(ctx, g, m, ch) {
    const f = m.frame, codes = ch ? f.b : f.a;
    // Calibrated: 0 V sits at the channel's current position (so a frame captured at an
    // old offset follows the marker at once) and a division is exactly one V/div.
    const { zero, cpd } = m.scale(ch, f.ch[ch]);
    const base = m.ch[ch].posDiv;
    const yOf = (code) => g.y0 + g.ph - (base + (code - zero) / cpd) * g.dy;
    const pxPerSample = g.dx / (f.rate * m.tdiv);
    const i0 = Math.max(STALE_SAMPLES, Math.floor(f.pretrigger - m.trig.posDiv * m.tdiv * f.rate) - 1);
    const i1 = Math.min(f.count - 1, Math.ceil(f.pretrigger + (HDIV - m.trig.posDiv) * m.tdiv * f.rate) + 1);
    if (i1 <= i0) return;
    ctx.strokeStyle = COLORS[ch ? 'b' : 'a'];
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    if (pxPerSample >= 0.5) {
      for (let i = i0; i <= i1; i++) {
        const x = this.xOfDiv(g, this._sampleDiv(m, i)), y = yOf(codes[i]);
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
        if (c !== col) { if (col >= 0) flush(); col = c; lo = hi = codes[i]; } else { if (codes[i] < lo) lo = codes[i]; if (codes[i] > hi) hi = codes[i]; }
      }
      if (col >= 0) flush();
    }
    ctx.stroke();
  }

  _digital(ctx, g, m) {
    const f = m.frame;
    [['c', 0, 1.2], ['d', 1, 0.2]].forEach(([name, bit, base]) => {
      ctx.strokeStyle = COLORS[name];
      ctx.lineWidth = 1;
      ctx.beginPath();
      let prev = -1;
      const i0 = Math.max(STALE_SAMPLES, Math.floor(f.pretrigger - m.trig.posDiv * m.tdiv * f.rate) - 1);
      const i1 = Math.min(f.count - 1, Math.ceil(f.pretrigger + (HDIV - m.trig.posDiv) * m.tdiv * f.rate) + 1);
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

  _drawMarkers(ctx, g) {
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const mk of this._markers(g)) {
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
        if (active) this._hline(ctx, g, mk.y, mk.color);
      } else {
        const x = Math.min(Math.max(mk.x, g.x0), g.x0 + g.pw);
        ctx.moveTo(x - 8, 2); ctx.lineTo(x + 8, 2); ctx.lineTo(x + 8, M.t - 8); ctx.lineTo(x, M.t - 1); ctx.lineTo(x - 8, M.t - 8);
        ctx.fill();
        ctx.fillStyle = '#111';
        ctx.fillText(mk.label, x, 8);
        ctx.strokeStyle = mk.color;
        ctx.globalAlpha = active ? 0.9 : 0.35;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, g.y0); ctx.lineTo(Math.round(x) + 0.5, g.y0 + g.ph); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  _hline(ctx, g, y, color) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(g.x0, Math.round(y) + 0.5); ctx.lineTo(g.x0 + g.pw, Math.round(y) + 0.5); ctx.stroke();
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
    const lines = [`t ${fmtSI((xd - m.trig.posDiv) * m.tdiv, 's')}`];
    ['A', 'B'].forEach((n, i) => { if (m.ch[i].on) lines.push(`${n} ${fmtSI((yd - m.ch[i].posDiv) * m.vdivs[i], 'V')}`); });
    ctx.font = '12px ui-monospace, monospace';
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12, bh = lines.length * 16 + 6;
    let bx = x + 12, by = y + 12;
    if (bx + bw > g.x0 + g.pw) bx = x - 12 - bw;
    if (by + bh > g.y0 + g.ph) by = y - 12 - bh;
    ctx.fillStyle = 'rgba(12,16,22,0.85)';
    ctx.fillRect(bx, by, bw, bh);
    const colors = ['#e6edf3', ...[0, 1].filter((i) => m.ch[i].on).map((i) => COLORS[i ? 'b' : 'a'])];
    lines.forEach((l, i) => { ctx.fillStyle = colors[i]; ctx.fillText(l, bx + 6, by + 16 + i * 16); });
  }

  // ---------------------------------------------------------------- pointer

  _pos(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  _hit(p) {
    const g = this._geom();
    let best = null, bestD = 12;
    for (const mk of this._markers(g)) {
      let d;
      if (mk.axis === 'y') {
        const inBand = mk.side === 'l' ? p.x < M.l + 4 : p.x > g.x0 + g.pw - 4;
        d = inBand ? Math.abs(p.y - Math.min(Math.max(mk.y, g.y0), g.y0 + g.ph)) : Infinity;
      } else {
        d = p.y < M.t + 4 ? Math.abs(p.x - Math.min(Math.max(mk.x, g.x0), g.x0 + g.pw)) : Infinity;
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
  const a = Math.abs(v);
  if (a < 1e-12) return `0 ${unit}`;
  const prefixes = [[1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n']];
  for (const [k, p] of prefixes) {
    if (a >= k * 0.9995 || k === 1e-9) return `${+(v / k).toPrecision(digits)} ${p}${unit}`;
  }
  return `0 ${unit}`;
}
