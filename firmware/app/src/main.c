// DSO Quad web-control firmware: binary protocol over USB CDC (docs/protocol.md),
// acquisition in scope.c, status screen and escape routes.
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "stm32f1xx.h"
#include "tusb.h"
#include "sys.h"
#include "escape.h"
#include "proto.h"
#include "scope.h"

#define FW_VERSION "0.2.1-m2+" BUILD_ID
#define ESCAPE_HOLD_MS 2000
#define BOOT_OK_MS     5000

extern volatile uint32_t stray_irq;
static volatile uint32_t ms;
static uint32_t sysclk_hz;

// ---------------------------------------------------------------- timing

void SysTick_Handler(void) { ms++; }

// SYS runs TIM3 as its 1 ms key-scan tick; the flag has to be cleared through SYS.
void TIM3_IRQHandler(void) { __Set(SYS_KEY_IF_RST, 0); }

uint32_t tusb_time_millis_api(void) { return ms; }

static void delay_ms(uint32_t n)
{
  uint32_t t0 = ms;
  while (ms - t0 < n) escape_watchdog_kick();
}

// ---------------------------------------------------------------- clocks & USB

// Work out SYSCLK from RCC as SYS left it (HSE is 8 MHz on the DS203).
static uint32_t read_sysclk(void)
{
  uint32_t cfgr = RCC->CFGR;
  switch (cfgr & RCC_CFGR_SWS) {
  case RCC_CFGR_SWS_HSE: return 8000000;
  case RCC_CFGR_SWS_PLL: {
    uint32_t mul = ((cfgr & RCC_CFGR_PLLMULL) >> RCC_CFGR_PLLMULL_Pos) + 2;
    if (mul > 16) mul = 16;
    uint32_t src = (cfgr & RCC_CFGR_PLLSRC) ? ((cfgr & RCC_CFGR_PLLXTPRE) ? 4000000 : 8000000) : 4000000;
    return src * mul;
  }
  default: return 8000000;  // HSI
  }
}

static const char *usb_clock_setup(void)
{
  if (sysclk_hz == 72000000) { RCC->CFGR &= ~RCC_CFGR_USBPRE; return "72MHz, USB /1.5"; }
  if (sysclk_hz == 48000000) { RCC->CFGR |= RCC_CFGR_USBPRE; return "48MHz, USB /1"; }
  return "UNSUPPORTED CLOCK";
}

static void usb_takeover(void)
{
  NVIC_DisableIRQ(USB_LP_CAN1_RX0_IRQn);
  NVIC_DisableIRQ(USB_HP_CAN1_TX_IRQn);
  NVIC_DisableIRQ(USBWakeUp_IRQn);

  RCC->APB1ENR &= ~RCC_APB1ENR_USBEN;
  RCC->APB1RSTR |= RCC_APB1RSTR_USBRST;
  RCC->APB1RSTR &= ~RCC_APB1RSTR_USBRST;

  // The D+ pull-up is hard-wired, so force a re-enumeration by holding D+ (PA12) low.
  RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;
  GPIOA->CRH = (GPIOA->CRH & ~(0xFu << 16)) | (0x2u << 16);  // output push-pull, 2 MHz
  GPIOA->BRR = GPIO_BRR_BR12;
  delay_ms(20);
  GPIOA->CRH = (GPIOA->CRH & ~(0xFu << 16)) | (0x4u << 16);  // back to floating input

  RCC->APB1ENR |= RCC_APB1ENR_USBEN;

  tusb_rhport_init_t dev_init = { .role = TUSB_ROLE_DEVICE, .speed = TUSB_SPEED_AUTO };
  tusb_init(0, &dev_init);
}

void USB_HP_CAN1_TX_IRQHandler(void) { tud_int_handler(0); }
void USB_LP_CAN1_RX0_IRQHandler(void) { tud_int_handler(0); }
void USBWakeUp_IRQHandler(void) { tud_int_handler(0); }

// ---------------------------------------------------------------- protocol output

