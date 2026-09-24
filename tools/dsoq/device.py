"""Async client for the DSO Quad web-control firmware."""
import asyncio
import glob
import struct

import serial_asyncio_fast

from protocol import (ACK, ACK_NAMES, FRAME, GET_STATE, GET_TABLES, HELLO, INFO, LOG, PARAM_SET, PING,
                      PONG, REBOOT, REG_GET, REG_SET, REG_VALUE, SET_ACQ, SET_CHANNEL, SET_GEN,
                      SET_SYSTEM, SET_TIMEBASE, SET_TRIGGER, STATE, TABLE, Frame, State, decode,
                      encode, parse_table)


def find_port():
    ports = sorted(glob.glob('/dev/serial/by-id/*DSO_Quad*'))
    if not ports:
        raise SystemExit('no DSO Quad serial port found')
    return ports[0]


class DeviceError(Exception):
    pass


class Device:
    """One connection. Replies are matched to requests by seq; frames go to a queue."""

    def __init__(self):
        self.reader = self.writer = None
        self.frames = asyncio.Queue(maxsize=8)
        self.bad_frames = 0
        self._seq = 0
        self._pending = {}      # seq -> (future, collected messages)
        self._task = None
        self.raw_log = None     # file object: every byte received is appended (for `record`)

    async def open(self, port=None):
        self.reader, self.writer = await serial_asyncio_fast.open_serial_connection(
            url=port or find_port(), baudrate=115200)
        self._task = asyncio.create_task(self._read_loop())
        return self

    async def close(self):
        if self._task:
            self._task.cancel()
        if self.writer:
            self.writer.close()

    # ------------------------------------------------------------------ transport

    async def _read_loop(self):
        while True:
            chunk = await self.reader.readuntil(b'\x00')
            if self.raw_log:
                self.raw_log.write(chunk)
            if len(chunk) <= 1:
                continue
            try:
                mtype, seq, body = decode(chunk[:-1])
            except ValueError:
                self.bad_frames += 1
                continue
            if mtype == FRAME:
                if self.frames.full():
                    self.frames.get_nowait()  # drop the oldest; keep up with the device
                self.frames.put_nowait(Frame.parse(body))
            elif mtype == LOG:
                print('device:', body.decode(errors='replace'))
            elif seq in self._pending:
                fut, msgs = self._pending[seq]
                msgs.append((mtype, body))
                if mtype != TABLE and not fut.done():  # TABLEs precede the final ACK
                    fut.set_result(msgs)

    async def request(self, mtype, body=b'', timeout=2.0):
        self._seq = (self._seq % 255) + 1
        seq = self._seq
        fut = asyncio.get_running_loop().create_future()
        self._pending[seq] = (fut, [])
        self.writer.write(encode(mtype, seq, body))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            del self._pending[seq]

    async def command(self, mtype, body=b''):
        msgs = await self.request(mtype, body)
        mt, reply = msgs[-1]
        if mt != ACK:
            raise DeviceError(f'expected ACK, got {mt:#x}')
        if reply[0]:
            raise DeviceError(f'{ACK_NAMES[reply[0]] if reply[0] < len(ACK_NAMES) else reply[0]}')
        return msgs[:-1]

    # ------------------------------------------------------------------ API

    async def hello(self):
        (mt, b), = await self.request(HELLO)
        assert mt == INFO
        proto, serial = struct.unpack_from('<HI', b)
        return {'proto': proto, 'serial': f'{serial:08X}', 'fw': b[6:].split(b'\0')[0].decode()}

    async def ping(self, data=b'ping'):
        (mt, b), = await self.request(PING, data)
        return mt == PONG and b == data

    async def state(self):
        (mt, b), = await self.request(GET_STATE)
        assert mt == STATE
        return State.parse(b)

    async def tables(self):
        return dict(parse_table(b) for mt, b in await self.command(GET_TABLES) if mt == TABLE)

    async def set_channel(self, ch, range_, coupling, offset):
        await self.command(SET_CHANNEL, bytes([ch, range_, coupling, offset]))

    async def set_rate(self, hz):
        await self.command(SET_TIMEBASE, struct.pack('<I', int(hz)))

    async def set_trigger(self, source, kind, level, width=0):
        await self.command(SET_TRIGGER, struct.pack('<BBBH', source, kind, level, width))

    async def set_acq(self, mode, auto_ms=100):
        await self.command(SET_ACQ, struct.pack('<BH', mode, auto_ms))

    async def set_gen(self, mode, freq_hz=1000, duty=50):
        await self.command(SET_GEN, struct.pack('<BIB', mode, int(freq_hz), duty))

    async def set_system(self, backlight=255, beep=255):
        await self.command(SET_SYSTEM, bytes([backlight, beep]))

    async def reg_set(self, obj, value):
        await self.command(REG_SET, struct.pack('<BI', obj, value))

    async def reg_get(self, kind):
        (mt, b), = await self.request(REG_GET, bytes([kind]))
        assert mt == REG_VALUE
        return struct.unpack('<BI', b)[1]

    async def param_set(self, addr, value):
        await self.command(PARAM_SET, bytes([addr, value]))

    async def reboot(self, to_fallback=False):
        await self.command(REBOOT, bytes([1 if to_fallback else 0]))

    async def next_frame(self, timeout=5.0):
        return await asyncio.wait_for(self.frames.get(), timeout)
