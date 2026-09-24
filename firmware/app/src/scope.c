#include <stddef.h>
#include "scope.h"
#include "stm32f1xx.h"
#include "sys.h"

_Static_assert(sizeof(G_attr) == 28, "G_attr layout");
_Static_assert(sizeof(Y_attr) == 20, "Y_attr layout");
_Static_assert(sizeof(X_attr) == 20, "X_attr layout");
_Static_assert(sizeof(T_attr) == 10, "T_attr layout");

#define TIMER_HZ 72000000u
#define ADC_ZERO 54u        // SYS convention: code 54 = screen bottom, 25 codes/div
#define READ_BURST 512      // max samples read per poll at slow rates

struct scope_state scope;
static struct scope_frame frame;

enum { S_IDLE, S_ARM, S_WAIT_TRIG, S_READ, S_DONE };
static uint8_t st = S_IDLE;
static uint8_t forced;        // auto mode gave up waiting and captured untriggered
static uint32_t armed_at;
static uint16_t read_idx;

static void rearm(void)
{
  if (st != S_IDLE && st != S_DONE) st = S_ARM;
}

uint8_t scope_range_count(void)
{
  const G_attr *g = (const G_attr *)__Get(SYS_GLOBAL);
  return (uint8_t)(g->Yp_Max + 1);
}

int scope_running(void) { return st != S_IDLE; }

int scope_set_channel(uint8_t ch, uint8_t range, uint8_t coupling, uint8_t offset)
{
  if (ch > 1 || range >= scope_range_count() || coupling > 1) return -1;
  scope.ch[ch] = (struct scope_channel){ range, coupling, offset };
  __Set(ch ? SYS_CH_B_COUPLE : SYS_CH_A_COUPLE, coupling);
  __Set(ch ? SYS_CH_B_RANGE : SYS_CH_A_RANGE, range);
  __Set(ch ? SYS_CH_B_OFFSET : SYS_CH_A_OFFSET, offset);
  rearm();
  return 0;
}

int scope_set_rate(uint32_t hz)
{
  if (hz < 1 || hz > TIMER_HZ / 2) return -1;
  // Prescaler only when ARR alone can't reach the rate (same approach as QuadPawn).
  uint32_t psc = (TIMER_HZ / 65536) / hz;
  uint32_t arr = (TIMER_HZ / (psc + 1) + hz - 1) / hz - 1;
  if (arr < 1) arr = 1;  // 36 MS/s max in separate (non-interleaved) mode
  if (arr > 65535) arr = 65535;
  scope.rate_req = hz;
  scope.psc = (uint16_t)psc;
  scope.arr = (uint16_t)arr;
  uint32_t div = (psc + 1) * (arr + 1);
  scope.rate_actual = (TIMER_HZ + div / 2) / div;
  __Set(SYS_T_BASE_PSC, psc);
  __Set(SYS_T_BASE_ARR, arr);
  rearm();
  return 0;
}

static void apply_trigger(int unconditional)
{
  __Set(SYS_TRIGG_MODE, unconditional ? TRIG_UNCONDITIONAL
                                      : (uint32_t)(scope.trig_source << 3 | scope.trig_kind));
  __Set(SYS_V_THRESHOLD, scope.trig_level);
  __Set(SYS_T_THRESHOLD, scope.trig_width);
}

int scope_set_trigger(uint8_t source, uint8_t kind, uint8_t level, uint16_t width)
{
  if (source > 3 || kind > 7) return -1;
  scope.trig_source = source;
  scope.trig_kind = kind;
  scope.trig_level = level;
  scope.trig_width = width;
  apply_trigger(0);
  rearm();
  return 0;
}

int scope_set_acq(uint8_t mode, uint16_t auto_ms)
{
  if (mode > ACQ_SINGLE) return -1;
  scope.acq_mode = mode;
  scope.auto_ms = auto_ms ? auto_ms : 100;
  if (mode == ACQ_STOP) st = S_IDLE;
  else if (st != S_DONE) st = S_ARM;  // a pending frame re-arms once it has been sent
  return 0;
}

