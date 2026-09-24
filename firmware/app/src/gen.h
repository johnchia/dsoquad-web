// Wave generator (docs/protocol.md SET_GEN / SET_WAVE).
#pragma once
#include <stddef.h>
#include <stdint.h>

enum { GEN_OFF = 0, GEN_SQUARE = 1, GEN_ANALOG = 2 };

#define GEN_WAVE_MAX     512       // DAC table entries
#define GEN_DAC_MAX_RATE 2000000u  // DAC updates per second

// Timer dividers in use (square: TIM4; analog: TIM7, per table entry). Reported in STATE.
extern uint16_t gen_psc, gen_arr;

// Replaces the DAC table: n bytes of little-endian u16 samples, 0..4095. Returns 0 or -1.
int gen_set_wave(const uint8_t *b, size_t n);
uint16_t gen_wave_len(void);

// mode GEN_OFF / GEN_SQUARE (freq, duty) / GEN_ANALOG (freq = table repetitions per second).
int gen_set(uint8_t mode, uint32_t freq_hz, uint8_t duty);
