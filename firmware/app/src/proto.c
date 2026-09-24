#include "proto.h"

static uint16_t crc_table[256];

static void crc_init(void)
{
  for (int i = 0; i < 256; i++) {
    uint16_t c = (uint16_t)(i << 8);
    for (int b = 0; b < 8; b++) c = (c & 0x8000) ? (uint16_t)(c << 1 ^ 0x1021) : (uint16_t)(c << 1);
    crc_table[i] = c;
  }
}

uint16_t crc16_update(uint16_t crc, const uint8_t *p, size_t n)
{
  if (!crc_table[1]) crc_init();
  while (n--) crc = (uint16_t)(crc << 8 ^ crc_table[(crc >> 8 ^ *p++) & 0xFF]);
  return crc;
}

// Decode COBS in place. Returns the decoded length, or -1 if malformed.
static int cobs_decode(uint8_t *buf, size_t len)
{
  size_t in = 0, out = 0;
  while (in < len) {
    uint8_t code = buf[in++];
    if (code == 0 || in + code - 1 > len) return -1;
    for (int i = 1; i < code; i++) buf[out++] = buf[in++];
    if (code < 0xFF && in < len) buf[out++] = 0;
  }
  return (int)out;
}

int proto_rx_byte(struct proto_rx *rx, uint8_t byte, const uint8_t **msg, size_t *len)
{
  if (byte != 0) {
    if (rx->len < sizeof rx->buf) rx->buf[rx->len++] = byte;
    else rx->overflow = 1;
    return 0;
  }

  size_t n = rx->len;
  int overflow = rx->overflow;
  rx->len = 0;
  rx->overflow = 0;
  if (n == 0) return 0;  // empty frame: harmless resync
  if (overflow) return -1;

  int d = cobs_decode(rx->buf, n);
  if (d < 4) return -1;  // type + seq + crc at least
  uint16_t crc = (uint16_t)(rx->buf[d - 2] | rx->buf[d - 1] << 8);
  if (crc16_update(0xFFFF, rx->buf, (size_t)d - 2) != crc) return -1;
  *msg = rx->buf;
  *len = (size_t)d - 2;
  return 1;
}

static void tx_flush_block(struct proto_tx *tx)
{
  tx->block[0] = (uint8_t)(tx->n + 1);
  tx->sink(tx->block, (size_t)tx->n + 1);
  tx->n = 0;
}

static void tx_byte(struct proto_tx *tx, uint8_t b)
{
  if (b == 0) {
    tx_flush_block(tx);
    return;
  }
  tx->block[1 + tx->n++] = b;
  if (tx->n == 254) tx_flush_block(tx);
}

static void tx_raw(struct proto_tx *tx, const uint8_t *p, size_t n)
{
  while (n--) tx_byte(tx, *p++);
}

void proto_tx_begin(struct proto_tx *tx, proto_sink sink, uint8_t type, uint8_t seq)
{
  tx->sink = sink;
  tx->n = 0;
  tx->crc = 0xFFFF;
  proto_tx_u8(tx, type);
  proto_tx_u8(tx, seq);
}

void proto_tx_put(struct proto_tx *tx, const void *data, size_t n)
{
  tx->crc = crc16_update(tx->crc, data, n);
  tx_raw(tx, data, n);
}

void proto_tx_u8(struct proto_tx *tx, uint8_t v) { proto_tx_put(tx, &v, 1); }

void proto_tx_u16(struct proto_tx *tx, uint16_t v)
{
  uint8_t b[2] = { (uint8_t)v, (uint8_t)(v >> 8) };
  proto_tx_put(tx, b, 2);
}

void proto_tx_u32(struct proto_tx *tx, uint32_t v)
{
  uint8_t b[4] = { (uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24) };
  proto_tx_put(tx, b, 4);
}

void proto_tx_end(struct proto_tx *tx)
{
  uint8_t crc[2] = { (uint8_t)tx->crc, (uint8_t)(tx->crc >> 8) };
  tx_raw(tx, crc, 2);
  tx_flush_block(tx);  // always emit the final block (possibly just a 0x01 code)
  static const uint8_t delim = 0;
  tx->sink(&delim, 1);
}
