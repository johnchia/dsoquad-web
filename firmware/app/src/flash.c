#include "flash.h"
#include "stm32f1xx.h"
#include "escape.h"

static int wait(void)
{
  while (FLASH->SR & FLASH_SR_BSY) escape_watchdog_kick();
  uint32_t sr = FLASH->SR;
  FLASH->SR = FLASH_SR_EOP | FLASH_SR_PGERR | FLASH_SR_WRPRTERR;  // write 1 to clear
  return (sr & (FLASH_SR_PGERR | FLASH_SR_WRPRTERR)) ? -1 : 0;
}

static int unlock(void)
{
  RCC->CR |= RCC_CR_HSION;  // the flash programming interface runs from HSI
  while (!(RCC->CR & RCC_CR_HSIRDY)) {}
  FLASH->KEYR = 0x45670123u;
  FLASH->KEYR = 0xCDEF89ABu;
  return wait();
}

int flash_erase(uint32_t addr)
{
  int err = unlock();
  FLASH->CR |= FLASH_CR_PER;
  FLASH->AR = addr;
  FLASH->CR |= FLASH_CR_STRT;
  err |= wait();
  FLASH->CR &= ~FLASH_CR_PER;
  FLASH->CR |= FLASH_CR_LOCK;
  return err;
}

int flash_write(uint32_t addr, const uint8_t *data, size_t n)
{
  int err = unlock();
  FLASH->CR |= FLASH_CR_PG;
  for (size_t i = 0; i < n && !err; i += 2) {
    *(volatile uint16_t *)(addr + i) = (uint16_t)(data[i] | (i + 1 < n ? data[i + 1] : 0xFF) << 8);
    err |= wait();
  }
  FLASH->CR &= ~FLASH_CR_PG;
  FLASH->CR |= FLASH_CR_LOCK;
  return err;
}
