// DS203 SYS 1.5x calls used by this firmware. Implemented by SYS; linked through sys/BIOS.S.
// Constants from the e-Design DS203 BIOS.h (see ref/dso203_gcc/App/inc/BIOS.h).
#pragma once
#include <stdint.h>

#define APP1_BASE 0x0800C000u
#define APP3_BASE 0x0801C000u
#define FPGA_BASE 0x0802C000u

// __Set objects
#define SYS_BACKLIGHT    2   // 0..100
#define SYS_BEEP_VOLUME  3   // 0..100
#define SYS_BATTERY_DT   4   // 1 = start a battery measurement (app does this once a second)
#define SYS_KEY_IF_RST   19  // clear the TIM3 (key scan tick) interrupt flag

// __Get kinds
#define SYS_KEY_STATUS   4   // key bits, 0 = pressed
#define SYS_USB_POWER    5
#define SYS_V_BATTERY    6   // mV
#define SYS_FPGA_OK      11
#define SYS_CHARGE       12
#define SYS_HDWVER       13
#define SYS_DFUVER       14
#define SYS_SYSVER       15
#define SYS_FPGAVER      16

// SYS_KEY_STATUS bits (active low)
#define KEY1_PLAY   0x4000  // >||
#define KEY2_SQUARE 0x2000  // []
#define KEY3_CIRCLE 0x0100  // ()
#define KEY4_TRI    0x0200  // /\ .

// LCD: 400x240, colours are BGR565
#define LCD_W 400
#define LCD_H 240
#define C_BLK 0x0000
#define C_WHT 0xFFFF
#define C_RED 0x001F
#define C_GRN 0x07E0
#define C_YEL 0x07FF
#define C_CYN 0xFFE0
#define C_GRY 0x7BEF
#define LCD_PRN 0
#define LCD_INV 1

void     __Clear_Screen(uint16_t color);
void     __Display_Str(uint16_t x0, uint16_t y0, uint16_t color, uint8_t mode, const char *s);
void     __Set(uint8_t object, uint32_t value);
uint32_t __Get(uint8_t kind);
uint32_t __GetDev_SN(void);
const char *__Chk_HDW(void);  // hardware version string
const char *__Chk_DFU(void);  // DFU version string
