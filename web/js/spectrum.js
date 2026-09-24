// Spectrum canvas: frequency axis 0..span, dBV (10 dB/div) or linear volts, per-channel traces,
// peak markers and a hover readout.
import { COLORS, fmtSI } from './view.js';

const M = { l: 52, r: 12, t: 10, b: 22 };
const XDIV = 10, YDIV = 10;

export class SpectrumView {
  /** model() returns {traces: [{name, color, rms: Float64Array, binHz, peak}], span (Hz),
   *  scale: 'db'|'lin', refDb (top of screen, dBV), linMax (V at top)} or null */
  constructor(canvas, model) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = model;
    this.hover = null;
    this._dirty = true;
    new ResizeObserver(() => this.invalidate()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.invalidate();
    });
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.invalidate(); });
    const loop = () => { if (this._dirty && canvas.offsetParent) { this._dirty = false; this._draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  invalidate() { this._dirty = true; }

  _draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const g = { x0: M.l, y0: M.t, pw: w - M.l - M.r, ph: h - M.t - M.b };
    if (g.pw < 50 || g.ph < 40) return;
    const m = this.model();

    // Grid and axis labels.
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= XDIV; i++) { const x = Math.round(g.x0 + i * g.pw / XDIV) + 0.5; ctx.moveTo(x, g.y0); ctx.lineTo(x, g.y0 + g.ph); }
    for (let i = 0; i <= YDIV; i++) { const y = Math.round(g.y0 + i * g.ph / YDIV) + 0.5; ctx.moveTo(g.x0, y); ctx.lineTo(g.x0 + g.pw, y); }
    ctx.stroke();
    if (!m) return;
    const yOf = m.scale === 'db'
      ? (v) => g.y0 + (m.refDb - 20 * Math.log10(Math.max(v, 1e-9))) / (10 * YDIV) * g.ph
      : (v) => g.y0 + g.ph - v / m.linMax * g.ph;
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= YDIV; i += 2) {
      const label = m.scale === 'db' ? `${m.refDb - 10 * i} dBV` : fmtSI(m.linMax * (1 - i / YDIV), 'V', 2);
      ctx.fillText(label, g.x0 - 5, g.y0 + i * g.ph / YDIV);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= XDIV; i += 2) {
      ctx.textAlign = i === XDIV ? 'right' : 'center';
      ctx.fillText(fmtSI(m.span * i / XDIV, 'Hz', 3), g.x0 + i * g.pw / XDIV + (i === XDIV ? M.r : 0), g.y0 + g.ph + 5);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(g.x0, g.y0, g.pw, g.ph); ctx.clip();
    for (const t of m.traces) {
      const bins = Math.min(t.rms.length, Math.floor(m.span / t.binHz) + 2);
      const pxPerBin = g.pw / (m.span / t.binHz);
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      if (pxPerBin >= 1) {
        for (let k = 0; k < bins; k++) { const x = g.x0 + k * pxPerBin, y = yOf(t.rms[k]); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      } else {
        // Several bins per pixel: keep each column's maximum so peaks never vanish.
        let col = -1, hi = 0;
        for (let k = 0; k < bins; k++) {
          const cx = Math.floor(g.x0 + k * pxPerBin);
          if (cx !== col) { if (col >= 0) ctx.lineTo(col + 0.5, yOf(hi)); col = cx; hi = t.rms[k]; } else if (t.rms[k] > hi) hi = t.rms[k];
        }
        ctx.lineTo(col + 0.5, yOf(hi));
      }
      ctx.stroke();
      if (t.peak) {
        const x = g.x0 + t.peak.bin * pxPerBin, y = yOf(t.peak.rms);
        ctx.fillStyle = t.color;
        ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x - 5, y - 11); ctx.lineTo(x + 5, y - 11); ctx.fill();
      }
    }
    ctx.restore();

    if (this.hover && this.hover.x >= g.x0 && this.hover.x <= g.x0 + g.pw && this.hover.y >= g.y0 && this.hover.y <= g.y0 + g.ph) {
      const f = (this.hover.x - g.x0) / g.pw * m.span;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.moveTo(Math.round(this.hover.x) + 0.5, g.y0); ctx.lineTo(Math.round(this.hover.x) + 0.5, g.y0 + g.ph); ctx.stroke();
      const lines = [[`f ${fmtSI(f, 'Hz', 4)}`, '#e6edf3']];
      for (const t of m.traces) {
        const v = t.rms[Math.min(t.rms.length - 1, Math.round(f / t.binHz))];
        lines.push([`${t.name} ${m.scale === 'db' ? `${(20 * Math.log10(Math.max(v, 1e-9))).toFixed(1)} dBV` : fmtSI(v, 'V')}`, t.color]);
      }
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const bw = Math.max(...lines.map(([l]) => ctx.measureText(l).width)) + 12, bh = lines.length * 16 + 6;
      let bx = this.hover.x + 12;
      if (bx + bw > g.x0 + g.pw) bx = this.hover.x - 12 - bw;
      ctx.fillStyle = 'rgba(12,16,22,0.85)';
      ctx.fillRect(bx, g.y0 + 4, bw, bh);
      lines.forEach(([l, col], i) => { ctx.fillStyle = col; ctx.fillText(l, bx + 6, g.y0 + 20 + i * 16); });
    }
  }
}
