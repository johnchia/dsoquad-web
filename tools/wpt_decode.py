#!/usr/bin/env python3
"""Decode a DSO203 GCC Community Edition settings file (<SN>.WPT, 512 bytes) to JSON.

Layout follows Load_Param() in ref/dso203_gcc/App/src/Files.c.
Calibration per range i (10 ranges): Ka1/Kb1 = offset correction at low position (s8),
Ka2/Kb2 = gain correction (u16, 1024 = 1.0), Ka3/Kb3 = offset correction at high position (s8).
"""
import json, struct, sys

def s8(v): return v - 256 if v > 127 else v

def decode(buf):
    assert len(buf) == 512, len(buf)
    w = struct.unpack('<256H', buf)
    it = iter(w)
    first = next(it)
    version, current = first & 0xFF, first >> 8
    out = {'version': hex(version), 'checksum_ok': sum(buf) & 0xFF == 0, 'current_title': current}
    detail = []
    for _ in range(7):
        v = next(it); detail += [v & 0xFF, v >> 8]
    out['detail'] = detail
    out['title_values'] = [[next(it) for _ in range(4)] for _ in range(13)]
    out['meters'] = [{'item': (v := next(it)) & 0xFF, 'track': v >> 8} for _ in range(9)]
    cal = {'A': [], 'B': []}
    for i in range(10):
        v1, ka2, kb2, v3 = next(it), next(it), next(it), next(it)
        k1a, k1b, k3a, k3b = s8(v1 & 0xFF), s8(v1 >> 8), s8(v3 & 0xFF), s8(v3 >> 8)
        if version == 0x16:
            k1a, k1b, k3a, k3b = k1a - 50, k1b - 50, k3a - 50, k3b - 50
        cal['A'].append({'range': i, 'offset_low': k1a, 'gain': ka2, 'offset_high': k3a})
        cal['B'].append({'range': i, 'offset_low': k1b, 'gain': kb2, 'offset_high': k3b})
    out['calibration'] = cal
    out['v_trigger'] = {'A': next(it), 'B': next(it)}
    out['frame_mode'] = next(it)
    v = next(it); out['meter_flag'], out['update_meter'] = v & 0xFF, v >> 8
    v = next(it); out['trig_auto'], out['cal_flag'] = v & 0xFF, v >> 8
    out['offset_x'], out['offset_y'] = next(it), next(it)
    return out

if __name__ == '__main__':
    print(json.dumps(decode(open(sys.argv[1], 'rb').read()), indent=1))