enum {
  MSG_HELLO = 0x01, MSG_PING = 0x02, MSG_GET_STATE = 0x03,
  MSG_SET_CHANNEL = 0x10, MSG_SET_TIMEBASE = 0x11, MSG_SET_TRIGGER = 0x12, MSG_SET_ACQ = 0x13,
  MSG_SET_GEN = 0x14, MSG_SET_SYSTEM = 0x15, MSG_GET_TABLES = 0x20,
  MSG_REG_SET = 0x30, MSG_REG_GET = 0x31, MSG_PARAM_SET = 0x32, MSG_REBOOT = 0x3F,
  MSG_INFO = 0x81, MSG_PONG = 0x82, MSG_STATE = 0x83, MSG_FRAME = 0x84, MSG_TABLE = 0x85,
  MSG_LOG = 0x8E, MSG_ACK = 0xA0, MSG_REG_VALUE = 0xB1,
};
enum { ACK_OK, ACK_BAD_LENGTH, ACK_BAD_VALUE, ACK_UNKNOWN_TYPE, ACK_BAD_FRAME, ACK_BUSY };

#define PROTO_VERSION 1

static struct proto_tx tx;

static void cdc_sink(const uint8_t *p, size_t len)
{
  while (len && tud_cdc_connected()) {
    uint32_t n = tud_cdc_write(p, (uint32_t)len);
    p += n;
    len -= n;
    if (len) {
      tud_cdc_write_flush();
      tud_task();
      escape_watchdog_kick();
    }
  }
}

static void msg_end(void)
{
  proto_tx_end(&tx);
  tud_cdc_write_flush();
}

static void send_ack(uint8_t seq, uint8_t status)
{
  proto_tx_begin(&tx, cdc_sink, MSG_ACK, seq);
  proto_tx_u8(&tx, status);
  msg_end();
}

static void put_channels(const struct scope_channel ch[2])
{
  for (int i = 0; i < 2; i++) {
    proto_tx_u8(&tx, ch[i].range);
    proto_tx_u8(&tx, ch[i].coupling);
    proto_tx_u8(&tx, ch[i].offset);
  }
}

static void send_info(uint8_t seq)
{
  proto_tx_begin(&tx, cdc_sink, MSG_INFO, seq);
  proto_tx_u16(&tx, PROTO_VERSION);
  proto_tx_u32(&tx, __GetDev_SN());
  proto_tx_put(&tx, FW_VERSION, sizeof FW_VERSION);  // includes the NUL
  msg_end();
}

static void send_state(uint8_t seq)
{
  proto_tx_begin(&tx, cdc_sink, MSG_STATE, seq);
  proto_tx_u8(&tx, scope.acq_mode);
  proto_tx_u8(&tx, (uint8_t)scope_running());
  put_channels(scope.ch);
  proto_tx_u32(&tx, scope.rate_req);
  proto_tx_u32(&tx, scope.rate_actual);
  proto_tx_u16(&tx, scope.psc);
  proto_tx_u16(&tx, scope.arr);
  proto_tx_u8(&tx, scope.trig_source);
  proto_tx_u8(&tx, scope.trig_kind);
  proto_tx_u8(&tx, scope.trig_level);
  proto_tx_u16(&tx, scope.trig_width);
  proto_tx_u16(&tx, scope.auto_ms);
  proto_tx_u8(&tx, scope.gen_mode);
  proto_tx_u32(&tx, scope.gen_freq);
  proto_tx_u8(&tx, scope.gen_duty);
  proto_tx_u8(&tx, scope.backlight);
  proto_tx_u8(&tx, scope.beep);
  proto_tx_u32(&tx, scope.frames);
  msg_end();
}

static void send_frame(const struct scope_frame *f)
{
  proto_tx_begin(&tx, cdc_sink, MSG_FRAME, (uint8_t)f->frame_no);
  proto_tx_u32(&tx, f->frame_no);
  proto_tx_u8(&tx, f->flags);
  proto_tx_u32(&tx, f->rate_actual);
  put_channels(f->ch);
  proto_tx_u8(&tx, f->trig_source);
  proto_tx_u8(&tx, f->trig_kind);
  proto_tx_u8(&tx, f->trig_level);
  proto_tx_u16(&tx, SCOPE_PRETRIGGER);
  proto_tx_u16(&tx, f->count);
  proto_tx_put(&tx, f->samples, (size_t)f->count * 3);
  msg_end();
}

static void send_table(uint8_t seq, uint8_t id, const void *data, uint8_t elem_size, uint32_t count)
{
  if (count > 64) count = 64;  // sanity bound; real tables are much smaller
  proto_tx_begin(&tx, cdc_sink, MSG_TABLE, seq);
  proto_tx_u8(&tx, id);
  proto_tx_u8(&tx, elem_size);
  proto_tx_u8(&tx, (uint8_t)count);
  proto_tx_put(&tx, data, elem_size * count);
  msg_end();
}

