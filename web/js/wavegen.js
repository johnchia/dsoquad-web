// Analog generator tables. The firmware plays whatever table it gets (docs/protocol.md SET_WAVE),
// so every waveform shape lives here.
import { DAC_MAX_RATE, TIMER_HZ, WAVE_MAX } from './protocol.js';

export const SHAPES = {
  sine: (x) => Math.sin(2 * Math.PI * x),
  triangle: (x) => 1 - 4 * Math.abs(((x + 0.25) % 1) - 0.5),
  ramp: (x) => 2 * x - 1,
};

// Wave-out voltage at DAC code 0 and the span to code 4095 (measured on HW 2.6 with firmware
// 0.5: 0.03-2.73 V into the scope input). Approximate: for display, not calibration.
export const DAC_V0 = 0.04, DAC_VSPAN = 2.68;

export const MIN_POINTS = 16;   // below this a "sine" is a staircase
export const MAX_ANALOG_HZ = Math.floor(DAC_MAX_RATE / MIN_POINTS);

/** Mirrors gen.c timer_div(): psc/arr for `hz` timer updates per second. */
export function timerDiv(hz) {
  const psc = Math.floor(Math.floor(TIMER_HZ / 65536) / hz);
  let a = Math.floor((Math.floor(TIMER_HZ / (psc + 1)) + Math.floor(hz / 2)) / hz);
  a = Math.min(Math.max(a, 2), 65536);
  return { psc, arr: a - 1 };
}

/** Frequency the firmware produces for an integer `freq` with an n-point table. */
export function analogActual(freq, n) {
  const { psc, arr } = timerDiv(freq * n);
  return TIMER_HZ / ((psc + 1) * (arr + 1)) / n;
}

/** Table length for `freq` (integer Hz): as many points as fit (≤ 512, ≤ 2 MS/s), trading a
 * few points for a closer frequency where the timer's integer divider would be off. */
export function planPoints(freq) {
  const nMax = Math.min(WAVE_MAX, Math.floor(DAC_MAX_RATE / freq));
  if (nMax < MIN_POINTS) return null;
  let best = null;
  for (let n = nMax; n >= Math.max(MIN_POINTS, Math.floor(nMax * 0.75)); n--) {
    const err = Math.abs(analogActual(freq, n) - freq) / freq;
    if (!best || err < best.err - 1e-9) best = { n, err };
    if (err === 0) break;
  }
  return { n: best.n, actual: analogActual(freq, best.n), err: best.err };
}

/** DAC codes for one period. amplitude and offset are fractions of full scale (0..1): the
 * output spans offset ± amplitude/2, clipped to the DAC range. */
export function table(shape, n, amplitude = 1, offset = 0.5) {
  const f = SHAPES[shape];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = offset + (amplitude / 2) * f(i / n);
    out[i] = Math.round(Math.min(1, Math.max(0, v)) * 4095);
  }
  return out;
}
