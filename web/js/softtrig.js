// Software edge trigger, for traces the FPGA can't trigger on (math). Pure functions (tested
// under node).

/**
 * Finds the edge of `x` crossing `level` nearest sample index `near`, within [from, to].
 * rising: true for a rising edge, false for falling. hyst: the signal must first be at least
 * this far on the other side of the level (rejects noise riding on the level).
 * Returns the fractional sample index of the crossing (linear between samples), or -1.
 */
export function findEdge(x, { rising, level, hyst, from = 1, to = x.length - 1, near = from }) {
  const s = rising ? 1 : -1, lvl = s * level;   // a falling edge is a rising edge of −x
  from = Math.max(1, Math.ceil(from));
  to = Math.min(x.length - 1, Math.floor(to));
  let armed = false, best = -1;
  // Arming needs samples before the window: start from the record's beginning.
  for (let i = 0; i <= to; i++) {
    const v = s * x[i];
    if (v < lvl - hyst) { armed = true; continue; }
    if (!armed || v < lvl) continue;
    armed = false;
    if (i < from) continue;
    const p = s * x[i - 1];   // below the level: x[i] is the first sample at or above it
    const at = i - 1 + (lvl - p) / (v - p);
    if (best < 0 || Math.abs(at - near) < Math.abs(best - near)) best = at;
    else if (at > near) break;   // edges only get further away from here on
  }
  return best;
}
