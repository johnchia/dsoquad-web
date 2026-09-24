// Persistent host data in internal flash: one opaque blob, CRC-checked.
#pragma once
#include <stdint.h>

#define STORE_MAX 1024

// Returns the stored length (0 if nothing valid is stored) and points *data at it.
int store_read(const uint8_t **data);

// Replaces the stored blob (len 0 erases it). Returns 0, or -1 on a flash error.
// Blocks for the page erase (~20-40 ms).
int store_write(const uint8_t *data, uint16_t len);
