// Message framing for docs/protocol.md: COBS + CRC-16/CCITT-FALSE, 0x00 delimited.
// No hardware dependencies, so it also builds on the host for tests.
#pragma once
#include <stddef.h>
#include <stdint.h>

#define PROTO_MAX_RX 64  // largest decoded host message (type + seq + body + crc)

uint16_t crc16_update(uint16_t crc, const uint8_t *p, size_t n);

// Incoming side: feed raw bytes; returns 1 when a complete message with a valid CRC is in
// *msg / *len (type, seq, body; CRC stripped), -1 for a corrupt frame, 0 otherwise.
struct proto_rx {
  uint8_t buf[PROTO_MAX_RX + PROTO_MAX_RX / 254 + 2];
  size_t len;
  int overflow;
};
int proto_rx_byte(struct proto_rx *rx, uint8_t byte, const uint8_t **msg, size_t *len);

// Outgoing side: streaming COBS encoder. Bytes go to `sink`, which must accept them all.
typedef void (*proto_sink)(const uint8_t *p, size_t n);
struct proto_tx {
  proto_sink sink;
  uint8_t block[255];  // block[0] is the COBS code byte
  uint8_t n;           // data bytes in block
  uint16_t crc;
};
void proto_tx_begin(struct proto_tx *tx, proto_sink sink, uint8_t type, uint8_t seq);
void proto_tx_put(struct proto_tx *tx, const void *data, size_t n);
void proto_tx_u8(struct proto_tx *tx, uint8_t v);
void proto_tx_u16(struct proto_tx *tx, uint16_t v);
void proto_tx_u32(struct proto_tx *tx, uint32_t v);
void proto_tx_end(struct proto_tx *tx);

static inline uint16_t get_u16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static inline uint32_t get_u32(const uint8_t *p)
{
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
