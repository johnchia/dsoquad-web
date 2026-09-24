#include "fwupdate.h"
#include "stm32f1xx.h"
#include "flash.h"

extern uint32_t _sidata, _sdata, _edata, _estack;

static uint32_t stage_size, stage_crc;

// Staging starts at the first page after the running image (its .data initialisers included).
static uint32_t stage_base(void)
{
  uint32_t end = (uint32_t)&_sidata + ((uint32_t)&_edata - (uint32_t)&_sdata);
  return (end + FLASH_PAGE - 1) & ~(FLASH_PAGE - 1);
}

uint32_t fw_room(void) { return APP_LIMIT - stage_base(); }

// CRC-32 (IEEE, as zlib): reflected 0xEDB88320, init and final xor 0xFFFFFFFF.
static uint32_t crc32(const uint8_t *p, size_t n)
{
  uint32_t c = 0xFFFFFFFFu;
  while (n--) {
    c ^= *p++;
    for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & -(c & 1));
  }
  return ~c;
}

int fw_begin(uint32_t size, uint32_t crc)
{
  stage_size = 0;
  if (size < 8 || size > fw_room() || size & 1) return FW_ERR_SIZE;
  for (uint32_t a = stage_base(); a < stage_base() + size; a += FLASH_PAGE)
    if (flash_erase(a)) return FW_ERR_FLASH;
  stage_size = size;
  stage_crc = crc;
  return 0;
}

int fw_data(uint32_t offset, const uint8_t *data, size_t n)
{
  if (!stage_size || offset & 1 || n & 1 || offset > stage_size || n > stage_size - offset) return FW_ERR_VALUE;
  const uint8_t *dst = (const uint8_t *)(stage_base() + offset);
  int same = 1, blank = 1;
  for (size_t i = 0; i < n; i++) { same &= dst[i] == data[i]; blank &= dst[i] == 0xFF; }
  if (same) return 0;  // a repeated chunk
  if (!blank) return FW_ERR_VALUE;
  if (flash_write((uint32_t)dst, data, n)) return FW_ERR_FLASH;
  for (size_t i = 0; i < n; i++) if (dst[i] != data[i]) return FW_ERR_FLASH;
  return 0;
}

int fw_check(uint32_t size, uint32_t crc)
{
  if (!stage_size || size != stage_size || crc != stage_crc) return FW_ERR_VALUE;
  const uint32_t *img = (const uint32_t *)stage_base();
  if (crc32((const uint8_t *)img, size) != crc) return FW_ERR_VALUE;
  // Vector table: an initial stack in APP RAM and a Thumb reset handler inside the image.
  uint32_t sp = img[0], pc = img[1];
  if (sp < 0x20003000u || sp > (uint32_t)&_estack || sp & 3) return FW_ERR_VALUE;
  if (!(pc & 1) || pc < APP_BASE || pc >= APP_BASE + size) return FW_ERR_VALUE;
  return 0;
}

// Runs from RAM (in .data) with interrupts off, since it erases the code everything else lives
// in. It may only touch registers: no calls into flash, not even memcpy.
__attribute__((section(".ramfunc"), noinline, noreturn))
void fw_copy_and_reset(uint32_t src, uint32_t size)
{
  volatile uint16_t *dst = (volatile uint16_t *)APP_BASE;
  const volatile uint16_t *s = (const volatile uint16_t *)src;
  FLASH->KEYR = 0x45670123u;
  FLASH->KEYR = 0xCDEF89ABu;
  for (uint32_t off = 0; off < size; off += FLASH_PAGE) {
    FLASH->CR = FLASH_CR_PER;
    FLASH->AR = APP_BASE + off;
    FLASH->CR = FLASH_CR_PER | FLASH_CR_STRT;
    while (FLASH->SR & FLASH_SR_BSY) IWDG->KR = 0xAAAA;
    FLASH->CR = FLASH_CR_PG;
    for (uint32_t i = off / 2; i < (off + FLASH_PAGE) / 2 && i < (size + 1) / 2; i++) {
      dst[i] = s[i];
      while (FLASH->SR & FLASH_SR_BSY) {}
    }
    FLASH->CR = 0;
  }
  FLASH->CR = FLASH_CR_LOCK;
  __DSB();
  SCB->AIRCR = (0x5FAu << SCB_AIRCR_VECTKEY_Pos) | (SCB->AIRCR & SCB_AIRCR_PRIGROUP_Msk) | SCB_AIRCR_SYSRESETREQ_Msk;
  __DSB();
  for (;;) {}
}

void fw_install(void)
{
  // Everything else stops: no interrupt may run flash code while APP1 is rewritten.
  __disable_irq();
  RCC->CR |= RCC_CR_HSION;
  while (!(RCC->CR & RCC_CR_HSIRDY)) {}
  // Call through a pointer: a plain BL can't reach RAM from flash.
  void (*volatile copy)(uint32_t, uint32_t) = fw_copy_and_reset;
  copy(stage_base(), stage_size);
  for (;;) {}
}
