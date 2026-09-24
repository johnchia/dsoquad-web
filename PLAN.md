# DSO Quad Web Interface: Feasibility & Plan

Goal: control a Seeed/e-Design **DSO Quad (DS203)** from a **web browser over USB**.
Three pieces are needed:

1. **USB serial on the device.** The stock firmware only exposes USB Mass Storage, so the device firmware has to present itself as a USB CDC-ACM serial port.
2. **Control/acquisition firmware** that takes commands over serial and streams captured waveforms back.
3. **A web app** that talks to the device through the browser's **Web Serial API**.

---

## 1. Verdict: feasible, low-to-moderate risk

| Question | Answer | Confidence |
|---|---|---|
| Can the STM32F103VCT6 do USB serial? | Yes. It has a full-speed USB 2.0 device peripheral (the "FSDEV"/USB-FS block). Mass storage is only what the stock SYS firmware implements; CDC-ACM is just different firmware on the same hardware. | Certain |
| Can our own code take over USB without replacing the bootloader or SYS? | Yes. An APP running in an APP slot gets the USB interrupts and normally hands them to SYS via `__USB_Istr`/`__CTR_HP`. If it doesn't hand them over, it can run its own USB stack. | High |
| Has anyone done this already? | **Yes.** gabonator's LA104 OS includes a working **WebUSB oscilloscope for the DS203** (`system/apps_featured/69_webusbosc`, MIT license). It uses libopencm3's USB stack with CDC + WebUSB descriptors, a text RPC protocol, and a JS front end. So this is proven, not speculative. | Certain |
| Is USB fast enough? | Yes. Full-speed bulk CDC gets about 0.6–1 MB/s on an F103. One full capture is 4096 samples × 4 bytes ≈ 16 KB (CH A, CH B and the digital channels), so 20–40+ frames/s is realistic. That's plenty for a scope UI. | High |
| Is there a risk of bricking? | Very low. The DFU bootloader (0x08000000–0x08003FFF) is never written. Holding **▶/||** at power-on always returns to DFU mode, where you can reflash stock firmware. | High |
| Do users need a host driver? | No. CDC-ACM is a standard USB class: Windows 10+ uses `usbser.sys`, Linux uses `cdc_acm`, and macOS has a built-in driver. "Writing the driver" means writing **device-side** USB firmware, not a PC driver. | Certain |

**Main limitation:** the Web Serial API only works in **Chromium-based browsers** (Chrome, Edge, Opera, Brave) on desktop. Firefox and Safari don't support it, and pages must be served over HTTPS or from `localhost`. *(Accepted by the owner.)*

### 1.1 Confirmed requirements (from the owner)
- **Chrome/Edge only** is fine.
- The **stock firmware can be replaced**; keeping it isn't required.
- **The USB disk doesn't need to be available** while the web UI is in use, so there's no composite CDC+MSC device.
- **Everything is controlled from the computer**: channel settings, V/div, offsets, timebase, trigger, run/stop, generator, and device settings. After the one-time flash, the user shouldn't need to touch the DSO. Its buttons and screen are not part of the normal workflow.
- **An escape route** back to a working stock scope and firmware update mode is wanted (see §3.7).

---

## 2. Hardware and firmware facts that matter

| Item | Value |
|---|---|
| MCU | STM32F103VCT6: Cortex-M3 at 72 MHz, 256 KB flash, 48 KB SRAM, USB FS device |
| ADC | AD9288-40, dual 8-bit. 36 MS/s per channel, or 72 MS/s interleaved on one channel |
| FPGA | Lattice iCE65 (ICE65F_VQ100). It handles sample timing, triggering and the capture FIFO |
| Capture depth | 4K samples per channel (8K in single-channel interleaved mode) |
| FPGA ↔ MCU | Memory-mapped over the FSMC bus at `0x64000000` (16-bit FIFO port). The LCD is at `0x60000000`. Config and status registers are reached through SYS calls `__Set(reg, val)` / `__Get(reg)`, e.g. `FIFO_CLR`, `T_BASE_PSC/ARR`, `CH_A_RANGE`, `TRIGG_MODE`, `V_THRESHOLD`, `ADC_CTRL`, `FIFO_FULL/EMPTY/START` |
| Other I/O | Two digital inputs (C/D), a wave-generator output, 4 buttons + 2 rockers, 400×240 LCD, 2 MB (HW ≤2.72) or 8 MB (HW 2.81) SPI flash used as the USB disk |
| USB connector | Mini-USB, full speed (12 Mbit/s) |

**Flash layout (base 0x08000000).** Checked against the FPGA `.ADR` file (`0x0802C000`) and the community-edition APP hex:

