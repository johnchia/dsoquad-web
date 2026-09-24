#!/usr/bin/env bash
# Flash an Intel HEX APP image to the DSO Quad through its DFU disk.
# Put the DSO in DFU mode first: power off, hold the first button (>||), power on.
#
#   tools/dfu-flash.sh firmware/fallback/build/slot3/APP_G251_3.hex
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
hex="${1:?usage: dfu-flash.sh <image.hex>}"

# Refuse images that would touch the bootloader, SYS or FPGA areas.
"$here/hexrange.py" "$hex"

[ -x "$here/bin/dfuload" ] || g++ -O2 -w -o "$here/bin/dfuload" "$here/dfuload/dfuload.cpp"

find_dev() {
  for d in /sys/block/sd*; do
    [ -e "$d" ] || continue
    local dev="/dev/$(basename "$d")"
    if udevadm info -q property -n "$dev" 2>/dev/null | grep -q '^ID_VENDOR_ID=0483$' &&
       udevadm info -q property -n "$dev" 2>/dev/null | grep -q '^ID_MODEL_ID=5720$'; then
      echo "$dev"; return 0
    fi
  done
  return 1
}

dev="$(find_dev)" || { echo "DSO Quad disk not found. Is it plugged in and in DFU mode?" >&2; exit 1; }
label="$(mdir -i "$dev" :: 2>/dev/null | sed -n 's/^ Volume in drive : is //p' || true)"
echo "Device: $dev  volume: ${label:-?}"
if mdir -i "$dev" -b :: 2>/dev/null | grep -qi '\.WPT$'; then
  echo "This is the normal-mode disk (settings file present), not DFU. Power on while holding >|| ." >&2
  exit 1
fi

# Normal FAT copy (as an OS would do), uppercase 8.3 name, then flush to the device.
# (gabonator's raw dfuload is kept in tools/dfuload for comparison: DFU_METHOD=dfuload.)
if [ "${DFU_METHOD:-mtools}" = dfuload ]; then
  "$here/bin/dfuload" "$dev" cp "$hex"
else
  mcopy -o -i "$dev" "$hex" ::APP.HEX
  sync "$dev" 2>/dev/null || sync
  echo "Copied $(stat -c %s "$hex") bytes as APP.HEX"
fi

echo "Waiting for the DSO to program the image..."
seen_gone=0
for _ in $(seq 1 60); do
  sleep 1
  dev="$(find_dev)" || { seen_gone=1; continue; }
  # Bypass the page cache: the DFU rewrites its directory behind the kernel's back.
  snap="$(mktemp)"
  dd if="$dev" of="$snap" iflag=direct bs=4096 count=16 status=none 2>/dev/null || true
  listing="$(mdir -i "$snap" -b :: 2>/dev/null || true)"
  rm -f "$snap"
  if grep -qi '\.RDY$' <<<"$listing"; then echo "Programmed OK (.RDY). Power-cycle the DSO."; exit 0; fi
  if grep -qi '\.NOT$' <<<"$listing"; then echo "DSO rejected the image (.NOT)." >&2; exit 2; fi
  if grep -qi '\.ERR$' <<<"$listing"; then
    echo "DFU reported .ERR. On this unit (DFU 3.10) that has also happened with successful programming;"
    echo "power-cycle and check the build ID with 'python3 tools/dsoq info'."
    exit 4
  fi
done
if [ "$seen_gone" = 1 ]; then
  echo "Image written; the DSO re-enumerated to report the result but didn't come back"
  echo "(usual with VM USB passthrough). Power-cycle it and check that the new firmware runs."
  exit 0
fi
echo "No .RDY/.NOT seen after 60 s; check the DSO screen." >&2
exit 3
