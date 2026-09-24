/* Web-control firmware in APP1. Hard 64 KB limit: APP3 (fallback scope) starts at 0x0801C000. */
MEMORY
{
  rom (rx)  : ORIGIN = 0x0800C000, LENGTH = 64K
  ram (rwx) : ORIGIN = 0x20003000, LENGTH = 36K   /* SYS owns 0x20000000-0x20002FFF */
}

_estack = ORIGIN(ram) + LENGTH(ram);
_min_stack = 0x1000;

SECTIONS
{
  /* SYS jump table: addresses only, never loaded. */
  .bios 0x08004200 (NOLOAD) : { *BIOS.o(.text) }

  .isr_vector : { KEEP(*(.isr_vector)) } > rom

  .text : {
    *(.text*)
    *(.rodata*)
    . = ALIGN(4);
  } > rom

  .ARM.exidx : { *(.ARM.exidx*) } > rom

  _sidata = LOADADDR(.data);
  .data : {
    _sdata = .;
    *(.data*)
    . = ALIGN(4);
    _edata = .;
  } > ram AT > rom

  .bss (NOLOAD) : {
    _sbss = .;
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
  } > ram

  PROVIDE(end = _ebss);
  ASSERT(_ebss + _min_stack <= _estack, "RAM overflow: less than 4 KB left for the stack")
}
