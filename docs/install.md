# Installing DSO Quad web control

This replaces the scope app in the DSO Quad's first slot (APP1) with firmware that the browser
drives over USB. The factory bootloader and SYS stay untouched, so you can always go back.

**Tested on:** HW 2.6, SYS 1.52, FPGA 2.61 (shown on the boot screen). Other 2.6–2.72 units with
SYS ≥ 1.51 should work; HW 2.81 and the DS213 are untested and out of scope.

**You need:** Chrome or Edge on a desktop (Web Serial), a USB cable, and for the one-time setup a
Linux/macOS/Windows machine with `gcc-arm-none-eabi` to build the fallback scope (step 2).

## 1. Back up (recommended)

Power the DSO on normally and plug it in. It appears as a USB drive: copy everything on it
(settings and the stock calibration files) somewhere safe.

## 2. Install the fallback scope in APP3

The fallback is the gcc Community Edition scope app, rebuilt for the third slot. With it
installed, holding **○** at power-on gives you a normal standalone scope whatever is in APP1.
It has no license that allows redistribution, so it's built from source:

    git clone --recursive https://github.com/johnchia/dsoquad-web.git
    cd dsoquad-web
    make -C firmware/fallback fetch      # pinned upstream source into ref/dso203_gcc
    make -C firmware/fallback            # -> firmware/fallback/build/slot3/APP_G251_3.hex

Flash it with DFU mode (next section), then power on holding **○** to check it runs.

## 3. Flash the web-control firmware (once)

Download the current build from the app: <https://johnchia.github.io/dsoquad-web/firmware/dsoq_app1.hex>
(or build it: `make -C firmware/app`).

**DFU mode:** power off, hold **▶/||** (the first button), power on. The DSO shows up as a USB
drive named like `DFU V3_10_C`. Copy the `.hex` file onto it. The DSO programs it and renames
the file: `.RDY` means done. It sometimes says `.ERR` even though programming worked, so the
check that counts is the firmware version in the app (step 4). Power-cycle the DSO.

On Linux, `tools/dfu-flash.sh <file.hex>` does the copy and refuses files that would touch the
bootloader, SYS or the FPGA image (`make -C firmware/app flash` for the firmware).

After a normal power-on the DSO's screen shows "DSO Quad Web Control" and the firmware version.

## 4. Connect

Open <https://johnchia.github.io/dsoquad-web/> in Chrome or Edge, press **Connect** and pick
"DSO Quad Web Control". From then on the page connects by itself when it opens and whenever the
DSO is plugged in. The Device panel shows the firmware version.

- **Windows 10/11 and macOS:** no driver needed (built-in USB serial).
- **Linux:** your user needs access to the serial port. Either join the `dialout` group, or
  install the udev rule, which also stops ModemManager probing the port:

      sudo cp tools/udev/70-dsoquad.rules /etc/udev/rules.d/
      sudo udevadm control --reload && sudo udevadm trigger

  (the rule grants the `plugdev` group; log out and in after joining a group).

The browser must run on the computer the DSO is plugged into; the page itself can come from
anywhere (it's static and talks to the DSO locally).

## 5. Calibrate

Device panel → **Calibrate…**. Zero first, with both probes shorted to their ground clips (open
inputs read ~20 mV off). Gain is optional: connect a DC voltage you know (the wave out held high
and a multimeter work) and measure it on each channel. The result is stored on the DSO, so it
follows the device to any computer.

## Updating

Device panel → **Firmware…** installs the build published with the page, or a `.hex` you pick, in
a few seconds over USB (firmware ≥ 0.6). The button reads **Update firmware…** when the page
carries a different build than the DSO runs. Calibration is kept.

From a checkout: `make -C firmware/app update` (or `python3 tools/dsoq flash file.hex`).

## Getting back to a normal scope

| How | Result |
|---|---|
| Power on holding **○** | The fallback scope in APP3, this time only |
| Hold **□ + ○** for 2 s while web control runs | Same, from inside the firmware |
| DFU mode, copy another APP1 `.hex` (e.g. the Community Edition built with `make -C firmware/fallback SLOT=1`) | Replaces web control for good |

DFU mode lives in the factory bootloader, which nothing here ever writes, so it always works.
If an update ever leaves the DSO unresponsive, power it on in DFU mode and copy a `.hex`.

## Troubleshooting

- **Not in the port chooser:** is the DSO on the web-control firmware (its screen says so)? On
  Linux, check permissions (above). A VM needs the USB device passed through again after the DSO
  restarts (it re-enumerates).
- **Connects but no trace:** channel A/B enabled? Trigger mode Normal with no signal crossing the
  level waits forever; Auto shows the signal anyway.
- **Readings off by tens of mV:** calibrate zero with the inputs shorted.
