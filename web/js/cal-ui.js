// Calibration dialog. Works on a draft; only "Save to device" writes the flash store.
import * as Cal from './calibration.js';
import { fmtSI } from './view.js';

const $ = (id) => document.getElementById(id);

/**
 * ctx: {dev, ranges: V/div per range, cal: current calibration,
 *       suspend(on): stop/resume the app driving the device, onSaved(cal), toast(msg)}
 */
export function openCalDialog(ctx) {
  const dlg = $('cal-dialog');
  const { dev, ranges } = ctx;
  let draft = structuredClone(ctx.cal);
  const fresh = new Set();     // "ch/range/field" updated in this session
  let busy = null;             // AbortController of the running measurement
  let gainCh = 0;
  let dirty = false;

  ctx.suspend(true);

  const setBusy = (on) => {
    for (const id of ['cal-zero', 'cal-gain', 'cal-save', 'cal-reset', 'cal-wave-high']) $(id).disabled = on;
    $('cal-cancel').textContent = on ? 'Stop' : 'Discard';
  };
  const progress = (frac, msg) => { $('cal-progress').value = frac; $('cal-msg').textContent = msg; };

  function render() {
    const t = $('cal-table');
    const head = '<tr><th>V/div</th><th>A zero error</th><th>A offset scale</th><th>A gain</th><th>B zero error</th><th>B offset scale</th><th>B gain</th></tr>';
    const rows = ranges.map((vd, r) => {
      const cells = [0, 1].map((ch) => {
        const e = draft.ch[ch][r];
        const cls = (f, ok) => (fresh.has(`${ch}/${r}/${f}`) ? 'new' : ok ? '' : 'none');
        // Zero error shown where the stock position puts 0 V: mid-screen (offset register 154).
        const errDiv = (e.a + e.b * 154 - 154) / 25;
        return e.zeroCal
          ? `<td class="${cls('z', true)}">${errDiv >= 0 ? '+' : ''}${errDiv.toFixed(2)} div</td><td class="${cls('z', true)}">${e.b.toFixed(4)}</td>`
            + `<td class="${cls('g', e.gainCal)}">${e.gainCal ? e.gain.toFixed(4) : '—'}</td>`
          : `<td class="none">—</td><td class="none">—</td><td class="${cls('g', e.gainCal)}">${e.gainCal ? e.gain.toFixed(4) : '—'}</td>`;
      });
      return `<tr><td>${fmtSI(vd, 'V')}</td>${cells.join('')}</tr>`;
    });
    t.innerHTML = head + rows.join('');
  }

  async function run(fn) {
    busy = new AbortController();
    setBusy(true);
    try {
      await fn(busy.signal);
    } catch (e) {
      progress(0, e.name === 'AbortError' ? 'Stopped' : `Failed: ${e.message}`);
    } finally {
      busy = null;
      setBusy(false);
      render();
    }
  }

  $('cal-zero').onclick = () => run(async (signal) => {
    await dev.setGen(0, 1000, 50);
    if (dev.t.simulated) dev.t.inputsOpen = true;   // the simulator "unplugs" its inputs
    let res;
    try { res = await Cal.runZero(dev, draft, { onProgress: progress, signal }); } finally { if (dev.t.simulated) dev.t.inputsOpen = false; }
    const { cal, report } = res;
    draft = cal;
    dirty = true;
    report.forEach((x) => fresh.add(`${x.ch}/${x.range}/z`));
    const worst = Math.max(...report.map((x) => x.resid));
    const noisy = report.filter((x) => x.noise > 3);
    const oldGains = draft.ch.flat().some((e) => e.gainCal);
    progress(1, `Zero measured. Fit residual ≤ ${worst.toFixed(2)} codes`
      + (noisy.length ? `; noisy on ${noisy.length} range(s): are both inputs shorted to ground?` : '.')
      + (oldGains ? ' Gains were measured against the previous zero: measure them again for best accuracy.' : ''));
  });

  $('cal-wave-high').onclick = async () => {
    try { await dev.setGen(1, 1000, 100); progress(0, 'Wave out held high: measure it now.'); } catch (e) { ctx.toast(e.message); }
  };

  dlg.querySelector('.seg[data-for="cal-ch"]').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    gainCh = +b.value;
    dlg.querySelectorAll('.seg[data-for="cal-ch"] button').forEach((x) => x.classList.toggle('active', x === b));
  };

  $('cal-gain').onclick = () => {
    const volts = parseFloat($('cal-volts').value);
    if (!Number.isFinite(volts) || volts === 0) { progress(0, 'Enter the reference voltage first.'); return; }
    if (!draft.ch[gainCh].some((e) => e.zeroCal)) { progress(0, 'Measure zero first: gain is measured from the calibrated zero.'); return; }
    run(async (signal) => {
      const { cal, report } = await Cal.runGain(dev, draft, gainCh, volts, ranges, { onProgress: progress, signal });
      draft = cal;
      const used = report.filter((x) => x.used);
      used.forEach((x) => fresh.add(`${x.ch}/${x.range}/g`));
      dirty ||= used.length > 0;
      const skipped = report.filter((x) => !x.used);
      progress(1, `CH ${'AB'[gainCh]}: gain set on ${used.map((x) => fmtSI(ranges[x.range], 'V')).join(', ') || 'no range'}`
        + (skipped.length ? `; skipped ${skipped.map((x) => `${fmtSI(ranges[x.range], 'V')} (${x.clipped ? 'clipped' : `gain ${x.gain.toFixed(3)} looks wrong`})`).join(', ')}` : ''));
    });
  };

  $('cal-reset').onclick = () => {
    draft = Cal.nominal();
    fresh.clear();
    dirty = true;
    progress(0, 'Reset: press Save to device to clear the stored calibration.');
    render();
  };

  const close = () => {
    busy?.abort();
    dlg.close();
  };

  $('cal-cancel').onclick = () => {
    if (busy) { busy.abort(); return; }
    close();
  };

  $('cal-save').onclick = async () => {
    setBusy(true);
    try {
      const empty = draft.ch.flat().every((e) => !e.zeroCal && !e.gainCal);
      await Cal.saveTo(dev, empty ? null : draft);
      const check = await Cal.loadFrom(dev);   // read back what the device now holds
      ctx.onSaved(check);
      dirty = false;
      close();
      ctx.toast(empty ? 'Calibration cleared on the device' : 'Calibration saved to the device', 'info');
    } catch (e) {
      progress(0, `Save failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  dlg.onclose = () => { busy?.abort(); ctx.suspend(false); };
  dlg.oncancel = (e) => { if (dirty && !confirm('Discard the new calibration?')) e.preventDefault(); };

  progress(0, '');
  render();
  setBusy(false);
  dlg.showModal();
}
