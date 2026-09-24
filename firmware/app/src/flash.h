// Internal flash programming (2 KB pages, 16-bit writes). Each call unlocks and relocks the
// flash controller; the CPU stalls on flash reads while a page erases (~20-40 ms).
#pragma once
#include <stddef.h>
#include <stdint.h>

#define FLASH_PAGE 2048u

int flash_erase(uint32_t addr);                                // 0, or -1 on a flash error
int flash_write(uint32_t addr, const uint8_t *data, size_t n); // pads an odd tail with 0xFF
