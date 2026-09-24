# DSO Quad web UI

Static page: plain ES modules, no build step, no dependencies.

Hosted at **https://johnchia.github.io/dsoquad-web/** (deployed from `master` by
`.github/workflows/pages.yml` after the tests pass). For local development:

    python3 -m http.server -d web 8000     # then open http://localhost:8000 in Chrome/Edge

Web Serial needs a secure context: https or `http://localhost` work, plain http elsewhere and
`file://` don't (the page uses ES modules, which Chrome won't load from `file://`).
The browser must run on the machine the DSO is plugged into.

| URL | Source |
|---|---|
| `/` | USB device. The first time, press **Connect** and pick "DSO Quad Web Control". After that the page reconnects automatically on load and whenever the device re-enumerates. |
| `/?sim` | Built-in simulator. CH A follows the generator (square wave when it's on, otherwise a 1 kHz sine); CH B is 2.7 kHz. |
| `/?play=recordings/square-1khz.dsoq` | Replays a recording made with `python3 tools/dsoq record ... -o web/recordings/x.dsoq`. |

Keys: **Space** run/stop, **S** single, **A** auto set. Drag the markers on the scope: trace zeros (left: A, B,
math M), trigger level (right) and trigger position (top). Cursors (Display panel) are dragged
by their tabs or anywhere along their lines.

- **Auto set** (header button or **A**): picks V/div and position for each enabled channel (one
  trace centred, or A above B), a time/div that shows about three periods, and a rising-edge
  trigger at the middle of the signal. It keeps the current trigger channel when that has a
  usable signal. It takes a few quick captures, under a second for signals above ~100 Hz and up
  to a few seconds for slow ones; with no periodic signal it leaves the time/div alone.
- **Measure:** pick any of Vpp, Vavg, Vrms, AC rms, max, min, top, base, amplitude, frequency,
  period, duty, ±width, rise and fall (10–90 %). Mean and rms use whole cycles when there are
  edges; a rise/fall at the time resolution shows as "< 1 sample".
- **Display:** time and voltage cursors, persistence (short, long, infinite), math (A+B, A−B,
  B−A, A×B) with its own scale, and XY mode.
- **72 MS/s:** with channel B, math and XY off, time bases faster than 5 µs/div interleave both
  ADCs on channel A (firmware ≥ 0.7).
- **Saving:** PNG (screen with scales and measurements), CSV (the capture in volts, time from
  the trigger), and **Link**: copies a URL whose fragment holds the settings (nothing is sent to
  a server). Opening it loads those settings.
- **Firmware…** (Device panel): installs the firmware published with the page, or a `.hex`, over
  USB (firmware ≥ 0.6).

Settings live in `localStorage` and are pushed to the device on every connect; the page owns
the settings, not the device. Export/Import in the Device panel saves them as JSON. Channels, timebase and trigger sit in a strip across the bottom; Measure, Display, Generator, FFT and Device are in the sidebar.

Files: `js/protocol.js` (codec, tested by `node --test tests/*.mjs` against the Python codec),
`js/device.js` (request/reply matching, coalescing of rapid changes), `js/transport.js`
(Web Serial, simulator, playback), `js/view.js` (canvas), `js/measure.js` (measurements),
`js/export.js` (PNG, CSV, links), `js/fw-ui.js` (firmware update), `js/app.js` (UI and settings).