static void send_tables(uint8_t seq)
{
  const G_attr *g = (const G_attr *)__Get(SYS_GLOBAL);
  send_table(seq, 0, g, sizeof(G_attr), 1);
  send_table(seq, 1, (const void *)__Get(SYS_VERTICAL), sizeof(Y_attr), g->Yp_Max + 1u);
  send_table(seq, 2, (const void *)__Get(SYS_HORIZONTAL), sizeof(X_attr), g->Xp_Max + 6u);
  send_table(seq, 3, (const void *)__Get(SYS_TRIGGER), sizeof(T_attr), g->Tg_Num + 1u);
}

// ---------------------------------------------------------------- protocol input

static void handle_msg(const uint8_t *m, size_t len)
{
  uint8_t type = m[0], seq = m[1];
  const uint8_t *b = m + 2;
  size_t n = len - 2;
#define NEED(k) do { if (n != (k)) { send_ack(seq, ACK_BAD_LENGTH); return; } } while (0)
#define RESULT(r) send_ack(seq, (r) == 0 ? ACK_OK : ACK_BAD_VALUE)

  switch (type) {
  case MSG_HELLO: NEED(0); send_info(seq); break;
  case MSG_PING:
    proto_tx_begin(&tx, cdc_sink, MSG_PONG, seq);
    proto_tx_put(&tx, b, n);
    msg_end();
    break;
  case MSG_GET_STATE: NEED(0); send_state(seq); break;
  case MSG_SET_CHANNEL: NEED(4); RESULT(scope_set_channel(b[0], b[1], b[2], b[3])); break;
  case MSG_SET_TIMEBASE: NEED(4); RESULT(scope_set_rate(get_u32(b))); break;
  case MSG_SET_TRIGGER: NEED(5); RESULT(scope_set_trigger(b[0], b[1], b[2], get_u16(b + 3))); break;
  case MSG_SET_ACQ: NEED(3); RESULT(scope_set_acq(b[0], get_u16(b + 1))); break;
  case MSG_SET_GEN: NEED(6); RESULT(scope_set_gen(b[0], get_u32(b + 1), b[5])); break;
  case MSG_SET_SYSTEM: NEED(2); scope_set_system(b[0], b[1]); send_ack(seq, ACK_OK); break;
  case MSG_GET_TABLES: NEED(0); send_tables(seq); send_ack(seq, ACK_OK); break;
  case MSG_REG_SET: NEED(5); __Set(b[0], get_u32(b + 1)); send_ack(seq, ACK_OK); break;
  case MSG_REG_GET: {
    NEED(1);
    uint32_t v = __Get(b[0]);
    proto_tx_begin(&tx, cdc_sink, MSG_REG_VALUE, seq);
    proto_tx_u8(&tx, b[0]);
    proto_tx_u32(&tx, v);
    msg_end();
    break;
  }
  case MSG_PARAM_SET: NEED(2); __Set_Param(b[0], b[1]); send_ack(seq, ACK_OK); break;
  case MSG_REBOOT:
    NEED(1);
    if (b[0] > 1) { send_ack(seq, ACK_BAD_VALUE); break; }
    send_ack(seq, ACK_OK);
    delay_ms(50);  // let the ACK reach the host
    if (b[0]) escape_to_fallback();
    escape_reboot();
  default: send_ack(seq, ACK_UNKNOWN_TYPE); break;
  }
#undef NEED
#undef RESULT
}

static struct proto_rx rx;

static void cdc_poll(void)
{
  uint8_t buf[64];
  while (tud_cdc_available()) {
    uint32_t n = tud_cdc_read(buf, sizeof buf);
    for (uint32_t i = 0; i < n; i++) {
      const uint8_t *msg;
      size_t len;
      int r = proto_rx_byte(&rx, buf[i], &msg, &len);
      if (r > 0) handle_msg(msg, len);
      else if (r < 0) send_ack(0, ACK_BAD_FRAME);
    }
  }
}

// ---------------------------------------------------------------- status screen

