// Simulated devices under test for the analyzer: transfer functions from the generator (channel
// A) to channel B. Used by the simulator and the tests. Pure.
import { cdiv, cx } from './detect.js';
import { model } from './speaker.js';

const jw = (f) => 2 * Math.PI * f;

// A 6.5" woofer: Re 5.6 Ω, Le 0.4 mH, fs 48 Hz, Qms 4.2, Qes 0.45.
export const SIM_DRIVER = { Re: 5.6, Le: 0.4e-3, fs: 48, Qms: 4.2, Res: 5.6 * 4.2 / 0.45 };
export const SIM_R = 47;

export const DUTS = {
  through: { label: 'Through (both probes on the wave out)', h: () => cx(1) },
  rc: {
    label: 'RC low-pass, 1 kΩ + 100 nF (fc 1.59 kHz)',
    h: (f) => cdiv(cx(1), cx(1, jw(f) * 1e3 * 100e-9)),
  },
  rlc: {
    // Series R-L-C, output across R: a band-pass at 1/(2π√LC) with Q = √(L/C)/R.
    label: 'RLC band-pass, 100 Ω + 10 mH + 100 nF (5.03 kHz, Q 3.2)',
    h: (f) => { const R = 100, L = 10e-3, C = 100e-9, w = jw(f); return cdiv(cx(R), cx(R, w * L - 1 / (w * C))); },
  },
  speaker: {
    label: `Loudspeaker behind ${SIM_R} Ω (fs 48 Hz, Qts 0.41)`,
    h: (f) => { const z = model(SIM_DRIVER, f); return cdiv(z, cx(SIM_R + z.re, z.im)); },
  },
};

// Channel B's front end in the simulator differs slightly from A's, as a real one would: the
// channel-match loopback measures and removes this.
export const SIM_B_GAIN = 1.004, SIM_B_DELAY = 6e-9;
