// Persistent host data in one internal flash page (docs/protocol.md, STORE_READ/STORE_WRITE).
// The content is opaque to the firmware; the host defines it (calibration etc.).
#include "store.h"
#include "stm32f1xx.h"
#include "proto.h"
#include "escape.h"

// Last 2 KB page before the FPGA bitstream (0x0802C000): not part of any APP slot image
// (tools/hexrange.py refuses hex files that reach it) and never written by the DFU.
#define STORE_ADDR  0x0802B800u
#define STORE_PAGE  2048u
#define STORE_MAGIC 0x53515344u  // "DSQS"

struct store_hdr {
  uint32_t magic;
  uint16_t len;
  uint16_t crc;  // CRC-16/CCITT-FALSE of the data
};

_Static_assert(sizeof(struct store_hdr) + STORE_MAX <= STORE_PAGE, "store fits the page");

int store_read(const uint8_t **data)
{
  const struct store_hdr *h = (const struct store_hdr *)STORE_ADDR;
  const uint8_t *d = (const uint8_t *)(h + 1);
  if (h->magic != STORE_MAGIC || h->len > STORE_MAX || crc16_update(0xFFFF, d, h->len) != h->crc) return 0;
  *data = d;
  return h->len;
}

static int flash_wait(void)
{
  while (FLASH->SR & FLASH_SR_BSY) escape_watchdog_kick();
  uint32_t sr = FLASH->SR;
  FLASH->SR = FLASH_SR_EOP | FLASH_SR_PGERR | FLASH_SR_WRPRTERR;  // write 1 to clear
  return (sr & (FLASH_SR_PGERR | FLASH_SR_WRPRTERR)) ? -1 : 0;
}

static int program_u16(uint32_t addr, uint16_t v)
{
  *(volatile uint16_t *)addr = v;
  return flash_wait();
}

int store_write(const uint8_t *data, uint16_t len)
{
  if (len > STORE_MAX) return -1;
  RCC->CR |= RCC_CR_HSION;  // the flash programming interface runs from HSI
  while (!(RCC->CR & RCC_CR_HSIRDY)) {}

  FLASH->KEYR = 0x45670123u;
  FLASH->KEYR = 0xCDEF89ABu;
  int err = flash_wait();

  FLASH->CR |= FLASH_CR_PER;
  FLASH->AR = STORE_ADDR;
  FLASH->CR |= FLASH_CR_STRT;
  err |= flash_wait();
  FLASH->CR &= ~FLASH_CR_PER;

  if (!err && len) {
    struct store_hdr h = { STORE_MAGIC, len, crc16_update(0xFFFF, data, len) };
    FLASH->CR |= FLASH_CR_PG;
    const uint8_t *hp = (const uint8_t *)&h;
    uint32_t a = STORE_ADDR;
    for (unsigned i = 0; i < sizeof h && !err; i += 2, a += 2) err |= program_u16(a, (uint16_t)(hp[i] | hp[i + 1] << 8));
    for (unsigned i = 0; i < len && !err; i += 2, a += 2) {
      uint16_t v = (uint16_t)(data[i] | (i + 1 < len ? data[i + 1] : 0xFF) << 8);
      err |= program_u16(a, v);
    }
    FLASH->CR &= ~FLASH_CR_PG;
  }
  FLASH->CR |= FLASH_CR_LOCK;
  if (err) return -1;

  // Verify through the normal read path.
  const uint8_t *d;
  if (store_read(&d) != len && len) return -1;
  for (unsigned i = 0; i < len; i++) if (d[i] != data[i]) return -1;
  return 0;
}
