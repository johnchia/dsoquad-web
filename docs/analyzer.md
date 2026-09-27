# Analyzer

The page's **Analyzer** view (header switch Scope | Analyzer) turns the DSO Quad into a stepped-sine
network analyzer: the wave out drives the circuit, channel A reads the drive and channel B the
result, and every reading is the ratio B/A at one frequency. It needs three leads: the wave out
and both probes, all grounds together.

## How it measures

- **Coherent sampling.** The generator and the ADC share the 72 MHz clock, so each point's
  capture holds a whole number of generator cycles and the fundamental falls exactly on one DFT
  bin: no window, no leakage. The planner picks the table length and capture divider per point
  (1 Hz to 125 kHz; every point fills at least 4000 of the 4088 usable samples).
- **Ratios, not levels.** B/A cancels the generator's level, its flatness and its output
  impedance. Readings are ratios from simultaneous captures, averaged as ratios.
- **Auto-ranging.** Both channels range per point to fill about 6 of the 8 divisions; each point
  waits max(3 periods, 50 ms, your extra) to settle, and readings are repeated when they disagree.
- **Channel match.** Two uncalibrated channels differ by about 0.13 dB and up to 0.6° at 100 kHz,
  and each range's gain is off by up to ±0.5 dB. **Measure…** under Channel match (both probes on
  the wave out, nothing else connected, about 30 s) sweeps B/A from 10 Hz to 125 kHz and chains
  every range's gain against its neighbours, then stores the result on the DSO (store tag 2).
  With it applied, results are right even when A and B sit on different ranges. Measure it with
  the coupling you'll use: DC and AC differ below about 50 Hz.

## Modes

### Frequency response

Wave out and A on the circuit's input, B on its output. Result: B/A in dB and degrees; readouts
for the peak, the −3 dB points (with **Refine**, three extra points are measured around each one
and around the peak) and the ±45° crossings. The −45° point is fc of a first-order low-pass and,
unlike the −3 dB point, doesn't move with a gain error.

For a loudspeaker's acoustic response: A on the amplifier's input, B on a measurement microphone's
preamp output (at least ~150 mV peak to use the 50 mV/div range well). Stepped sine includes the
room, as any steady-state measurement does; smooth it afterwards. **EQ file (.frd)** saves it for
an equaliser (below).

**Amplifier output impedance** (tick it): sweep with nothing on the amplifier's output and press
**Keep as reference**, then connect a load resistor RL (enter its measured value) and sweep again:
Zout = RL·(reference/now − 1), shown as R + L at 100 Hz, 1 kHz and 10 kHz with the damping factor
into 8 Ω. See the warnings below about bridged outputs.

### Impedance

```
wave out ── C (optional) ──●── R ──●── device ── ground
                           A       B
```

Z = R·B/(A−B). R is 10–100 Ω and its exact value matters (measure it and enter it). The optional
capacitor keeps the generator's DC out of the device (bipolar, ≥ 1000 µF for a speaker); A must go
**after** it, or Z is wrong. Accuracy is best for |Z| between R/10 and 10·R.

With a resonance in the sweep (a loudspeaker) the page fits the driver model, Re + jωLe in series
with a parallel RLC, and reports Re, fs, Zmax, Qms, Qes, Qts and Le, with the model drawn dashed.
**Re at DC** measures Re with two DC levels (only without the capacitor); otherwise it is fitted.

**Vas** needs a second sweep, compared against the reference:

- *Added mass:* sweep in free air (driver lying flat, away from walls) and **Keep as reference**;
  stick a weighed mass evenly around the dust cap (about the cone's own mass, 10–20 g for a 6.5″)
  and sweep again. fs should drop by 25 % or more.
- *Sealed box:* sweep in free air, keep it, then seal the driver into a closed box of known net
  volume (unstuffed) and sweep again.

Enter the cone's effective diameter (the cone plus about a third of the surround on each side).
The page then gives Vas, Mms, Cms, Rms, Bl, η0, the half-space sensitivity (1 W and 2.83 V at 1 m)
and EBP. Which sweep is free air is worked out from the fs values, so either order works.

### Level

One frequency, the generator's amplitude stepped from *from* to *to* % (log spaced): the gain and
the distortion of an amplifier against its output voltage, the compression at the top, and where
the added THD reaches 1 %, with the power into the load you enter. Turn the amplifier's volume up
so it clips inside the range. Wiring as for frequency response.

"THD added" is what B adds to A's: B's harmonics less what A's own harmonics become through a flat
gain with a delay (or an inversion). This takes out the generator's own distortion (0.2 % at
40 % level, up to 1.8 % at 100 %), as long as the amplifier is flat to the 5th harmonic. The
dashed trace is the noise floor. On top of it, the two 8-bit ADCs distort slightly differently,
0.1–0.7 % (measured through a flat path, worst on small signals), so the mode finds clipping and
the 1 % point, not a clean amplifier's distortion.

## Export

- **CSV:** every point with both channels' amplitude, THD, V/div, spread and readings.
- **PNG** of the plot.
- **EQ file (.frd):** frequency, dB and phase, with `*` comment lines. REW, VituixCAD and
  esp32-airplay's equaliser (*Fit to a measurement*, which fits only the shape and needs at
  least 16 points) read it. In frequency response mode it is the sweep itself. In impedance mode
  it is the driver's small-signal low-frequency response modelled from the fit,
  s²/(s² + s·ωs/Qts + ωs²), from 10 Hz to 20 kHz: infinite baffle, no cone break-up, baffle step,
  directivity or room. Fit the EQ below a few times fs with it; for anything above, measure with a
  microphone.

## Limits and warnings

- **Signal:** the wave out gives a 1.18 V peak sine at 90 % (flat within 0.3 % from 20 Hz to
  62 kHz, +0.5 dB at 100 kHz) around a DC offset. It is not a power source: drive amplifier inputs,
  filters and the impedance divider, not a speaker directly.
- **Inputs:** ±40 V on 10 V/div with the 1× leads. For more, use a 10× probe on B; ratios between
  two sweeps (output impedance) are unaffected, absolute gains then read 20 dB low.
- **Ground:** both probe grounds are the DSO's ground. **Never clip a ground lead to a bridged
  (BTL) amplifier output**, as on most class-D amplifiers: it shorts one half of the bridge. Only
  measure outputs whose negative is ground.
- **8 bits:** noise and ADC distortion limit THD to about 0.5–1 % resolution; B/A repeats to about
  0.005 dB / 0.04° within a run and 0.04 dB / 0.1° between runs.
- **AC coupling** settles with τ ≈ 1 s; the runner waits 5 s after switching to it.
- **Components:** a class-2 ceramic capacitor (X7R, Y5V) changes with level, frequency and DC bias
  by several percent, so it is a poor reference for checking the analyzer. Use a film capacitor or
  a resistor divider.

## Hardware scripts

With the DSO on USB, from the repository root (Node 20):

- `node tools/node/match.mjs [--ac] [--store]`: the channel match (prints it; `--store` saves it).
- `node tools/node/sweep.mjs [from] [to] [points per decade]`: a frequency-response sweep with the
  stored match applied (`DSOQ_CSV=file`, `DSOQ_LEVEL=0..1`, `DSOQ_AC=1`).
- `node tools/node/level.mjs [Hz] [from %] [to %] [steps]`: a level sweep with added THD and floor.
- `node tools/node/m6probe.mjs [match|purity|settle]`: the generator and channel facts above.
