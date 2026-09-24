// Escape routes back to the standalone scope in APP3 (see PLAN.md §3.7).
#pragma once
#include <stdint.h>

// Called first thing after reset, before .data/.bss are set up. Jumps to APP3 and never
// returns if an exit was requested or the last boots died by watchdog.
void escape_early_check(void);

void escape_watchdog_start(void);
void escape_watchdog_kick(void);

// Mark this boot healthy: clears the consecutive watchdog-reset counter.
void escape_boot_ok(void);

// Request APP3 on the next boot and reset. Never returns.
void escape_to_fallback(void) __attribute__((noreturn));

// Plain reset back into this firmware. Never returns.
void escape_reboot(void) __attribute__((noreturn));

uint32_t escape_watchdog_resets(void);

// An APP with a plausible vector table sits in APP3 (e.g. a Community Edition build).
int escape_fallback_present(void);
