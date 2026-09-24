// Two stacked panes against log frequency (gain over phase, or |Z| over phase), with a hover
// readout and markers. Knows nothing about devices; setData() gives it everything.

const C = {
  bg: '#0d1117', grid: '#2c3440', minor: '#1c232d', axis: '#8b949e', text: '#e6edf3',
  series: ['#f5d90a', '#3fd4f4'], ref: '#8b949e', marker: '#ff8c42',
};
const M = { l: 56, r: 14, t: 10, b: 24, gap: 26 };

const fmtF = (f) => (f >= 1e3 ? `${+(f / 1e3).toPrecision(3)}k` : `${+f.toPrecision(3)}`);

/** Grid step and range for [lo, hi] with about `n` lines, from `steps`. */
function niceAxis(lo, hi, steps, n = 6, minSpan = 0) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (hi - lo < minSpan) { const m = (hi + lo) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2; }
  const step = steps.find((s) => (hi - lo) / s <= n) ?? steps[steps.length - 1];
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

export class BodePlot {
  /**
   * panes: [{label, unit, key, steps, minSpan, fmt}, …] top to bottom; each series point has
   * {f, [key]: value}.
   */
  constructor(canvas, panes) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.panes = panes;
    this.data = { series: [], markers: [], f0: 10, f1: 100000 };
    this.hoverF = null;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => {
      const g = this._geom(), x = e.offsetX;
      this.hoverF = x >= g.x0 && x <= g.x0 + g.pw ? this._fOfX(g, x) : null;
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => { this.hoverF = null; this.draw(); });
  }

  /** series: [{label, pts, color?, dashed?}], markers: [{f, label}], f0/f1: the x range. */
  setData(d) { this.data = { ...this.data, ...d }; this.draw(); }

  setPanes(panes) { this.panes = panes; this.draw(); }

  _geom() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const n = this.panes.length, pw = w - M.l - M.r;
    const ph = (h - M.t - M.b - M.gap * (n - 1)) / n;
    return { w, h, x0: M.l, pw, ph, y0: (i) => M.t + i * (ph + M.gap) };
  }

  _xOfF(g, f) { const { f0, f1 } = this.data; return g.x0 + g.pw * Math.log(f / f0) / Math.log(f1 / f0); }
  _fOfX(g, x) { const { f0, f1 } = this.data; return f0 * (f1 / f0) ** ((x - g.x0) / g.pw); }

  /** Value of `key` at f in a series, interpolated in log f (null outside it). */
  static at(pts, f, key) {
    for (let i = 1; i < pts.length; i++) {
      if (f >= pts[i - 1].f && f <= pts[i].f) {
        const t = Math.log(f / pts[i - 1].f) / Math.log(pts[i].f / pts[i - 1].f);
        return pts[i - 1][key] + t * (pts[i][key] - pts[i - 1][key]);
      }
    }
    return pts.length === 1 && Math.abs(Math.log(f / pts[0].f)) < 0.05 ? pts[0][key] : null;
  }

  draw() {
    const cv = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const x = this.ctx;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = C.bg; x.fillRect(0, 0, w, h);
    const g = this._geom(), { series, markers, f0, f1 } = this.data;
    x.font = '11px system-ui, sans-serif';

    this.panes.forEach((pane, i) => {
      const top = g.y0(i);
      let lo = Infinity, hi = -Infinity;
      for (const s of series) for (const p of s.pts) { const v = p[pane.key]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      const ax = niceAxis(lo, hi, pane.steps, 6, pane.minSpan);
      const yOf = (v) => top + g.ph * (1 - (v - ax.lo) / (ax.hi - ax.lo));

      // Grid: decades, 2–9 minors, value lines.
      x.lineWidth = 1;
      for (let d = Math.floor(Math.log10(f0)); d <= Math.ceil(Math.log10(f1)); d++) {
        for (let m = 1; m < 10; m++) {
          const f = m * 10 ** d;
          if (f < f0 * 0.999 || f > f1 * 1.001) continue;
          const px = Math.round(this._xOfF(g, f)) + 0.5;
          x.strokeStyle = m === 1 ? C.grid : C.minor;
          x.beginPath(); x.moveTo(px, top); x.lineTo(px, top + g.ph); x.stroke();
          if (m === 1 || (m === 2 || m === 5)) {
            if (i === this.panes.length - 1) { x.fillStyle = C.axis; x.textAlign = 'center'; x.fillText(fmtF(f), px, top + g.ph + 15); }
          }
        }
      }
      x.textAlign = 'right';
      for (let v = ax.lo; v <= ax.hi + 1e-9; v += ax.step) {
        const py = Math.round(yOf(v)) + 0.5;
        x.strokeStyle = C.grid; x.beginPath(); x.moveTo(g.x0, py); x.lineTo(g.x0 + g.pw, py); x.stroke();
        x.fillStyle = C.axis; x.fillText(pane.fmt ? pane.fmt(v) : `${+v.toPrecision(4)}`, g.x0 - 6, py + 4);
      }
      x.save(); x.translate(12, top + g.ph / 2); x.rotate(-Math.PI / 2); x.textAlign = 'center'; x.fillStyle = C.text;
      x.fillText(`${pane.label} (${pane.unit})`, 0, 0); x.restore();

      // Traces, clipped to the pane.
      x.save(); x.beginPath(); x.rect(g.x0, top, g.pw, g.ph); x.clip();
      series.forEach((s, k) => {
        x.strokeStyle = s.color ?? C.series[k % C.series.length]; x.lineWidth = 1.6;
        x.setLineDash(s.dashed ? [5, 4] : []);
        x.beginPath();
        let pen = false;
        for (const p of s.pts) {
          const v = p[pane.key];
          if (!Number.isFinite(v)) { pen = false; continue; }
          const px = this._xOfF(g, p.f), py = yOf(v);
          if (pen) x.lineTo(px, py); else x.moveTo(px, py);
          pen = true;
        }
        x.stroke();
        x.setLineDash([]);
        if (s.pts.length < 60) {
          x.fillStyle = x.strokeStyle;
          for (const p of s.pts) if (Number.isFinite(p[pane.key])) { x.beginPath(); x.arc(this._xOfF(g, p.f), yOf(p[pane.key]), 2, 0, 2 * Math.PI); x.fill(); }
        }
      });
      (markers ?? []).filter((m) => m.f >= f0 && m.f <= f1).forEach((m, k) => {
        const px = Math.round(this._xOfF(g, m.f)) + 0.5;
        x.strokeStyle = C.marker; x.setLineDash([3, 3]); x.beginPath(); x.moveTo(px, top); x.lineTo(px, top + g.ph); x.stroke(); x.setLineDash([]);
        if (i === 0) {
          // Labels on alternate rows so neighbours don't collide; left of the line near the right edge.
          const right = px + 4 + x.measureText(m.label).width > g.x0 + g.pw;
          x.fillStyle = C.marker; x.textAlign = right ? 'right' : 'left';
          x.fillText(m.label, right ? px - 4 : px + 4, top + 12 + 14 * (k % 2));
        }
      });
      x.restore();
      x.strokeStyle = C.grid; x.strokeRect(g.x0 + 0.5, top + 0.5, g.pw, g.ph);

      // Hover readout.
      if (this.hoverF) {
        const px = this._xOfF(g, this.hoverF);
        x.strokeStyle = C.text; x.globalAlpha = 0.5; x.beginPath(); x.moveTo(px, top); x.lineTo(px, top + g.ph); x.stroke(); x.globalAlpha = 1;
        const parts = series.map((s, k) => {
          const v = BodePlot.at(s.pts, this.hoverF, pane.key);
          return v === null ? null : { text: `${s.label ? `${s.label} ` : ''}${pane.fmt ? pane.fmt(v, true) : v.toPrecision(4)} ${pane.unit}`, color: s.color ?? C.series[k % C.series.length] };
        }).filter(Boolean);
        const head = i === 0 ? `${fmtF(this.hoverF).replace(/k$/, " k").replace(/(\d)$/, "$1 ")}Hz  ` : '';
        let tx = g.x0 + 8;
        x.textAlign = 'left'; x.fillStyle = C.text; x.fillText(head, tx, top + g.ph - 8); tx += x.measureText(head).width;
        for (const p of parts) { x.fillStyle = p.color; x.fillText(p.text, tx, top + g.ph - 8); tx += x.measureText(p.text).width + 14; }
      }
    });
    if (!series.some((s) => s.pts.length)) {
      x.fillStyle = C.axis; x.textAlign = 'center';
      x.fillText('No sweep yet: set the range and press Start', g.x0 + g.pw / 2, g.y0(0) + g.ph / 2);
    }
  }
}