int scope_set_gen(uint8_t mode, uint32_t freq_hz, uint8_t duty)
{
  if (mode > GEN_SQUARE || duty > 100) return -1;
  if (mode == GEN_SQUARE && (freq_hz < 1 || freq_hz > 8000000)) return -1;
  if (freq_hz == 0) freq_hz = 1000;
  uint32_t psc = (TIMER_HZ / 65536) / freq_hz;
  uint32_t arr = (TIMER_HZ / (psc + 1) + freq_hz / 2) / freq_hz - 1;
  if (arr < 1) arr = 1;
  scope.gen_mode = mode;
  scope.gen_freq = freq_hz;
  scope.gen_duty = duty;
  __Set(SYS_DIGTAL_PSC, psc);
  __Set(SYS_DIGTAL_ARR, arr);
  // The output is inverted: CCR = ARR+1 holds it idle (as the stock app does for "off").
  __Set(SYS_DIGTAL_CCR, mode == GEN_OFF ? arr + 1 : ((arr + 1) * (100u - duty)) / 100u);
  return 0;
}

void scope_set_system(uint8_t backlight, uint8_t beep)
{
  if (backlight <= 100) { scope.backlight = backlight; __Set(SYS_BACKLIGHT, backlight); }
  if (beep <= 100) scope.beep = beep;  // stored; beeps are driven by the app when needed
}

void scope_init(void)
{
  __Set(SYS_ADC_CTRL, 1);
  __Set(SYS_STANDBY, 0);
  __Set(SYS_ADC_MODE, 0);  // separate channels

  scope.backlight = 50;
  scope.beep = 0;
  __Set(SYS_BACKLIGHT, scope.backlight);

  // Defaults: both channels mid-screen, 1 MS/s, rising edge on A at mid-screen, stopped.
  uint8_t mid_range = (uint8_t)(scope_range_count() / 2);
  scope_set_channel(0, mid_range, 0, ADC_ZERO + 100);
  scope_set_channel(1, mid_range, 0, ADC_ZERO + 100);
  scope_set_rate(1000000);
  scope_set_trigger(0, 1, ADC_ZERO + 100, 0);
  scope_set_gen(GEN_OFF, 1000, 50);
  scope_set_acq(ACQ_STOP, 100);
}

static void store_sample(uint16_t i, uint32_t w)
{
  // FPGA 2.61 swaps the two low bits of channel B when they differ.
  uint32_t b01 = w & 0x300;
  if (b01 == 0x100 || b01 == 0x200) w ^= 0x300;
  uint8_t *s = &frame.samples[i * 3];
  s[0] = (uint8_t)w;
  s[1] = (uint8_t)(w >> 8);
  s[2] = (uint8_t)((w >> 16) & 3);
}

const struct scope_frame *scope_poll(uint32_t now)
{
  switch (st) {
  case S_IDLE:
  case S_DONE:
    return st == S_DONE ? &frame : NULL;

  case S_ARM:
    forced = 0;
    apply_trigger(0);
    __Set(SYS_FIFO_CLR, 1);
    armed_at = now;
    st = S_WAIT_TRIG;
    return NULL;

  case S_WAIT_TRIG:
    if (__Get(SYS_FIFO_START)) {
      read_idx = 0;
      st = S_READ;
    } else if (scope.acq_mode == ACQ_AUTO && !forced && now - armed_at >= scope.auto_ms) {
      forced = 1;
      apply_trigger(1);
      __Set(SYS_FIFO_CLR, 1);
    }
    return NULL;

  case S_READ:
    if (__Get(SYS_FIFO_FULL)) {
      while (read_idx < SCOPE_DEPTH) store_sample(read_idx++, __Read_FIFO());
    } else {
      for (int n = 0; n < READ_BURST && read_idx < SCOPE_DEPTH; n++) {
        if (__Get(SYS_FIFO_EMPTY)) break;
        store_sample(read_idx++, __Read_FIFO());
      }
    }
    if (read_idx < SCOPE_DEPTH) return NULL;

    GPIOC->BRR = 1u << 5;  // park the FPGA FIFO select line (as QuadPawn does after reads)
    frame.frame_no = scope.frames;
    frame.flags = forced ? FRAME_AUTO : FRAME_TRIGGERED;
    if (scope.acq_mode == ACQ_SINGLE) frame.flags |= FRAME_LAST;
    frame.rate_actual = scope.rate_actual;
    frame.ch[0] = scope.ch[0];
    frame.ch[1] = scope.ch[1];
    frame.trig_source = scope.trig_source;
    frame.trig_kind = scope.trig_kind;
    frame.trig_level = scope.trig_level;
    frame.count = SCOPE_DEPTH;
    if (forced) apply_trigger(0);
    st = S_DONE;
    return &frame;
  }
  return NULL;
}

void scope_frame_done(void)
{
  if (st != S_DONE) return;
  scope.frames++;
  if (scope.acq_mode == ACQ_SINGLE) scope.acq_mode = ACQ_STOP;
  st = scope.acq_mode == ACQ_STOP ? S_IDLE : S_ARM;
}
