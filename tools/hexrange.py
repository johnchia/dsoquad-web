#!/usr/bin/env python3
"""Print the address range of an Intel HEX file and refuse images that touch protected flash.

Allowed APP area on the DSO Quad: 0x0800C000 up to (not including) the persistent store page at
0x0802B800 (firmware/app/src/store.c), which sits just below the FPGA image at 0x0802C000.
Everything below (DFU bootloader, SYS) and above (store, FPGA bitstream, logo) is off limits.
"""
import sys

APP_LO, APP_HI = 0x0800C000, 0x0802B800

def ranges(path):
    base, lo, hi = 0, None, 0
    for line in open(path):
        line = line.strip()
        if not line.startswith(':'):
            continue
        n, addr, typ = int(line[1:3], 16), int(line[3:7], 16), int(line[7:9], 16)
        if typ == 4:
            base = int(line[9:13], 16) << 16
        elif typ == 2:
            base = int(line[9:13], 16) << 4
        elif typ == 0:
            a = base + addr
            lo = a if lo is None else min(lo, a)
            hi = max(hi, a + n)
    return lo, hi

if __name__ == '__main__':
    ok = True
    for path in sys.argv[1:]:
        lo, hi = ranges(path)
        inside = lo is not None and APP_LO <= lo and hi <= APP_HI
        print(f'{path}: 0x{lo:08X}-0x{hi - 1:08X} ({(hi - lo) / 1024:.1f} KB) {"OK" if inside else "OUTSIDE APP AREA"}')
        ok &= inside
    sys.exit(0 if ok else 1)