static const char *version_str(const char *p)
{
  // SYS returns pointers into flash (or RAM); anything else means "not provided".
  uint32_t a = (uint32_t)p;
  if ((a >= 0x08000000u && a < 0x08040000u) || (a >= 0x20000000u && a < 0x2000C000u)) return p;
  return "n/a";
}

static void status_line(int row, uint16_t color, const char *fmt, ...) __attribute__((format(printf, 3, 4)));
static void status_line(int row, uint16_t color, const char *fmt, ...)
{
  static char shown[12][50];
  char buf[50];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  int n = (int)strlen(buf);
  while (n < 49) buf[n++] = ' ';  // pad to overwrite the previous text
  buf[49] = 0;
  if (row < 12 && strcmp(shown[row], buf)) {
    strcpy(shown[row], buf);
    __Display_Str(0, (uint16_t)(LCD_H - 16 - row * 18), color, LCD_PRN, buf);
  }
}

static void status_update(void)
{
  const char *usb = tud_suspended() ? "suspended" : tud_mounted() ? "connected" : "waiting for host";
  status_line(3, tud_mounted() ? C_GRN : C_YEL, " USB:  %s", usb);
  status_line(4, tud_cdc_connected() ? C_GRN : C_GRY, " Port: %s", tud_cdc_connected() ? "open" : "closed");
  status_line(6, C_WHT, " Battery %lu mV   Up %lu s", (unsigned long)__Get(SYS_V_BATTERY),
              (unsigned long)(ms / 1000));
  static const char *const modes[] = { "stopped", "normal", "auto", "single" };
  status_line(5, C_WHT, " Acq:  %s  %lu S/s  frames %lu", modes[scope.acq_mode & 3],
              (unsigned long)scope.rate_actual, (unsigned long)scope.frames);
  if (stray_irq) status_line(7, C_YEL, " Disabled stray IRQ %lu", (unsigned long)(stray_irq - 1));
}

// ---------------------------------------------------------------- main

static void check_escape_keys(void)
{
  static uint32_t held_since;
  uint32_t keys = ~__Get(SYS_KEY_STATUS);  // 1 = pressed
  int combo = (keys & KEY2_SQUARE) && (keys & KEY3_CIRCLE);

  if (!combo) { held_since = 0; return; }
  if (!held_since) { held_since = ms ? ms : 1; return; }
  if (ms - held_since < ESCAPE_HOLD_MS) return;

  // Keys still held across the reset would make SYS boot another slot, so wait for release.
  status_line(9, C_YEL, " Release the buttons to exit...");
  while (~__Get(SYS_KEY_STATUS) & (KEY1_PLAY | KEY2_SQUARE | KEY3_CIRCLE | KEY4_TRI))
    escape_watchdog_kick();
  delay_ms(100);
  escape_to_fallback();
}

int main(void)
{
  escape_watchdog_start();
  __Set(SYS_BEEP_VOLUME, 0);  // SYS leaves the boot beep on for the APP to stop

  sysclk_hz = read_sysclk();
  SysTick_Config(sysclk_hz / 1000);

  __Clear_Screen(C_BLK);
  status_line(0, C_CYN, " DSO Quad Web Control");
  status_line(8, C_GRY, " fw " FW_VERSION);
  status_line(1, C_WHT, " HW %s  DFU %s", version_str(__Chk_HDW()), version_str(__Chk_DFU()));
  status_line(2, C_WHT, " Clock %s", usb_clock_setup());
  status_line(10, C_GRY, " Exit to scope: hold [] + () for 2 s");
  status_line(11, C_GRY, " (or power on holding () for the fallback)");

  scope_init();
  usb_takeover();

  uint32_t last_status = 0, last_battery = 0;
  int boot_ok = 0, was_connected = 0;
  for (;;) {
    escape_watchdog_kick();
    tud_task();
    cdc_poll();
    check_escape_keys();

    int connected = tud_cdc_connected();
    if (was_connected && !connected) scope_set_acq(ACQ_STOP, scope.auto_ms);  // host went away
    was_connected = connected;

    const struct scope_frame *f = scope_poll(ms);
    if (f) {
      if (connected) send_frame(f);
      scope_frame_done();
    }

    if (!boot_ok && ms > BOOT_OK_MS) { escape_boot_ok(); boot_ok = 1; }
    if (ms - last_status > 250) { last_status = ms; status_update(); }
    if (ms - last_battery > 1000) { last_battery = ms; __Set(SYS_BATTERY_DT, 1); }
  }
}
