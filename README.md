# DSO Quad web control

Replacement firmware and a browser UI for the Seeed/e-Design **DSO Quad (DS203)** pocket
oscilloscope. The DSO shows up as a USB serial device and is controlled entirely from
Chrome/Edge through Web Serial: channels, timebase, trigger, generator, calibration.

**Open the app: https://johnchia.github.io/dsoquad-web/** (`?sim` for the simulator)

- `firmware/app`: the APP1 firmware (runs on the stock SYS 1.52 BIOS; USB CDC via TinyUSB).
  Build with `make -C firmware/app` (needs `gcc-arm-none-eabi`, `git submodule update --init`),
  flash with `make -C firmware/app flash` while the DSO is in DFU mode (hold ▶/|| at power-on).
- `web/`: the UI (static, no build step). `web/README.md` has details.
- `tools/dsoq`: Python client/CLI (`python3 tools/dsoq info`, `capture`, `record`, `cal`...).
- `docs/protocol.md`: the wire protocol. `PLAN.md`: design notes and milestones.

Tested on HW 2.6, SYS 1.52, FPGA 2.61. Escape routes back to a normal scope: power on holding
○ boots the Community Edition fallback from APP3 (`firmware/fallback`), and DFU mode is always
available for reflashing. Use at your own risk.
