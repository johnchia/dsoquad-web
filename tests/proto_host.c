// Host harness for firmware/app/src/proto.c.
//   proto_host enc <type> <seq> <hexbody>   -> encoded frame on stdout (binary)
//   proto_host dec                          -> reads frames on stdin, prints "type seq hexbody" or "bad"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "proto.h"

static void out(const uint8_t *p, size_t n) { fwrite(p, 1, n, stdout); }

int main(int argc, char **argv)
{
  if (argc >= 4 && !strcmp(argv[1], "enc")) {
    struct proto_tx tx;
    proto_tx_begin(&tx, out, (uint8_t)strtoul(argv[2], 0, 0), (uint8_t)strtoul(argv[3], 0, 0));
    const char *h = argc > 4 ? argv[4] : "";
    for (size_t i = 0; h[i] && h[i + 1]; i += 2) {
      char b[3] = { h[i], h[i + 1], 0 };
      proto_tx_u8(&tx, (uint8_t)strtoul(b, 0, 16));
    }
    proto_tx_end(&tx);
    return 0;
  }
  if (argc >= 2 && !strcmp(argv[1], "dec")) {
    struct proto_rx rx = { 0 };
    int c;
    while ((c = getchar()) != EOF) {
      const uint8_t *m;
      size_t n;
      int r = proto_rx_byte(&rx, (uint8_t)c, &m, &n);
      if (r > 0) {
        printf("%u %u ", m[0], m[1]);
        for (size_t i = 2; i < n; i++) printf("%02x", m[i]);
        printf("\n");
      } else if (r < 0) {
        printf("bad\n");
      }
    }
    return 0;
  }
  return 2;
}
