# DSO Quad control protocol (v1)

Transport: USB CDC-ACM (`1209:0001`). Baud rate and line settings are ignored.

## Framing

Each message is `COBS(type, seq, body..., crc_lo, crc_hi)` followed by a `0x00` delimiter.

- `type`: message type (table below). Host→device < `0x80`, device→host ≥ `0x80`.
- `seq`: chosen by the host per request; replies echo it. Unsolicited device messages
  (`FRAME`, `LOG`) carry their own counter.
- `crc`: CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`, no reflection, no xor-out) over
  `type, seq, body`, little-endian.
- All integers are little-endian. Structures are packed (no padding).
- Host messages are at most 1100 bytes before encoding (only `STORE_WRITE` comes close).

A receiver that sees a bad CRC or length drops the message. The device replies to it with
`ACK` status `BAD_FRAME` (seq 0) if it could decode anything at all.

## Units

The firmware deals only in raw hardware values; calibration and physical units live on the host.

- **ADC codes**: 8-bit samples per analog channel. SYS convention: code 54 is "screen bottom"
  and 25 codes are one vertical division (8 divisions visible). `offset` registers use the
  same scale (the channel's 0 V sits at code `offset`, before calibration).
- **Ranges**: index into the SYS vertical table (`TABLE` id 1). `SCALE` / `STR` give V/div.
- **Sample rate**: `72 MHz / ((psc + 1) * (arr + 1))`. The host asks for a rate in Hz and
  the device reports what it actually set.
- **Trigger position**: the FPGA keeps `pretrigger` samples (≈150) before the trigger point.

## Host → device

| Type | Name | Body | Reply |
|---|---|---|---|
| `0x01` | HELLO | – | `INFO` |
| `0x02` | PING | any bytes | `PONG` (same bytes) |
| `0x03` | GET_STATE | – | `STATE` |
| `0x10` | SET_CHANNEL | `ch u8` (0 A, 1 B), `range u8`, `coupling u8` (0 DC, 1 AC), `offset u8` | `ACK` |
| `0x11` | SET_TIMEBASE | `rate_hz u32` | `ACK` (read `STATE` for the actual rate) |
| `0x12` | SET_TRIGGER | `source u8` (0 A, 1 B, 2 C, 3 D), `kind u8` (0–7, see below), `level u8` (ADC code), `width u16` (pulse-width threshold, samples) | `ACK` |
| `0x13` | SET_ACQ | `mode u8` (0 stop, 1 normal, 2 auto, 3 single), `auto_ms u16` | `ACK` |
| `0x14` | SET_GEN | `mode u8` (0 off, 1 square, 2 analog), `freq_hz u32`, `duty u8` (% for square) | `ACK` |
| `0x16` | SET_WAVE | 2–512 × `u16` DAC codes (0–4095) | `ACK` |
| `0x15` | SET_SYSTEM | `backlight u8` (0–100), `beep u8` (0–100); 255 = unchanged | `ACK` |
| `0x20` | GET_TABLES | – | 4 × `TABLE`, then `ACK` |
| `0x21` | STORE_READ | – | `STORE_DATA` |
| `0x22` | STORE_WRITE | data, 0–1024 bytes (0 erases) | `ACK` (`FLASH_ERROR` if programming or verification failed) |
| `0x30` | REG_SET | `object u8`, `value u32` (`__Set`) | `ACK` |
| `0x31` | REG_GET | `kind u8` (`__Get`) | `REG_VALUE` |
| `0x32` | PARAM_SET | `addr u8`, `value u8` (`__Set_Param`, FPGA trigger block) | `ACK` |
| `0x33` | PEEK | `addr u32` (word aligned), `words u8` (1–64). Debug | `MEM_DATA` |
| `0x34` | POKE | `addr u32` (word aligned), `value u32`. Debug: writes anywhere | `ACK` |
| `0x3F` | REBOOT | `target u8` (0 this firmware, 1 APP3 fallback) | `ACK`, then USB drops |

Trigger kinds (FPGA): 0 falling edge, 1 rising edge, 2 low level, 3 high level,
4 low pulse < width, 5 low pulse > width, 6 high pulse < width, 7 high pulse > width.

Acquisition modes: **normal** sends a frame each time the trigger fires. **auto** does the same,
but if nothing triggers within `auto_ms` it captures untriggered (flag `AUTO`). **single**
sends one triggered frame, then switches to stop.

## Device → host

| Type | Name | Body |
|---|---|---|
| `0x81` | INFO | `proto u16` (=1), `serial u32`, `fw` (NUL-terminated string) |
| `0x82` | PONG | echo of the PING body |
| `0x83` | STATE | see below |
| `0x84` | FRAME | see below |
| `0x85` | TABLE | `id u8`, `elem_size u8`, `count u8`, `count × elem_size` raw bytes |
| `0x86` | STORE_DATA | `len u16` (0 = nothing stored), `len` bytes |
| `0x8E` | LOG | text (not NUL-terminated) |
| `0xA0` | ACK | `status u8` (0 OK, 1 BAD_LENGTH, 2 BAD_VALUE, 3 UNKNOWN_TYPE, 4 BAD_FRAME, 5 BUSY, 6 FLASH_ERROR) |
| `0xB1` | REG_VALUE | `kind u8`, `value u32` |
| `0xB3` | MEM_DATA | `addr u32`, `words × u32` |

### STATE (52 bytes)

| Offset | Field |
|---|---|
| 0 | `acq_mode u8`, `running u8` |
| 2 | ch A `range u8`, `coupling u8`, `offset u8`; ch B same (6 bytes) |
| 8 | `rate_req u32`, `rate_actual u32`, `psc u16`, `arr u16` |
| 20 | trigger `source u8`, `kind u8`, `level u8`, `width u16` |
| 25 | `auto_ms u16` |
| 27 | gen `mode u8`, `freq_hz u32`, `duty u8` |
| 33 | `backlight u8`, `beep u8` |
| 35 | `frames u32` (frames sent since boot) |
| 39 | `battery_mv u16`, `charging u8` (SYS `CHARGE`, 1 = charging), `uptime_s u32` |
| 46 | generator `psc u16`, `arr u16` (timer dividers in use), `wave_len u16` (DAC table entries) |

The generator's actual frequency is `72 MHz / ((psc + 1)(arr + 1))` for the square wave and
that divided by `wave_len` in analog mode.

Receivers must accept a longer `STATE` and ignore the extra bytes, so fields can be appended
without a protocol version bump. (Firmware before 0.3.0 sent only the first 39 bytes.)

### FRAME

| Offset | Field |
|---|---|
| 0 | `frame_no u32` |
| 4 | `flags u8`: bit0 triggered, bit1 auto (untriggered), bit2 last frame of a single |
| 5 | `rate_actual u32` |
| 9 | ch A `range, coupling, offset`, ch B same (6 bytes) |
| 15 | trigger `source, kind, level` (3 bytes) |
| 18 | `pretrigger u16` |
| 20 | `count u16` |
| 22 | `count × 3` bytes: per sample `A u8`, `B u8`, `CD u8` (bit0 = C, bit1 = D) |

Samples are raw codes, with the FPGA 2.61 channel-B bit-swap already corrected.
The first 1–4 samples of a frame are stale (left in the FPGA FIFO from before the capture);
hosts should ignore samples 0–3.

### TABLE ids (raw SYS structures, little-endian)

| id | SYS table | elem_size | Layout |
|---|---|---|---|
| 0 | `G_attr` (global) | 28 | `LCD_X, LCD_Y, Yp_Max, Xp_Max, Tg_Num, Yv_Max, Xt_Max, Co_Max u16`, `Ya_Num, Yd_Num, INSERT u8`, pad, `KpA1, KpA2, KpB1, KpB2 u16` |
| 1 | `Y_attr[Yp_Max+1]` (ranges) | 20 | `STR char[8]`, `KA1 s16`, `KA2 u16`, `KB1 s16`, `KB2 u16`, `SCALE u32` |
| 2 | `X_attr[Xp_Max+6]` (timebases) | 20 | `STR char[8]`, `PSC s16`, `ARR u16`, `CCR u16`, `KP u16`, `SCALE u32` |
| 3 | `T_attr[Tg_Num+1]` (triggers) | 10 | `STR char[8]`, `CHx u8`, `CMD u8` |

## Persistent store (firmware ≥ 0.4.0)

One opaque blob of up to 1024 bytes in the internal flash page at `0x0802B800` (the last page
before the FPGA image; no APP image may reach it). The firmware keeps it with a magic word and
a CRC and returns it unchanged; a write erases the page (~20–40 ms, the device stalls) and
verifies. The host owns the format:

- A sequence of records `tag u8`, `len u16`, `len` bytes. Unknown tags must be kept when
  rewriting, so different hosts/versions can share the store.
- Tag `1`: vertical calibration v1. `created u32` (Unix seconds), then for channel A ranges 0–7
  and channel B ranges 0–7: `a f32`, `b f32`, `gain f32`, `flags u8` (bit 0 zero calibrated,
  bit 1 gain calibrated). 0 V reads as code `a + b × offset_register`; a division is
  `25 × gain` codes.

## Wave generator (firmware ≥ 0.5.0)

- **Square** (`mode 1`): TIM4 through SYS, 1 Hz – 8 MHz, `duty` in %. Full logic swing.
- **Analog** (`mode 2`): the DAC (12-bit) plays the table from `SET_WAVE` in a loop,
  `freq_hz` times per second, via DMA2 channel 4 paced by TIM7. `freq_hz × wave_len` must be
  ≤ 2 MS/s, so hosts shorten the table for high frequencies. Upload the table first;
  `SET_WAVE` while running switches tables at once. The host computes every waveform.
