// Firmware update over USB (docs/protocol.md, FW_BEGIN/FW_DATA/FW_COMMIT): the new image is
// staged in the free flash above the running one, checked, then copied over APP1 by a routine
// running from RAM, and the device resets into it. DFU mode stays the recovery route.
#pragma once
#include <stddef.h>
#include <stdint.h>

#define APP_BASE  0x0800C000u
#define APP_LIMIT 0x0801C000u  // APP3 (the fallback scope) starts here

// Each returns 0 or a negative error: FW_ERR_*.
enum { FW_ERR_SIZE = -1, FW_ERR_VALUE = -2, FW_ERR_FLASH = -3 };

int fw_begin(uint32_t size, uint32_t crc);  // erases the staging area
int fw_data(uint32_t offset, const uint8_t *data, size_t n);
int fw_check(uint32_t size, uint32_t crc);  // the staged image is complete and plausible
void fw_install(void) __attribute__((noreturn));  // after a successful fw_check
uint32_t fw_room(void);                     // largest image that can be staged
