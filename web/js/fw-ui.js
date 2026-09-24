// Firmware update dialog: installs the build published with this page (firmware/manifest.json)
// or a local .hex over USB (Device.fwUpdate, firmware >= 0.6).
import * as P from './protocol.js';

const $ = (id) => document.getElementById(id);

let manifest;   // promise of {fw, file, size, crc32} or null
/** The firmware published with this page, or null (e.g. file:// or a dev server without it). */
export function bundledFirmware() {
  manifest ??= fetch('firmware/manifest.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return manifest;
}

/** ctx: {dev, fw (installed version), suspend(on), onCommitted(version), toast(msg, kind)} */
export async function openFwDialog(ctx) {
  const dlg = $('fw-dialog');
  let busy = false;
  const progress = (frac, msg) => { $('fw-progress').value = frac; $('fw-msg').textContent = msg; };
  const setBusy = (on) => {
    busy = on;
    for (const id of ['fw-install', 'fw-file-btn', 'fw-close']) $(id).disabled = on;
  };

  async function install(image, label) {
    const version = P.imageVersion(image);
    if (!confirm(`Install ${version ?? label} on the DSO?`)) return;
    setBusy(true);
    ctx.suspend(true);
    try {
      await ctx.dev.fwUpdate(image, (f, what) => progress(f, `${what} ${Math.round(f * 100)}%`));
      progress(1, 'installed, restarting…');
      ctx.onCommitted(version);
      dlg.close();
    } catch (e) {
      const old = /UNKNOWN_TYPE/.test(e.message);
      progress(0, old ? 'This firmware can\'t update itself (needs 0.6 or newer): flash once via DFU.'
        : /BAD_LENGTH/.test(e.message) ? 'Image too large to stage next to the running firmware: use DFU.'
          : `Failed: ${e.message}. The installed firmware is unchanged.`);
      ctx.suspend(false);
    } finally {
      setBusy(false);
    }
  }

  progress(0, '');
  $('fw-installed').textContent = ctx.fw;
  $('fw-bundled').textContent = 'checking…';
  $('fw-install').disabled = true;
  dlg.onclose = () => { if (busy) dlg.showModal(); };  // no Esc while flashing
  $('fw-close').onclick = () => dlg.close();
  $('fw-file-btn').onclick = () => $('fw-file').click();
  $('fw-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { await install(P.hexToImage(await file.text()), file.name); } catch (err) { progress(0, err.message); }
  };
  dlg.showModal();

  const m = await bundledFirmware();
  if (!m) { $('fw-bundled').textContent = 'none (install from a file)'; return; }
  const same = m.fw === ctx.fw;
  $('fw-bundled').textContent = same ? `${m.fw} (installed)` : m.fw;
  $('fw-install').textContent = same ? 'Reinstall' : 'Install';
  $('fw-install').disabled = false;
  $('fw-install').onclick = async () => {
    try {
      const r = await fetch(`firmware/${m.file}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const image = P.hexToImage(await r.text());
      if (P.crc32(image).toString(16).padStart(8, '0') !== m.crc32) throw new Error('download corrupted (CRC mismatch)');
      await install(image, m.fw);
    } catch (err) { progress(0, err.message); }
  };
}