| Range | Size | Contents |
|---|---|---|
| `0x00000–0x03FFF` | 16 KB | DFU bootloader. **Never touch** |
| `0x04000–0x0BFFF` | 32 KB | SYS ("BIOS"): LCD, FPGA, keys, SPI flash, USB MSC |
| `0x0C000–0x13FFF` | 32 KB | APP1 slot (boots by default) |
| `0x14000–0x1BFFF` | 32 KB | APP2 slot |
| `0x1C000–0x23FFF` | 32 KB | APP3 slot |
| `0x24000–0x2BFFF` | 32 KB | "APP4" slot. Nominal only; see the FPGA row |
| `0x2B800–0x2BFFF` | 2 KB | **Persistent store** (fw ≥ 0.4): calibration and other host data, one CRC-checked blob. No APP image may reach it (`tools/hexrange.py`) |
| `0x2C000–0x3D7FF` | ~70 KB | **FPGA bitstream** (FPGA 2.61 is 68,088 bytes, loaded at `0x0802C000`). **Never overwrite** |
| `0x3D800–0x3FFFF` | 10 KB | Logo |

Slots are just boot entry points. An APP can span several slots as long as it ends before the next APP it must coexist with, and **must never reach `0x0802C000`**, where the FPGA image starts.

**RAM:** SYS uses `0x20000000–0x20002FFF`, so an APP gets `0x20003000` onward (~36 KB).

**Hardware revisions:** HW 2.6/2.7/2.72 and HW 2.81 differ (SPI flash size, and on some units the FPGA image/SYS version). The DS213 is a different device and is **out of scope**.

