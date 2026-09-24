#include "escape.h"
#include "stm32f1xx.h"
#include "sys.h"

// Backup registers survive a system reset (the DFU -> SYS -> APP1 chain runs again after
// NVIC_SystemReset), and nothing else on the DS203 uses them.
#define BKP_EXIT_FLAG     (BKP->DR1)
#define BKP_WDG_RESETS    (BKP->DR2)
#define EXIT_MAGIC        0xE5C3u
#define MAX_WDG_RESETS    3

static void backup_unlock(void)
{
  RCC->APB1ENR |= RCC_APB1ENR_PWREN | RCC_APB1ENR_BKPEN;
  (void)RCC->APB1ENR;
  PWR->CR |= PWR_CR_DBP;
}

static void __attribute__((noreturn)) jump_to_app3(void)
{
  uint32_t sp = *(volatile uint32_t *)APP3_BASE;
  uint32_t pc = *(volatile uint32_t *)(APP3_BASE + 4);

  // Nothing has been initialised yet on this path, so the hardware is exactly as SYS left
  // it for an APP. Hand over like SYS does: vector table, stack, entry point.
  SCB->VTOR = APP3_BASE;
  __set_MSP(sp);
  ((void (*)(void))pc)();
  for (;;) {}
}

static int app3_present(void)
{
  uint32_t sp = *(volatile uint32_t *)APP3_BASE;
  uint32_t pc = *(volatile uint32_t *)(APP3_BASE + 4);
  return (sp & 0xFFFE0000u) == 0x20000000u && pc > APP3_BASE && pc < FPGA_BASE;
}

void escape_early_check(void)
{
  backup_unlock();

  int by_watchdog = (RCC->CSR & RCC_CSR_IWDGRSTF) != 0;
  RCC->CSR |= RCC_CSR_RMVF;

  uint32_t count = by_watchdog ? BKP_WDG_RESETS + 1 : 0;
  int exit_requested = BKP_EXIT_FLAG == EXIT_MAGIC;

  if ((exit_requested || count >= MAX_WDG_RESETS) && app3_present()) {
    BKP_EXIT_FLAG = 0;
    BKP_WDG_RESETS = 0;
    jump_to_app3();
  }

  BKP_EXIT_FLAG = 0;
  BKP_WDG_RESETS = count;
}

uint32_t escape_watchdog_resets(void)
{
  return BKP_WDG_RESETS;
}

void escape_watchdog_start(void)
{
  // LSI ~40 kHz / 64 = 625 Hz; 1250 ticks ~= 2 s.
  IWDG->KR = 0x5555;
  IWDG->PR = 4;
  IWDG->RLR = 1250;
  IWDG->KR = 0xAAAA;
  IWDG->KR = 0xCCCC;
}

void escape_watchdog_kick(void)
{
  IWDG->KR = 0xAAAA;
}

void escape_boot_ok(void)
{
  BKP_WDG_RESETS = 0;
}

void escape_to_fallback(void)
{
  BKP_EXIT_FLAG = EXIT_MAGIC;
  NVIC_SystemReset();
}

void escape_reboot(void)
{
  BKP_EXIT_FLAG = 0;
  NVIC_SystemReset();
}
