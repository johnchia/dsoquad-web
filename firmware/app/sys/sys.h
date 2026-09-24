// DS203 SYS 1.5x calls used by this firmware. Implemented by SYS; linked through sys/BIOS.S.
// Constants from the e-Design DS203 BIOS.h (see ref/dso203_gcc/App/inc/BIOS.h).
#pragma once
#include <stdint.h>

#define APP1_BASE 0x0800C000u
#define APP3_BASE 0x0801C000u
#define FPGA_BASE 0x0802C000u

// __Set objects
#define SYS_CH_A_OFFSET  0   // channel zero position, ADC codes
#define SYS_CH_B_OFFSET  1
#define SYS_BACKLIGHT    2   // 0..100
#define SYS_BEEP_VOLUME  3   // 0..100
#define SYS_BATTERY_DT   4   // 1 = start a battery measurement (app does this once a second)
#define SYS_ADC_MODE     5   // 0 separate, 1 interleaved
#define SYS_FIFO_CLR     6   // 1 = reset FIFO write pointer (starts a capture)
#define SYS_T_BASE_PSC   7   // sample clock: 72 MHz / (PSC+1) / (ARR+1)
#define SYS_T_BASE_ARR   8
#define SYS_CH_A_COUPLE  9   // 0 DC, 1 AC
#define SYS_CH_A_RANGE   10
#define SYS_CH_B_COUPLE  11
#define SYS_CH_B_RANGE   12
#define SYS_DIGTAL_PSC   16  // square-wave output (TIM4)
#define SYS_DIGTAL_ARR   17
#define SYS_DIGTAL_CCR   18
#define SYS_KEY_IF_RST   19  // clear the TIM3 (key scan tick) interrupt flag
#define SYS_STANDBY      20  // 0 = leave power-down
#define SYS_TRIGG_MODE   32  // (source << 3) | kind; >= 0x20 unconditional
#define SYS_V_THRESHOLD  33  // trigger level, ADC codes
#define SYS_T_THRESHOLD  34  // pulse-width threshold
#define SYS_ADC_CTRL     36  // 1 = enable

#define TRIG_UNCONDITIONAL 0x20

// __Get kinds
#define SYS_FIFO_EMPTY   1
#define SYS_FIFO_START   2   // trigger seen
#define SYS_FIFO_FULL    3
#define SYS_KEY_STATUS   4   // key bits, 0 = pressed
#define SYS_USB_POWER    5
#define SYS_V_BATTERY    6   // mV
#define SYS_VERTICAL     7   // -> Y_attr[] (ranges)
#define SYS_HORIZONTAL   8   // -> X_attr[] (timebases)
#define SYS_GLOBAL       9   // -> G_attr
#define SYS_TRIGGER      10  // -> T_attr[]
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

// SYS tables (layouts from the e-Design BIOS.h; sizes checked in scope.c)
typedef struct {
  uint16_t LCD_X, LCD_Y, Yp_Max, Xp_Max, Tg_Num, Yv_Max, Xt_Max, Co_Max;
  uint8_t Ya_Num, Yd_Num, INSERT;
  uint16_t KpA1, KpA2, KpB1, KpB2;
} G_attr;
typedef struct { char STR[8]; int16_t KA1; uint16_t KA2; int16_t KB1; uint16_t KB2; uint32_t SCALE; } Y_attr;
typedef struct { char STR[8]; int16_t PSC; uint16_t ARR, CCR, KP; uint32_t SCALE; } X_attr;
typedef struct { char STR[8]; uint8_t CHx, CMD; } T_attr;

void     __Clear_Screen(uint16_t color);
void     __Display_Str(uint16_t x0, uint16_t y0, uint16_t color, uint8_t mode, const char *s);
void     __Set(uint8_t object, uint32_t value);
uint32_t __Get(uint8_t kind);
uint32_t __GetDev_SN(void);
uint32_t __Read_FIFO(void);   // next FIFO word: A bits 0-7, B 8-15, C bit 16, D bit 17
void     __Set_Param(uint8_t addr, uint8_t value);
const char *__Chk_HDW(void);  // hardware version string
const char *__Chk_DFU(void);  // DFU version string