### 2.1 Target unit: HW 2.6 · SYS 1.52 · gcc Community Edition APP v1.24
- **HW 2.6** is the original revision: 2 MB SPI flash, the non-"_P" FPGA/logo images. The **V2.6 schematic** is in `gabonator/DS203/Man/DS203V2 6_SCH (2).pdf`. Firmware development targets only this configuration at first.
- **SYS 1.52** is the latest SYS for HW 2.6 and the ABI every reference project targets. **No SYS upgrade is needed.**
- **FPGA:** not yet confirmed, but almost certainly **2.61**. The community edition APP is tested against FPGA 2.61, and Seeed pairs SYS ≥ 1.51 with FPGA 2.61. M0 confirms it from the boot screen. Only if it isn't 2.61, flash `DS203.FPGA.V2.61.ADR` then `.BIN` via DFU (both are in the [V2.72 zip](https://files.seeedstudio.com/products/109990015/DS203.V2.72.zip), which states they're valid for HW 2.6).
- **Current APP: DSO203 GCC Community Edition** ([pmos69/dso203_gcc](https://github.com/pmos69/dso203_gcc), the gcc build of the stock APP 2.51 + Marco Sinatti's fixes, "tested with HW 2.6 / FPGA 2.61"). This matters a lot:
  - It's **the best hardware reference** for our firmware: gcc-buildable C that drives exactly this hardware and FPGA through SYS 1.5x. Its `Process.c`, `Menu.c`, `Calibrat.c` and `Function.c` show every timebase/range/trigger/generator setting and the calibration method. It's the source for M2's `scope_hw` module and the coverage checklist.
  - It's about **45 KB** and installed at APP1, so it spans APP1+APP2 (`0x0800C000–0x08017488`). Its repo ships linker scripts for APP1–APP3, so **it can be rebuilt for APP3** (`0x0801C000`, ≤ 64 KB before the FPGA image) and kept as the **hardware fallback scope** (§3.7, route 3).
  - Its README notes that correct **generator frequencies** need Marco Sinatti's modified SYS ("SYS 1.50 1.6"). On stock SYS 1.52 we'll program the generator timer ourselves rather than rely on the SYS helper (see §5).
- Bootloader recovery (only if the DFU itself were ever damaged, which this plan never risks) needs an SWD programmer (ST-Link) and Seeed's `DFU_C310` image for HW 2.6.

---

## 3. Architecture decisions

### 3.1 Run as an APP on top of stock SYS (recommended) instead of a bare-metal rewrite
- Keeps the known-good SYS calls for the LCD, FPGA register access, buttons and FPGA bitstream loading. The stock FPGA image and its register interface stay as they are.
- **Slot plan for this unit:**

  | Slot | Address range | Contents | Boot with |
  |---|---|---|---|
  | APP1 (+APP2) | `0x0800C000–0x0801BFFF` (64 KB max) | **Our web-control firmware** | Normal power-on |
  | APP3 | `0x0801C000–0x0802BFFF` (64 KB max) | **Community Edition APP rebuilt with `app3.lds`**, as the standalone fallback scope | Hold button 3 at power-on |
  | (APP4) | `0x0802C000…` | FPGA bitstream, **not an app**. Don't boot it | — |

  - Our firmware goes in **APP1**, the slot SYS boots when no button is held, so the device powers on straight into web-control mode. Flash it by copying the `.hex` to the DFU drive.
  - It gets a **hard 64 KB limit** in the linker script (`LENGTH = 64K`), so the build fails instead of silently overwriting the APP3 fallback. Expected size is 20–40 KB (TinyUSB CDC + protocol + acquisition).
  - **Flash the APP3 fallback first**, before our first APP1 build. That way there's always a working scope one button-hold away.
  - Holding button 2 at boot jumps into the middle of our APP1 image, and button 4 into the FPGA data. Both will just hang or crash; power-cycle to recover. Document this. Nothing is damaged, because booting only reads flash.
- Our APP handles the USB LP/HP IRQs itself and never calls `__USB_Istr`, so SYS's mass-storage stack stays idle while our app runs.
- *Fallback:* if SYS gets in the way (for example, it re-initialises USB), the neilstockbridge gcc port of SYS 1.50 shows how to drive the hardware directly. That is more work but has no blocker.

### 3.2 USB stack: **TinyUSB** (recommended), with libopencm3 as the proven alternative
- TinyUSB supports the STM32F1 FSDEV peripheral and CDC, MSC, vendor/WebUSB and composite devices. It is actively maintained and MIT-licensed.
- gabonator's DS203 app shows libopencm3's USB core already works in this exact setup. It's a good reference and fallback if TinyUSB integration fights the SYS environment.

### 3.3 Host transport: **CDC-ACM + Web Serial** (recommended) instead of WebUSB
| | CDC-ACM + Web Serial | WebUSB (gabonator's approach) |
|---|---|---|
| Windows driver | None (usbser.sys binds automatically) | Needs a WinUSB install via Zadig; there are open issues with control transfers (LA104#51) |
| Linux | Works; user needs `dialout` group or a udev rule | Needs `rmmod cdc_acm` or udev tweaks |
| Non-browser tools (Python, sigrok-style CLI) | Yes, any serial library works | Needs libusb |
| Browser support | Chromium only | Chromium only |

It's worth adding a WebUSB BOS/landing-page descriptor later, because it gives a "plug in → browser pops up the app" notification. It's optional.

### 3.4 USB identity
- For development, use a pid.codes test ID (`0x1209:0x0001`). Before public release, request a dedicated PID from pid.codes (free for open-source hardware/firmware).
- Linux: ship a udev rule that sets `MODE="0666"` (or a group) and `ENV{ID_MM_DEVICE_IGNORE}="1"`. Without the second setting, ModemManager probes the port and corrupts the first seconds of traffic.

### 3.5 Wire protocol: binary, framed, versioned
Frames are **COBS-encoded** and `0x00`-delimited, so the host can resync after garbage or a reconnect:

```
[type:u8][seq:u8][len:u16 LE][payload...][crc16:u16 LE]
```

| Type | Direction | Purpose |
|---|---|---|
| `HELLO` / `INFO` | H→D / D→H | Protocol version, firmware version, HW/SYS version, capabilities, buffer depth |
| `SET_CHANNEL` | H→D | ch, enable, coupling (AC/DC), range index, offset/position |
| `SET_TIMEBASE` | H→D | Sample-rate index (maps to `T_BASE_PSC/ARR`) and interleave on/off |
| `SET_TRIGGER` | H→D | source, mode (edge ↑/↓, level, pulse width), level, pre-trigger position, auto/normal/single |
| `RUN` / `STOP` / `SINGLE` / `FORCE` | H→D | Acquisition control |
| `FRAME` | D→H | Header (frame #, timebase, per-channel range/offset, trigger index, flags) + raw samples |
| `ROLL_CHUNK` | D→H | Continuous samples at slow timebases (roll/stream mode) |
| `SET_GEN` | H→D | Wave output: shape, frequency, duty |
| `GET_CAL` / `SET_CAL` | both | Per-range gain/offset calibration table |
| `EVENT` | D→H | Button presses on the device, battery level, errors |
| `ACK` / `NAK` | D→H | Reply to every command (matched by `seq`) |

Additional host-only commands, because nothing is set on the device:

| Type | Direction | Purpose |
|---|---|---|
| `GET_STATE` | H→D | Returns the device's complete current config, so a reloaded or reconnected browser tab can resync without resetting anything |
| `SET_STATE` | H→D | Apply a full config snapshot atomically (used to load saved setups) |
| `SET_SYSTEM` | H→D | Backlight level (off saves battery), beeper volume/mute, LCD status screen on/off, standby |
| `SAVE_DEFAULTS` | H→D | Store the current config in flash as the power-on default (optional; otherwise the host pushes config on every connect) |
| `REBOOT` | H→D | Soft reset (`NVIC_SystemReset`). Also used by the "exit" escape (§3.7) |
| `PING` | H→D | Keepalive. The device detects a closed tab and stops streaming |

### 3.6a Headless, host-driven design
- **The host owns the state.** The web app keeps the authoritative settings (persisted in `localStorage` and exportable as JSON) and pushes them on connect. The device keeps the live config in RAM and reports it back with `GET_STATE`, so the two can always be reconciled.
- **No on-device UI.** The LCD only shows a passive status screen (USB connected/disconnected, running/stopped, sample rate, battery), and the host can turn it and the backlight off. Buttons do nothing except the escape combo in §3.7. Button presses are still reported as `EVENT`s in case they're wanted as remote triggers later.
- **Every hardware setting the Community Edition APP exposes must be reachable from the protocol:** per-channel enable/range/coupling/position, the digital channels, time/div and interleave, all trigger modes/sources/levels/positions, generator shape/freq/duty, calibration, backlight and beep. M2 checks this item by item against the Community Edition's menus so nothing is missing.
- **It works unplugged from the user's hands.** Auto-start on power-on (APP1) plus USB reconnect handling means the flow is: power on → plug in → open the web page → connect.

### 3.6 Web app
- TypeScript + Vite, no framework, or a light one such as Preact/Svelte. It's a static site, deployable to GitHub Pages (HTTPS is required for Web Serial).
- **Canvas 2D** first; move to **WebGL** only if persistence/intensity-graded display needs it.
- Layers: `transport/` (Web Serial + COBS + CRC), `protocol/` (typed encode/decode), `model/` (scope state), `ui/` (waveform view, controls, measurements), `dsp/` (FFT, measurements), run in a Web Worker if needed.
- A mock transport replays recorded frames, so UI work doesn't need the hardware.

### 3.7 Escape routes (from gentlest to guaranteed)
| # | Route | How | Gets you to | Depends on |
|---|---|---|---|---|
| 1 | **"Exit" from the web UI** | `REBOOT` command with a flag. The APP writes a magic word into a no-init RAM location, then resets. On the next boot it sees the flag, clears it, and **jumps to the APP3 fallback** (the Community Edition scope; its own USB disk mode works as normal). | Standalone Community Edition scope + USB disk | Our firmware running |
| 2 | **On-device key combo** | Holding a specific button combo (e.g. ■ + ▶/|| for 2 s) at any time while our app runs does route 1 locally. It needs no computer. | Same as 1 | Our firmware running |
| 3 | **SYS boot-slot selection** | Hold **button 3** while powering on. SYS boots APP3 instead of APP1, **skipping our firmware entirely**. Verified in M0/M1 on this unit. | Community Edition scope in APP3 | SYS only |
| 4 | **DFU mode** (guaranteed) | Hold ▶/|| (button 1) while powering on. The factory bootloader shows up as a USB drive; copy any `.hex` (stock APP, SYS, or ours). The bootloader is in flash we never write, so this always works. | Reflash anything, e.g. the Community Edition `APP_G251.hex` in APP1 | Nothing (factory ROM area) |
| 5 | **Crash safety net** | The independent watchdog (IWDG) is enabled in our APP. If it resets 3 times in a row (counter kept in backup registers), the next boot takes route 1 automatically instead of starting USB. This stops a buggy build from boot-looping. | Same as 1 | Hardware watchdog + backup domain |

**Status (M1, owner decision):** routes **3 (hold ○ at power-on)** and **4 (DFU)** are the official escapes. Both are independent of our firmware, and route 3 is verified on the unit. Routes 1, 2 and 5 are implemented as conveniences but aren't being formally tested (`exit` was seen to reply and drop USB). A system reset clears the IWDG (RM0008: everything except the backup domain and the reset flags is reset), so handing over to APP3 after `exit` doesn't carry the watchdog along.

**Firmware updates without DFU (fw ≥ 0.6, 2026-09-24):** the running firmware stages a new image in the free flash above itself, checks its CRC-32 and vector table, then a RAM-resident routine copies it over APP1 and resets (docs/protocol.md, "Firmware update"). The web page's **Firmware…** dialog installs the build published with the page (`make -C firmware/app release` → `web/firmware/`) or a local `.hex`; the CLI has `dsoq flash`. Verified on the unit: a 21.7 KB install takes ~2 s and it comes back on the new build; an oversized image, a corrupted chunk (CRC mismatch at commit) and an overwrite with different data are all refused with the old firmware left running. DFU remains the recovery route (and is needed for an image over ~42 KB, the free staging space).

---

## 4. Plan (milestones)

### M0: Recon and toolchain (½–1 day)
- [x] HW **2.6**, SYS **1.52**, APP **gcc Community Edition v1.24** (see §2.1). No SYS upgrade needed.
- [x] Boot screen only shows "hardware ver v2.6.0" (no FPGA version); the FPGA is known-good because the Community Edition runs. DFU disk label: `DFU V3_10_C` (DFU 3.10).
- [x] Before anything is overwritten, **export the current calibration and settings** from the USB disk. Copy every file off the disk. The Community Edition keeps its saved settings and calibration there, and the numbers are useful as a starting point for our own calibration table.
- [x] Install `arm-none-eabi-gcc` (14.2) and port the Community Edition's `makefile.bat` to a Linux Makefile (or use the gabonator Win32 script under WSL).
- [x] **Rebuild the Community Edition with `App/lds/app3.lds`**, flash it via DFU, and check that **holding button 3 at power-on** boots it and it works (1 kHz cal square wave). This proves the toolchain → DFU → run loop *and* installs the permanent fallback scope (escape route 3) before any of our code runs.
- [ ] Optional baseline: keep the published `APP_G251.hex` ([pmos69.net](http://pmos69.net/dso203/APP_G251.hex)) and the Community Edition source tree as the restore image for escape route 4.
- [x] Set up a repo: `firmware/`, `web/`, `tools/` (Python host tools), `docs/`.

> **M0 notes:** backup + decoded calibration in `backup/` (channel A uncalibrated; B offsets only). Fallback builds with `make -C firmware/fallback` (fixes for modern binutils: Thumb labels in `cortexm3_macro.s`, `-fno-common`). Flash with `tools/dfu-flash.sh`. The VM needs the DSO re-attached after every re-enumeration unless it is passed through by host port.

### M1: "Hello USB serial" APP (2–4 days) ← **the key feasibility gate**
- [ ] Minimal APP1 skeleton: linker script at `0x0800C000`, RAM from `0x20003000`, vector table and `SCB->VTOR`, SYS call stubs (`BIOS.S` jump table, taken from QuadPawn/gabonator), and an LCD "hello".
- [ ] Take over the USB IRQs, bring up TinyUSB CDC-ACM, and do a USB soft-disconnect/reconnect so the host re-enumerates. Echo bytes back.
- [ ] Test on Linux (`picocom`), Windows (built-in driver) and macOS. Measure bulk throughput with a Python script. Target ≥ 500 KB/s.
- [ ] Escape routes 1, 2 and 5 (§3.7): no-init RAM flag + reset, on-device key combo, IWDG with a boot-failure counter. Build these **before** any feature work so every later build is safe to flash. On exit, stop USB and restore the SYS IRQ path, so SYS's USB disk mode works again.
- [ ] Check that escape route 1 lands in the APP3 fallback, and that route 3 (button 3) still works with our APP1 installed.
- **Exit criterion:** a stable `/dev/ttyACM0` with measured throughput, and escape routes 3/4 verified.
- **Result (v0.1.1):** ✅ enumerates as `1209:0001` → `/dev/serial/by-id/usb-DSO_Quad_community_DSO_Quad_Web_Control_8871B997-if00`. Device→host **689 KB/s**, host→device 368 KB/s, pattern intact, no stray IRQs. Open nit: `__Chk_HDW/__Chk_DFU` don't return string pointers on SYS 1.52 (versions show `n/a`). If TinyUSB causes trouble here, switch to libopencm3 (proven on this device).

### M2: Acquisition core + protocol (4–7 days)
- [ ] Wrap SYS FPGA access (`__Set/__Get/__Read_FIFO`) in a small `scope_hw` module: ranges, coupling, offsets, timebase table, trigger config, FIFO reset/arm/poll/read. **Primary reference: the Community Edition source** (`Process.c`, `Menu.c`, `Function.c`, `Calibrat.c`), which is proven on this exact HW/SYS/FPGA. Secondary references: QuadPawn `amx_wavein.c` and LA104 `bios/ds203/adc.cpp`.
- [ ] Read the FIFO with DMA from `0x64000000` (as QuadPawn does), so USB transmission overlaps the next acquisition.
- [ ] Implement the framed protocol (COBS + CRC16), the command handlers (including `GET_STATE`/`SET_STATE`/`SET_SYSTEM`/`PING`) and the FRAME streamer with backpressure (never block the acquisition loop on USB).
- [ ] **Coverage checklist:** go through every menu and button function of the Community Edition (its README lists them all) and confirm each hardware setting has a protocol command. Nothing should require touching the device. Scope features it does in software (meters, FFT, spectrogram) move to the web app.
- [ ] **Python reference client** (`tools/dsoq.py`): connect, configure, grab frames, plot with matplotlib, and save CSV. It serves as the protocol spec in code and as the hardware test harness.
- **Exit criterion:** the Python client shows a correct probe-compensation square wave (1 kHz cal output) on CH A/B with the right V/div and time/div.

- **Result (v0.2.0, 2026-09-23):** ✅ exit criterion met. `python3 tools/dsoq capture --gen 1000 --rate 100000 --range-a 4 --offset-a 104 --level 145 --mode normal` shows a clean 1.000 kHz square wave from Wave Out on CH A (period exactly 100 samples at 100 kS/s, rising edge exactly at sample 150, so the FPGA pre-trigger is 150). 100 kHz at 10 MS/s also works. SYS tables read from the device: 8 ranges (50 mV–10 V/div), 27 timebases (1 s–0.1 µs/div, ~30 samples/div; the fastest need 72 MS/s interleave). The SYS trigger table (`T_attr`) is a legacy leftover. The FPGA takes `(source << 3) | kind`, as the Community Edition does.
- **Throughput:** 15.6 → **21.8 frames/s** (4096 samples × 3 channels, 0 bad frames) after the table-driven CRC and overlapping capture with sending. Host decoding costs 5 ms/frame. Meets the M3 target of ≥ 20 fps.
- **DFU flashing, findings (2026-09-23):** a plain FAT copy (`mcopy`, the default in `tools/dfu-flash.sh`) programs correctly, as proven twice by the running firmware (the frame rate went from 15.6 to 21.8 fps after flashing the perf build), **but the DFU names the file `.ERR` anyway**. The one real failure (SYS version screen + tone) came from gabonator's raw `dfuload`, which writes a synthetic directory entry; that method is now opt-in only (`DFU_METHOD=dfuload`). DFU 3.10 shows nothing on the LCD. The type-05 (start address) record was suspected, but the 0.3.0 flash still reported `.ERR` with it stripped, so that's ruled out (the strip stays; it's harmless). The cause is still unknown, and the build ID check is the verification that counts. Every build now carries an ID (`python3 tools/dsoq info`, also on the LCD), so a flash can always be verified after boot.

### M3: Web app MVP (4–6 days)
- [x] Connect/disconnect through Web Serial with auto-reconnect via `navigator.serial.getPorts()` and the `connect` event.
- [x] Waveform canvas with graticule; CH A/B plus digital C/D traces; min/max decimation; hover readout.
- [x] Controls: run/stop/single/auto/normal, V/div and coupling per channel, position/offset, time/div, trigger source/type/level/position/pulse width (draggable markers), generator.
- [x] Settings persisted in the browser and pushed on connect; export/import as JSON. `GET_STATE` is polled once a second (battery, uptime, self-heal if the device stopped).
- [x] Device panel: battery (STATE extended to 46 bytes in fw 0.3.0), backlight/LCD off, firmware/serial. *(No exit button in the web UI, per the owner. Escapes are ○ at power-on and DFU. Beeper: the firmware never beeps, so there's no control.)*
- [x] Simulator (`?sim`) and recorded-frame playback (`?play=…`, recorded with `dsoq record`).
- [x] Basic measurements (Vpp, Vavg, Vrms, max, min, frequency) so the MVP is usable before M4.
- [x] Verified with the real device in Chrome on Linux (2026-09-23, fw 0.3.0, 21.2 fps; square wave on A from the generator). Owner: "very intuitive, no notes".
- [ ] Windows check (CDC binds to usbser.sys; nothing Linux-specific in the page).
- **Exit criterion:** the MVP works in Chrome on Linux and Windows, with frame rate ≥ 20 fps at 4K depth.

**Design notes (M3):**
- Time/div → sample rate = min(36 MS/s, 200 samples/div), so a screen uses 2000 of the 4096 samples and the rest is room to move the trigger point. Slow timebases wait for the whole 4096-sample capture (e.g. 2 s at 100 ms/div); roll mode is M4.
- Frames captured at an old channel offset are shifted to the current position on screen, so dragging a channel zero feels immediate, even while stopped.
- The first 1–4 samples of every frame are stale FIFO contents (found in the recordings: they added a fake edge and a 1.4% frequency error). Hosts skip samples 0–3.

### M4: Scope features (1–2 weeks, incremental)
- [x] **Calibration (2026-09-23):** host-side model per channel and range: 0 V reads `a + b × offset_register` (zero error + offset-DAC scale, fitted from 3 offsets with the inputs shorted to ground: the owner found that calibrating with open inputs left a shorted input reading 20 mV, and the wave-out's low level about 30 mV) and one division is `25 × gain` codes (gain from a known DC voltage; the wave out held high at 100% duty works, measured with a multimeter). The results are stored **on the DSO** in the flash store page (owner's request), so they follow the device. The web page applies them to channel offsets, trigger level, trace scale and measurements. Tested end to end against the simulator, which has deliberate front-end errors. Measured before calibrating: 0 V read +11 codes (A) and +14 (B) off nominal at offset 104, i.e. the ~0.4–0.6 div error seen since M2.
- [x] **Wave generator (fw 0.5.0, verified on hardware 2026-09-24):** square (TIM4 via SYS) plus analog shapes from the DAC. The page computes the table (≤ 512 points, ≤ 2 MS/s, length chosen for the most exact frequency) and uploads it with `SET_WAVE`; the firmware drives TIM7/DMA2 ch4/DAC ch1 directly, because stock SYS can't set TIM7's prescaler. PB6 (square output) shares the wave-out node and must float in analog mode or it clamps the DAC to ~0.25 V swing; found with PEEK/POKE. Output 0.03–2.73 V. A 1 kHz sine measured 999 Hz, 0.969 Vrms, THD ≈ 1.7% (3rd harmonic −37 dBV).
- [x] **FFT view:** Hann/Blackman-Harris/flat-top/rectangular windows, dBV or linear, span, power averaging, peak marker and readout; uses the calibration.
- [x] **Roll mode (fw 0.5.0, verified on hardware 2026-09-24):** `SET_ACQ` mode 4 streams `ROLL` chunks (~20/s) from a continuous unconditional capture, re-armed every 4096 samples. A ramp test showed each restart replaying exactly 146 samples (the pretrigger); the firmware now drops the 150 pretrigger samples of every capture, making the stream continuous (verified: no jumps over 14k samples). Tops out ≈ 75 kS/s. Auto mode rolls at ≥ 100 ms/div; "Roll" can also be chosen explicitly.
- [x] PEEK/POKE debug messages, for hardware experiments without reflashing.
- [x] **Firmware update over USB (fw 0.6.0, verified on hardware 2026-09-24):** web **Firmware…** dialog and `dsoq flash`; no DFU swapping (§3.7).
- [x] Status screen: no grey text (hard to read on the DSO's LCD, owner's note); cyan/white/yellow only.
- [x] Calibration redone by the owner with shorted inputs (2026-09-24): shorted A reads −8 mV mean, B +1.3 mV (was ~20 mV off).
- [x] Measurements (2026-09-24, `web/js/measure.js`, unit-tested): Vpp, Vavg, Vrms, AC rms, max, min, top, base, amplitude, frequency, period, duty, ±width, rise/fall 10–90 % (flagged "<" at the time resolution); mean/rms over whole cycles. Selectable in a Measure panel. Cursors: time (Δt, 1/Δt) and voltage (on A, B or math), draggable.
- [x] XY mode, persistence (short/long/infinite), math (A+B, A−B, B−A, A×B) with its own scale and marker.
- [x] Export PNG (screen + scales + measurements) and CSV (volts, time from the trigger); settings JSON export/import (M3); shareable link (settings in the URL fragment).
- [x] **72 MS/s interleave (fw 0.7.0, verified on hardware 2026-09-24):** automatic when B, math and XY are off and the timebase wants more than 36 MS/s. Needs `ADC_MODE` 1 **and** FPGA control register 4 = 3 (with `ADC_MODE` alone ADC B sampled on A's edges: it repeated A one word late). B range index 8 routes channel A to ADC B. Each word holds two samples, **B first**; the page balances the ADCs' zero error by the difference of the means. A 2 MHz square's edge at 72 MS/s: 108, 109, 113, 128, 144, 155 (monotonic, no zigzag).
- [ ] Optional: store power-on defaults on the device (`SAVE_DEFAULTS`).

### M5: Polish and release (3–5 days)
- [ ] Optional WebUSB landing-page descriptor ("open app" popup).
- [ ] Optional: software entry into DFU, giving a "Firmware update" button in the web UI (see §3.7).
- *(Dropped: composite CDC + MSC. The USB disk isn't needed while connected.)*
- [ ] Dedicated pid.codes PID, udev rule, install docs, GitHub Pages deploy, and a release `.hex` for each HW revision if needed.

**Rough total:** 4–6 weeks part-time to a solid v1. M1 either confirms the approach within the first week or triggers the libopencm3 or bare-metal fallback.

---

## 5. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| SYS keeps using the USB peripheral/PMA or re-enables its ISR while our APP runs | Enumeration glitches | Own the IRQ vectors in our vector table and fully reset the USB peripheral (`RCC_APB1RSTR.USBRST`) before init. gabonator's app proves takeover works. |
| FPGA register semantics are partly undocumented (Chinese comments, version-dependent) | Wrong trigger/timebase behavior | Copy behavior from the Community Edition source (same HW/SYS/FPGA), then Wildcat/QuadPawn/gabonator implementations; build a register-poke debug command early. |
| HW 2.81 / different SYS/FPGA versions behave differently | Firmware works on some units only | Report versions in `INFO`, keep per-version tables, and test on the user's unit first. |
| Front-end calibration (per-range gain/offset) | Inaccurate volts | Calibration wizard in M4; start from the Community Edition calibration saved on the USB disk (exported in M0) and reuse its calibration method from `Calibrat.c`. |
| Web Serial works in Chromium only | Firefox/Safari users excluded | Document it. The Python client and any serial tool still work. |
| ModemManager or `brltty` grabbing `/dev/ttyACM*` on Linux | Garbled startup | udev rule with `ID_MM_DEVICE_IGNORE`; the protocol resyncs via COBS. |
| RAM (~36 KB for the APP) | Buffering limits | One 16 KB frame buffer plus small USB FIFOs fits. Stream directly from DMA buffers and avoid double copies. |
| Our APP1 image grows into the APP3 fallback, or anything reaches the FPGA image at `0x0802C000` | Fallback scope gone / FPGA won't load | 64 KB `LENGTH` in the linker script so the build fails; a CI size check. If the FPGA image is ever clobbered, reflash FPGA 2.61 via DFU |
| Generator frequencies on stock SYS 1.52 are wrong (per the Community Edition README) | Wrong generator output | Program the generator timer/DAC directly in our APP instead of through the SYS helper; check with the scope itself |
| Throughput lower than expected | Lower fps | Frames are small (16 KB); decimation/peak-detect on the device for large time/div. |

---

## 6. Reference material

- Seeed wiki: https://wiki.seeedstudio.com/DSO_Quad/ (firmware downloads, flash map, building firmware, calibration)
- **pmos69/dso203_gcc**: DSO203 GCC Community Edition APP, the one currently installed. **Primary hardware reference**, with per-slot linker scripts (`App/lds/app1-3.lds`). https://github.com/pmos69/dso203_gcc · forum thread: https://forum.seeedstudio.com/t/dso203-gcc-app-community-edition-2-51-smtech1-8-fixes/2012
- **gabonator/LA104**: WebUSB DS203 oscilloscope (MIT): `system/apps_featured/69_webusbosc/` (firmware `source/v3`, web `web/v3`), DS203 BIOS glue in `system/os_host/source/bios/ds203/`, CDC/WebUSB examples in `system/apps_usb/`. https://github.com/gabonator/LA104
- **gabonator/DS203**: alternative firmware; `Man/` contains the **DS203 V2.6 schematic PDF**; serial-output notes. https://github.com/gabonator/DS203
- **PetteriAimonen/QuadPawn** (BSD for its own files): APP linker scripts (`Runtime/linker_scripts/app1.lds`), SYS call table `Runtime/DS203/BIOS.S`, FPGA DMA/FIFO code `amx_wavein.c`, `amx_fpga.c`. https://github.com/PetteriAimonen/QuadPawn
- **neilstockbridge/dsoquad-BIOS**: gcc port of SYS 1.50 (includes the original USB MSC stack; FPGA at `0x64000000`, LCD at `0x60000000`). Useful for the bare-metal fallback. https://github.com/neilstockbridge/dsoquad-BIOS
- jpa's DSO Quad firmware collection: https://jpa.kapsi.fi/dsoquad/
- Wildcat firmware (good trigger/timebase reference): https://github.com/MotoMaxis/DS203-DSOQuad
- TinyUSB: https://github.com/hathach/tinyusb · Web Serial API: https://developer.mozilla.org/docs/Web/API/Web_Serial_API · pid.codes: https://pid.codes

## 7. Open questions for the owner
1. FPGA version from the boot screen (expected 2.61). Checked in M0; doesn't block anything.

Resolved: the unit is **HW 2.6 / SYS 1.52 / gcc Community Edition APP v1.24**, so no SYS upgrade is needed. The Community Edition moves to APP3 as the fallback. (The GitHub repo is at v1.29, newer than the installed v1.24; either is fine as the fallback.) Chrome/Edge only is fine; replacing the stock firmware is fine; the USB disk isn't needed while connected; all control comes from the computer; escape routes are wanted (§3.7).
