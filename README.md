# DSO Quad web control

Replacement firmware and a browser UI for the Seeed/e-Design **DSO Quad (DS203)** pocket
oscilloscope. The DSO shows up as a USB serial device and is controlled entirely from
Chrome/Edge through Web Serial: channels, timebase, trigger, generator, calibration.

**Open the app: https://johnchia.github.io/dsoquad-web/** (`?sim` for the simulator)

**Installing:** [docs/install.md](docs/install.md) (one DFU flash, then updates from the page).

- `firmware/app`: the APP1 firmware (runs on the stock SYS 1.52 BIOS; USB CDC via TinyUSB).
  Build with `make -C firmware/app` (needs `gcc-arm-none-eabi`, `git submodule update --init`),
  flash with `make -C firmware/app flash` while the DSO is in DFU mode (hold ▶/|| at power-on).
- `web/`: the UI (static, no build step). `web/README.md` has details.
- `tools/dsoq`: Python client/CLI (`python3 tools/dsoq info`, `capture`, `record`, `cal`...).
- `docs/protocol.md`: the wire protocol. `PLAN.md`: design notes and milestones.

## What it runs on

**The oscilloscope.** The firmware is an APP on top of the DSO Quad's own SYS BIOS, so it depends
on the SYS call interface, the flash layout and the FPGA behind it.

| Device | Status |
|---|---|
| DSO Quad / DS203 **HW 2.6**, SYS 1.52, FPGA 2.61 | **Tested** (the development unit) |
| DSO Quad HW 2.7–2.72 with SYS ≥ 1.51 and FPGA 2.61 | Should work, untested: same MCU (256 KB flash), flash layout and FPGA, and the SYS calls it uses exist since SYS 1.50 |
| DSO Quad HW 2.81/2.82 (SYS 1.64) | Not supported yet. Seeed changed the FPGA chip (its image doubled in size and moved from `0x0802C000` to `0x0805C800`) and the flash grew to 512 KB. Apps in the normal slots are reported to run, but the FPGA behaviour this firmware depends on (FIFO timing, interleaving) is unverified, and the calibration store page would need a new home. Probably a small port; reports welcome |
| DS212, DS213, LA104 and other e-Design devices | No: different hardware and BIOS. The web page and protocol could be reused with new firmware |

**The computer.** The page talks to the DSO through Web Serial.

| Browser / OS | Status |
|---|---|
| Chrome or Edge (89+) on Linux | **Tested** |
| Chrome, Edge or Opera on Windows 10/11, macOS, ChromeOS | Should work: the DSO is a standard USB serial (CDC-ACM) device with built-in drivers everywhere. Untested |
| Chrome on Android | Maybe, untested. Chrome 148 added Web Serial on Android, but USB serial ports need Android's new Serial API, which is rolling out from mid-2026 on a limited set of devices. Needs a USB OTG cable |
| Firefox, Safari, anything on iOS | No Web Serial. The simulator (`?sim`) and playback of recordings still work there |
| Python CLI (`tools/dsoq`) | Anywhere with Python 3 and pyserial |

The browser must run on the computer the DSO is plugged into. The page itself is static and can
be served from anywhere.

Escape routes: DFU mode (hold ▶/|| at power-on) always works and can flash any APP, including a
return to the stock or Community Edition scope. Use at your own risk.
