"""DSO Quad reference client.

    python3 tools/dsoq info
    python3 tools/dsoq tables
    python3 tools/dsoq capture --gen 1000 --rate 100000 --png capture.png
    python3 tools/dsoq bench --seconds 5
    python3 tools/dsoq reg get 11
"""
import argparse
import asyncio
import csv
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from device import Device  # noqa: E402
from protocol import (ACQ_AUTO, ACQ_NORMAL, ACQ_SINGLE, ACQ_STOP, ADC_ZERO, CODES_PER_DIV,  # noqa: E402
                      TRIG_KINDS)

MODES = {'auto': ACQ_AUTO, 'normal': ACQ_NORMAL, 'single': ACQ_SINGLE}


def stats(codes, rate, offset):
    lo, hi = min(codes), max(codes)
    mid = (lo + hi) / 2
    rising = [i for i in range(1, len(codes)) if codes[i - 1] < mid <= codes[i]]
    freq = (len(rising) - 1) * rate / (rising[-1] - rising[0]) if len(rising) > 1 else 0.0
    return {'min': lo, 'max': hi, 'pp_div': (hi - lo) / CODES_PER_DIV,
            'mean_div': (sum(codes) / len(codes) - offset) / CODES_PER_DIV, 'freq': freq}


def fmt_hz(f):
    for unit, k in (('MHz', 1e6), ('kHz', 1e3)):
        if f >= k:
            return f'{f / k:.4g} {unit}'
    return f'{f:.4g} Hz'


async def cmd_info(dev, a):
    print(await dev.hello())
    print(await dev.state())


async def cmd_tables(dev, a):
    t = await dev.tables()
    print('global:', t[0])
    print('\nranges (id 1):')
    for i, r in enumerate(t[1]):
        print(f'  {i:2d} {r["str"]:8s} scale={r["scale"]:<8d} KA1={r["KA1"]:<5d} KA2={r["KA2"]:<5d} KB1={r["KB1"]:<5d} KB2={r["KB2"]}')
    print('\ntimebases (id 2):')
    for i, r in enumerate(t[2]):
        rate = 72e6 / ((r['psc'] + 1) * (r['arr'] + 1))
        print(f'  {i:2d} {r["str"]:8s} psc={r["psc"]:<6d} arr={r["arr"]:<6d} kp={r["kp"]:<5d} scale={r["scale"]:<10d} -> {fmt_hz(rate)}')
    print('\ntriggers (id 3):')
    for i, r in enumerate(t[3]):
        print(f'  {i:2d} {r["str"]:8s} ch={r["chx"]} cmd={r["cmd"]:#04x}')


async def configure(dev, a):
    if a.gen is not None:
        await dev.set_gen(1 if a.gen > 0 else 0, a.gen or 1000, a.duty)
    await dev.set_rate(a.rate)
    await dev.set_channel(0, a.range_a, a.ac, a.offset_a)
    await dev.set_channel(1, a.range_b, a.ac, a.offset_b)
    await dev.set_trigger(a.source, TRIG_KINDS.index(a.edge), a.level)


async def cmd_capture(dev, a):
    await configure(dev, a)
    st = await dev.state()
    print(f'rate requested {fmt_hz(st.rate_req)}, actual {fmt_hz(st.rate_actual)} (psc {st.psc}, arr {st.arr})')
    while not dev.frames.empty():
        dev.frames.get_nowait()
    await dev.set_acq(MODES[a.mode], a.auto_ms)
    frames = []
    try:
        for _ in range(a.count):
            frames.append(await dev.next_frame(timeout=a.timeout))
    finally:
        await dev.set_acq(ACQ_STOP)
    for f in frames:
        sa = stats(f.a, f.rate, f.ch[0].offset)
        sb = stats(f.b, f.rate, f.ch[1].offset)
        print(f'frame {f.frame_no}: {"triggered" if f.triggered else "AUTO"}, {len(f.a)} samples @ {fmt_hz(f.rate)}')
        for name, s in (('A', sa), ('B', sb)):
            print(f'  {name}: codes {s["min"]}..{s["max"]}  p-p {s["pp_div"]:.2f} div  mean {s["mean_div"]:+.2f} div  freq {fmt_hz(s["freq"])}')
    f = frames[-1]
    if a.csv:
        with open(a.csv, 'w', newline='') as fh:
            w = csv.writer(fh)
            w.writerow(['t_s', 'a_code', 'b_code', 'c', 'd'])
            for i in range(len(f.a)):
                w.writerow([(i - f.pretrigger) / f.rate, f.a[i], f.b[i], f.cd[i] & 1, f.cd[i] >> 1 & 1])
        print('wrote', a.csv)
    if a.png or a.show:
        plot(f, a.png, a.show, await dev.tables())


