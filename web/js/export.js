// Saving what's on screen: PNG snapshot, CSV of the capture, and settings in a shareable link.

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** File-name friendly local timestamp: 2026-09-24_14-05-09. */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * CSV of frame `f`: time from the trigger (s), each trace in its unit, and the digital inputs.
 * traces: [{label, unit, data}] (the same arrays the screen shows); header: comment lines.
 */
export function frameCsv(f, traces, header = []) {
  const lines = header.map((h) => `# ${h}`);
  lines.push(['t (s)', ...traces.map((t) => `${t.label} (${t.unit})`), 'C', 'D'].join(','));
  for (let i = f.stale; i < f.count; i++) {
    const row = [+((i - f.pretrigger) / f.rate).toPrecision(8)];
    for (const t of traces) row.push(+t.data[i].toFixed(5));
    row.push(f.cd[i] & 1, f.cd[i] >> 1 & 1);
    lines.push(row.join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** The scope (and spectrum, if shown) on the page background, with caption lines under it. */
export function snapshotPng(canvases, caption, { bg = '#0d1117', fg = '#e6edf3' } = {}) {
  const dpr = window.devicePixelRatio || 1, pad = Math.round(8 * dpr), lh = Math.round(18 * dpr);
  const w = Math.max(...canvases.map((c) => c.width));
  const h = canvases.reduce((a, c) => a + c.height + pad, pad) + caption.length * lh + pad;
  const out = Object.assign(document.createElement('canvas'), { width: w + 2 * pad, height: h });
  const ctx = out.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  let y = pad;
  for (const c of canvases) { ctx.drawImage(c, pad, y); y += c.height + pad; }
  ctx.font = `${Math.round(12 * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'top';
  for (const [text, color] of caption) { ctx.fillStyle = color ?? fg; ctx.fillText(text, pad, y); y += lh; }
  return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

// Settings travel in the URL fragment (never sent to a server): #s=<base64url of JSON>.
export function shareLink(settings, base = location.href) {
  const bytes = new TextEncoder().encode(JSON.stringify(settings));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${base.split('#')[0]}#s=${b64}`;
}

/** Settings object from a location hash made by shareLink(), or null. */
export function sharedSettings(hash) {
  const m = /^#s=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return null;
  try {
    const bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch { return null; }
}
