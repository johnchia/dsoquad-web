// M1 "hello USB serial": CDC-ACM port with test commands, status screen and escape routes.
//
// Line commands (terminate with \n):
//   ping          -> pong
//   info          -> versions, clocks, battery, counters
//   tx <bytes>    -> device sends <bytes> of test pattern (throughput test)
//   rx <bytes>    -> device swallows <bytes>, then reports time taken
//   exit          -> reboot into the APP3 fallback scope (escape route 1)
//   reboot        -> reboot into this firmware
//   hang          -> stop kicking the watchdog (tests escape route 5)
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "stm32f1xx.h"
#include "tusb.h"
#include "sys.h"
#include "escape.h"

#define FW_VERSION "0.1.1-m1"
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

// ---------------------------------------------------------------- CDC helpers

static void cdc_write_all(const void *buf, uint32_t len)
{
  const uint8_t *p = buf;
  while (len && tud_cdc_connected()) {
    uint32_t n = tud_cdc_write(p, len);
    p += n;
    len -= n;
    tud_task();
    escape_watchdog_kick();
  }
  tud_cdc_write_flush();
}

static void cdc_printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void cdc_printf(const char *fmt, ...)
{
  char buf[256];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n > (int)sizeof buf - 1) n = sizeof buf - 1;
  if (n > 0) cdc_write_all(buf, (uint32_t)n);
}

static const char *version_str(const char *p)
{
  // SYS returns pointers into flash (or RAM); anything else means "not provided".
  uint32_t a = (uint32_t)p;
  if ((a >= 0x08000000u && a < 0x08040000u) || (a >= 0x20000000u && a < 0x2000C000u)) return p;
  return "n/a";
}

static const char *sys_str(uint8_t kind)
{
  uint32_t p = __Get(kind);
  return p ? version_str((const char *)p) : "n/a";
}

// ---------------------------------------------------------------- commands

static uint32_t rx_remaining, rx_start;

static void cmd_tx(uint32_t total)
{
  static uint8_t pattern[64];
  for (unsigned i = 0; i < sizeof pattern; i++) pattern[i] = (uint8_t)i;
  uint32_t left = total;
  while (left && tud_cdc_connected()) {
    uint32_t n = left < sizeof pattern ? left : sizeof pattern;
    uint32_t w = tud_cdc_write(pattern, n);
    left -= w;
    if (w < n) tud_cdc_write_flush();
    tud_task();
    escape_watchdog_kick();
  }
  tud_cdc_write_flush();
}

static void handle_line(char *line)
{
  char *arg = strchr(line, ' ');
  if (arg) *arg++ = 0;

  if (!strcmp(line, "ping")) {
    cdc_printf("pong\r\n");
  } else if (!strcmp(line, "info")) {
    cdc_printf("fw %s\r\nhw %s\r\nsys %s\r\ndfu %s\r\nfpga %s\r\nfpga_ok %lu\r\n",
               FW_VERSION, version_str(__Chk_HDW()), sys_str(SYS_SYSVER), version_str(__Chk_DFU()),
               sys_str(SYS_FPGAVER), (unsigned long)__Get(SYS_FPGA_OK));
    cdc_printf("serial %08lX\r\nsysclk %lu\r\nbattery_mv %lu\r\ncharging %lu\r\nusb_power %lu\r\n",
               (unsigned long)__GetDev_SN(), (unsigned long)sysclk_hz,
               (unsigned long)__Get(SYS_V_BATTERY), (unsigned long)__Get(SYS_CHARGE),
               (unsigned long)__Get(SYS_USB_POWER));
    cdc_printf("uptime_ms %lu\r\nstray_irq %lu\r\nwdg_resets %lu\r\n", (unsigned long)ms,
               (unsigned long)(stray_irq ? stray_irq - 1 : 0xFFFFFFFFu),
               (unsigned long)escape_watchdog_resets());
  } else if (!strcmp(line, "tx") && arg) {
    cmd_tx(strtoul(arg, NULL, 0));
  } else if (!strcmp(line, "rx") && arg) {
    rx_remaining = strtoul(arg, NULL, 0);
    rx_start = ms;
  } else if (!strcmp(line, "exit")) {
    cdc_printf("exiting to APP3\r\n");
    delay_ms(50);
    escape_to_fallback();
  } else if (!strcmp(line, "reboot")) {
    cdc_printf("rebooting\r\n");
    delay_ms(50);
    escape_reboot();
  } else if (!strcmp(line, "hang")) {
    cdc_printf("hanging; watchdog reset in ~2 s\r\n");
    delay_ms(50);
    for (;;) {}
  } else if (line[0]) {
    cdc_printf("? %s\r\n", line);
  }
}

static void cdc_poll(void)
{
  static char line[64];
  static uint32_t len;
  uint8_t buf[64];

  while (tud_cdc_available()) {
    uint32_t n = tud_cdc_read(buf, sizeof buf);
    uint32_t i = 0;
    if (rx_remaining) {
      uint32_t eat = n < rx_remaining ? n : rx_remaining;
      rx_remaining -= eat;
      i = eat;
      if (!rx_remaining) cdc_printf("rx done %lu ms\r\n", (unsigned long)(ms - rx_start));
    }
    for (; i < n; i++) {
      char c = (char)buf[i];
      if (c == '\r') continue;
      if (c == '\n') {
        line[len] = 0;
        handle_line(line);
        len = 0;
      } else if (len < sizeof line - 1) {
        line[len++] = c;
      }
    }
  }
}

// ---------------------------------------------------------------- status screen

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
  status_line(0, C_CYN, " DSO Quad Web Control  v" FW_VERSION);
  status_line(1, C_WHT, " HW %s  DFU %s", version_str(__Chk_HDW()), version_str(__Chk_DFU()));
  status_line(2, C_WHT, " Clock %s", usb_clock_setup());
  status_line(10, C_GRY, " Exit to scope: hold [] + () for 2 s");
  status_line(11, C_GRY, " (or power on holding () for the fallback)");

  usb_takeover();

  uint32_t last_status = 0, last_battery = 0;
  int boot_ok = 0;
  for (;;) {
    escape_watchdog_kick();
    tud_task();
    cdc_poll();
    check_escape_keys();

    if (!boot_ok && ms > BOOT_OK_MS) { escape_boot_ok(); boot_ok = 1; }
    if (ms - last_status > 250) { last_status = ms; status_update(); }
    if (ms - last_battery > 1000) { last_battery = ms; __Set(SYS_BATTERY_DT, 1); }
  }
}
