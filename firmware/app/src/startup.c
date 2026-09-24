// Reset handler and vector table for the APP1 image (STM32F103xE, 60 external IRQs).
#include <stdint.h>
#include <string.h>
#include "stm32f1xx.h"
#include "escape.h"

extern uint32_t _estack, _sidata, _sdata, _edata, _sbss, _ebss;
int main(void);

// Last unexpected IRQ number (for the status screen); 0 = none.
volatile uint32_t stray_irq;

void Reset_Handler(void)
{
  escape_early_check();

  memcpy(&_sdata, &_sidata, (uint32_t)&_edata - (uint32_t)&_sdata);
  memset(&_sbss, 0, (uint32_t)&_ebss - (uint32_t)&_sbss);

  SCB->VTOR = (uint32_t)0x0800C000;
  main();
  for (;;) {}
}

// SYS can leave peripherals with interrupts enabled. Rather than hang, switch the
// offending IRQ off and remember it.
void Default_Handler(void)
{
  int32_t irq = (int32_t)(__get_IPSR() & 0x1FF) - 16;
  if (irq >= 0) {
    NVIC_DisableIRQ((IRQn_Type)irq);
    stray_irq = (uint32_t)irq + 1;
    return;
  }
  for (;;) {}  // unexpected fault: the watchdog resets us and counts it
}

void HardFault_Handler(void) { for (;;) {} }

#define WEAK_ALIAS __attribute__((weak, alias("Default_Handler")))
void NMI_Handler(void) WEAK_ALIAS;
void MemManage_Handler(void) WEAK_ALIAS;
void BusFault_Handler(void) WEAK_ALIAS;
void UsageFault_Handler(void) WEAK_ALIAS;
void SVC_Handler(void) WEAK_ALIAS;
void DebugMon_Handler(void) WEAK_ALIAS;
void PendSV_Handler(void) WEAK_ALIAS;
void SysTick_Handler(void) WEAK_ALIAS;
void TIM3_IRQHandler(void) WEAK_ALIAS;
void USB_HP_CAN1_TX_IRQHandler(void) WEAK_ALIAS;
void USB_LP_CAN1_RX0_IRQHandler(void) WEAK_ALIAS;
void USBWakeUp_IRQHandler(void) WEAK_ALIAS;

#define D Default_Handler
__attribute__((section(".isr_vector"), used))
void (*const vector_table[16 + 60])(void) = {
  (void (*)(void))&_estack, Reset_Handler, NMI_Handler, HardFault_Handler,
  MemManage_Handler, BusFault_Handler, UsageFault_Handler, 0, 0, 0, 0,
  SVC_Handler, DebugMon_Handler, 0, PendSV_Handler, SysTick_Handler,
  /*  0 */ D, D, D, D, D, D, D, D, D, D,
  /* 10 */ D, D, D, D, D, D, D, D, D,
  /* 19 */ USB_HP_CAN1_TX_IRQHandler,
  /* 20 */ USB_LP_CAN1_RX0_IRQHandler,
  /* 21 */ D, D, D, D, D, D, D, D,
  /* 29 */ TIM3_IRQHandler,
  /* 30 */ D, D, D, D, D, D, D, D, D, D, D, D,
  /* 42 */ USBWakeUp_IRQHandler,
  /* 43 */ D, D, D, D, D, D, D, D, D, D, D, D, D, D, D, D, D,
};
