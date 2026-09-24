// Acquisition hardware (FPGA + ADC front end, through SYS) and the capture state machine.
#pragma once
#include <stdint.h>

#define SCOPE_DEPTH      4096
#define SCOPE_PRETRIGGER 150   // samples the FPGA keeps before the trigger point

enum { ACQ_STOP = 0, ACQ_NORMAL = 1, ACQ_AUTO = 2, ACQ_SINGLE = 3, ACQ_ROLL = 4 };

#define FRAME_TRIGGERED 0x01
#define FRAME_AUTO      0x02
#define FRAME_LAST      0x04
#define FRAME_ROLL      0x08  // roll-mode chunk (sent as MSG_ROLL); frame_no = index of its first sample
#define FRAME_GAP       0x10  // roll: samples were lost before this chunk

#define ROLL_CHUNK_MAX  256   // samples per roll chunk

struct scope_channel { uint8_t range, coupling, offset; };

struct scope_state {
  uint8_t acq_mode;
  struct scope_channel ch[2];
  uint32_t rate_req, rate_actual;
  uint16_t psc, arr;
  uint8_t trig_source, trig_kind, trig_level;
  uint16_t trig_width;
  uint16_t auto_ms;
  uint8_t gen_mode;
  uint32_t gen_freq;
  uint8_t gen_duty;
  uint8_t backlight, beep;
  uint32_t frames;
};

struct scope_frame {
  uint32_t frame_no;
  uint8_t flags;
  uint32_t rate_actual;
  struct scope_channel ch[2];
  uint8_t trig_source, trig_kind, trig_level;
  uint16_t count;
  uint8_t samples[SCOPE_DEPTH * 3];  // A, B, CD per sample
};

extern struct scope_state scope;

void scope_init(void);
int scope_running(void);
uint8_t scope_range_count(void);

// Setters return 0 on success, -1 for an out-of-range value. They re-arm a running capture.
int scope_set_channel(uint8_t ch, uint8_t range, uint8_t coupling, uint8_t offset);
int scope_set_rate(uint32_t hz);
int scope_set_trigger(uint8_t source, uint8_t kind, uint8_t level, uint16_t width);
int scope_set_acq(uint8_t mode, uint16_t auto_ms);
void scope_set_system(uint8_t backlight, uint8_t beep);

// Advance the capture state machine; returns a finished frame (valid until
// scope_frame_done()) or NULL. Never blocks for long.
const struct scope_frame *scope_poll(uint32_t now_ms);
void scope_frame_done(void);
