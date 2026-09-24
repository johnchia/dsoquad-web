// Persistent host data in one internal flash page (docs/protocol.md, STORE_READ/STORE_WRITE).
// The content is opaque to the firmware; the host defines it (calibration etc.).
#include "store.h"
#include "stm32f1xx.h"
#include "proto.h"
#include "flash.h"

// Last 2 KB page before the FPGA bitstream (0x0802C000): not part of any APP slot image
// (tools/hexrange.py refuses hex files that reach it) and never written by the DFU.
#define STORE_ADDR  0x0802B800u
#define STORE_MAGIC 0x53515344u  // "DSQS"

struct store_hdr {
  uint32_t magic;
  uint16_t len;
  uint16_t crc;  // CRC-16/CCITT-FALSE of the data
};

_Static_assert(sizeof(struct store_hdr) + STORE_MAX <= FLASH_PAGE, "store fits the page");

int store_read(const uint8_t **data)
{
  const struct store_hdr *h = (const struct store_hdr *)STORE_ADDR;
  const uint8_t *d = (const uint8_t *)(h + 1);
  if (h->magic != STORE_MAGIC || h->len > STORE_MAX || crc16_update(0xFFFF, d, h->len) != h->crc) return 0;
  *data = d;
  return h->len;
}

int store_write(const uint8_t *data, uint16_t len)
{
  if (len > STORE_MAX) return -1;
  int err = flash_erase(STORE_ADDR);
  if (!err && len) {
    struct store_hdr h = { STORE_MAGIC, len, crc16_update(0xFFFF, data, len) };
    err = flash_write(STORE_ADDR, (const uint8_t *)&h, sizeof h);
    if (!err) err = flash_write(STORE_ADDR + sizeof h, data, len);
  }
  if (err) return -1;

  // Verify through the normal read path.
  const uint8_t *d;
  if (store_read(&d) != len && len) return -1;
  for (unsigned i = 0; i < len; i++) if (d[i] != data[i]) return -1;
  return 0;
}
