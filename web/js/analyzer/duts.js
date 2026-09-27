// Simulated devices under test for the analyzer: transfer functions from the generator (channel
// A) to channel B. Used by the simulator and the tests. Pure.
import { cdiv, cx } from './detect.js';
import { model, RHO_C2 } from './speaker.js';

const jw = (f) => 2 * Math.PI * f;

// A 6.5" woofer: Re 5.6 Ω, Le 0.4 mH, fs 48 Hz, Qms 4.2, Qes 0.45.
export const SIM_DRIVER = { Re: 5.6, Le: 0.4e-3, fs: 48, Qms: 4.2, Res: 5.6 * 4.2 / 0.45 };
export const SIM_R = 47;
// Its mechanics (Vas follows: 13.7 L): the effective cone diameter 13 cm, Mms 20 g.
export const SIM_SD = Math.PI * 0.065 ** 2, SIM_MMS = 0.020;
export const SIM_MASS = 0.010, SIM_BOX = 0.010;   // the Vas tests: 10 g added, a 10 L box

/** The driver's electrical model with mass m (kg) on the cone, or in a sealed box of Vb (m³),
 * from Mms and Sd: Res = Bl²/Rms stays; fs and Qms move (lossless box, no change in air load). */
export function driverVariant(p, { m = 0, Vb = 0, Mms = SIM_MMS, Sd = SIM_SD } = {}) {
  const Cms = 1 / ((2 * Math.PI * p.fs) ** 2 * Mms);
  const C = Vb ? 1 / (1 / Cms + RHO_C2 * Sd * Sd / Vb) : Cms, M = Mms + m;
  const fs = 1 / (2 * Math.PI * Math.sqrt(M * C));
  return { ...p, fs, Qms: p.Qms * (fs * M) / (p.fs * Mms) };
}

const behindR = (p) => (f) => { const z = model(p, f); return cdiv(z, cx(SIM_R + z.re, z.im)); };

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
    h: behindR(SIM_DRIVER),
  },
  speakerMass: {
    label: `The same loudspeaker with ${SIM_MASS * 1e3} g on the cone`,
    h: behindR(driverVariant(SIM_DRIVER, { m: SIM_MASS })),
  },
  speakerBox: {
    label: `The same loudspeaker in a ${SIM_BOX * 1e3} L sealed box`,
    h: behindR(driverVariant(SIM_DRIVER, { Vb: SIM_BOX })),
  },
};

// Channel B's front end in the simulator differs slightly from A's, as a real one would: the
// channel-match loopback measures and removes this.
export const SIM_B_GAIN = 1.004, SIM_B_DELAY = 6e-9;