def plot(f, png, show, tables):
    import matplotlib
    if not show:
        matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    t = [(i - f.pretrigger) / f.rate * 1e3 for i in range(len(f.a))]
    fig, ax = plt.subplots(figsize=(11, 5))
    for name, codes, ch, color in (('A', f.a, f.ch[0], 'tab:orange'), ('B', f.b, f.ch[1], 'tab:cyan')):
        vdiv = tables[1][ch.range]['str']
        ax.plot(t, [(c - ch.offset) / CODES_PER_DIV for c in codes], color=color, lw=0.8,
                label=f'CH {name} ({vdiv}/div, {"AC" if ch.coupling else "DC"})')
    ax.axvline(0, color='gray', ls=':', lw=0.8)
    ax.axhline((f.trig_level - f.ch[f.trig_source].offset) / CODES_PER_DIV if f.trig_source < 2 else 0,
               color='gray', ls='--', lw=0.6)
    ax.set_xlabel('time from trigger (ms)')
    ax.set_ylabel('divisions from channel zero')
    ax.set_title(f'frame {f.frame_no} @ {fmt_hz(f.rate)} ({"triggered" if f.triggered else "auto"})')
    ax.grid(alpha=0.3)
    ax.legend(loc='upper right')
    fig.tight_layout()
    if png:
        fig.savefig(png, dpi=110)
        print('wrote', png)
    if show:
        plt.show()


async def cmd_bench(dev, a):
    await configure(dev, a)
    await dev.set_acq(ACQ_AUTO, a.auto_ms)
    n, t0 = 0, time.time()
    try:
        while time.time() - t0 < a.seconds:
            await dev.next_frame(timeout=a.timeout)
            n += 1
    finally:
        await dev.set_acq(ACQ_STOP)
    dt = time.time() - t0
    print(f'{n} frames in {dt:.1f} s = {n / dt:.1f} frames/s ({n * 4096 * 3 / dt / 1024:.0f} KB/s of samples); '
          f'bad frames {dev.bad_frames}')


async def cmd_gen(dev, a):
    await dev.set_gen(1 if a.freq > 0 else 0, a.freq or 1000, a.duty)
    print(await dev.state())


async def cmd_reg(dev, a):
    if a.op == 'get':
        v = await dev.reg_get(a.id)
        print(f'__Get({a.id}) = {v} ({v:#x})')
    elif a.op == 'set':
        await dev.reg_set(a.id, a.value)
    else:
        await dev.param_set(a.id, a.value)


async def cmd_reboot(dev, a):
    await dev.reboot(a.fallback)


def main():
    ap = argparse.ArgumentParser(prog='dsoq')
    ap.add_argument('--port')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('info')
    sub.add_parser('tables')

    def acq_args(p):
        p.add_argument('--rate', type=float, default=100_000, help='sample rate, Hz')
        p.add_argument('--range-a', type=int, default=5)
        p.add_argument('--range-b', type=int, default=5)
        p.add_argument('--offset-a', type=int, default=ADC_ZERO + 100, help='channel A zero, ADC code')
        p.add_argument('--offset-b', type=int, default=ADC_ZERO + 50)
        p.add_argument('--ac', type=int, default=0, choices=(0, 1))
        p.add_argument('--source', type=int, default=0, help='trigger source 0 A, 1 B, 2 C, 3 D')
        p.add_argument('--edge', default='rising', choices=TRIG_KINDS)
        p.add_argument('--level', type=int, default=ADC_ZERO + 112, help='trigger level, ADC code')
        p.add_argument('--mode', default='auto', choices=MODES)
        p.add_argument('--auto-ms', type=int, default=200)
        p.add_argument('--timeout', type=float, default=5.0)
        p.add_argument('--gen', type=float, help='also drive the square-wave output at this frequency (0 = off)')
        p.add_argument('--duty', type=int, default=50)

    c = sub.add_parser('capture')
    acq_args(c)
    c.add_argument('--count', type=int, default=1)
    c.add_argument('--png')
    c.add_argument('--csv')
    c.add_argument('--show', action='store_true')
    b = sub.add_parser('bench')
    acq_args(b)
    b.add_argument('--seconds', type=float, default=5)
    g = sub.add_parser('gen')
    g.add_argument('freq', type=float, help='Hz, 0 = off')
    g.add_argument('--duty', type=int, default=50)
    r = sub.add_parser('reg')
    r.add_argument('op', choices=('get', 'set', 'param'))
    r.add_argument('id', type=int)
    r.add_argument('value', type=int, nargs='?', default=0)
    rb = sub.add_parser('reboot')
    rb.add_argument('--fallback', action='store_true')
    a = ap.parse_args()

    async def run():
        dev = await Device().open(a.port)
        try:
            await globals()[f'cmd_{a.cmd}'](dev, a)
        finally:
            await dev.close()

    asyncio.run(run())


if __name__ == '__main__':
    main()
