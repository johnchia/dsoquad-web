#!/usr/bin/env python3
"""M1 host test for the DSO Quad CDC firmware: ping, info, throughput both ways.

    tools/m1_test.py [/dev/ttyACM0] [--mb 1]
"""
import argparse, glob, os, select, sys, termios, time, tty


def open_port(path):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY)
    tty.setraw(fd)
    attrs = termios.tcgetattr(fd)
    attrs[2] |= termios.CLOCAL | termios.CREAD
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def read_until(fd, marker, timeout=2.0):
    buf, end = b'', time.time() + timeout
    while marker not in buf:
        left = end - time.time()
        if left <= 0 or not select.select([fd], [], [], left)[0]:
            raise TimeoutError(f'waiting for {marker!r}, got {buf!r}')
        buf += os.read(fd, 4096)
    return buf


def cmd(fd, line, marker=b'\n', timeout=2.0):
    os.write(fd, line.encode() + b'\n')
    return read_until(fd, marker, timeout)


def find_port():
    for p in sorted(glob.glob('/dev/serial/by-id/*DSO_Quad*')) or sorted(glob.glob('/dev/ttyACM*')):
        return p
    sys.exit('no DSO Quad serial port found')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('port', nargs='?')
    ap.add_argument('--mb', type=float, default=1.0, help='megabytes per throughput test')
    a = ap.parse_args()
    port = a.port or find_port()
    fd = open_port(port)
    print(f'port {port}')

    t = time.time()
    assert b'pong' in cmd(fd, 'ping'), 'no pong'
    print(f'ping ok ({(time.time() - t) * 1000:.1f} ms round trip)')

    os.write(fd, b'info\n')
    time.sleep(0.3)
    info = b''
    while select.select([fd], [], [], 0.2)[0]:
        info += os.read(fd, 4096)
    print(info.decode(errors='replace').rstrip().replace('\r', ''))

    n = int(a.mb * 1024 * 1024)
    os.write(fd, f'tx {n}\n'.encode())
    got, t0 = 0, time.time()
    expect = bytes(range(64))
    first = b''
    while got < n:
        if not select.select([fd], [], [], 3)[0]:
            sys.exit(f'tx stalled at {got}/{n} bytes')
        chunk = os.read(fd, 65536)
        if got < 4096:
            first += chunk
        got += len(chunk)
    dt = time.time() - t0
    ok = first[:len(expect) * 4] == expect * 4
    print(f'device->host: {n} bytes in {dt:.2f} s = {n / dt / 1024:.0f} KB/s  pattern {"ok" if ok else "BAD"}')

    os.write(fd, f'rx {n}\n'.encode())
    time.sleep(0.05)
    block, t0 = bytes(4096), time.time()
    for off in range(0, n, len(block)):
        os.write(fd, block[:min(len(block), n - off)])
    reply = read_until(fd, b'ms', timeout=30)
    dt = time.time() - t0
    print(f'host->device: {n} bytes in {dt:.2f} s = {n / dt / 1024:.0f} KB/s  ({reply.decode().strip()})')
    os.close(fd)


if __name__ == '__main__':
    main()
