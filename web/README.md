# DSO Quad web UI

Static page: plain ES modules, no build step, no dependencies.

    python3 -m http.server -d web 8000     # then open http://localhost:8000 in Chrome/Edge

Web Serial needs a secure context: `http://localhost` works, but any other plain-http host doesn't.
The browser must run on the machine the DSO is plugged into.

| URL | Source |
|---|---|
| `/` | USB device. The first time, press **Connect** and pick "DSO Quad Web Control". After that the page reconnects automatically on load and whenever the device re-enumerates. |
| `/?sim` | Built-in simulator. CH A follows the generator (square wave when it's on, otherwise a 1 kHz sine); CH B is 2.7 kHz. |
| `/?play=recordings/square-1khz.dsoq` | Replays a recording made with `python3 tools/dsoq record ... -o web/recordings/x.dsoq`. |

Keys: **Space** run/stop, **S** single. Drag the markers on the scope: channel zeros (left),
trigger level (right) and trigger position (top).

Settings live in `localStorage` and are pushed to the device on every connect; the page owns
the settings, not the device. Export/Import in the Device panel saves them as JSON.

Files: `js/protocol.js` (codec, tested by `node --test tests/*.mjs` against the Python codec),
`js/device.js` (request/reply matching, coalescing of rapid changes), `js/transport.js`
(Web Serial, simulator, playback), `js/view.js` (canvas), `js/app.js` (UI and settings).
