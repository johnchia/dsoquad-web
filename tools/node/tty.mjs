// Node transport for the web modules' Device on Linux: the CDC tty in raw mode (opening it
// raises DTR, which the firmware needs to stream). For hardware scripts; the page uses Web Serial.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The DSO's tty, found by USB ID (1209:0001) in sysfs; a stale ttyACM node may linger. */
export function findTty() {
  for (const name of fs.readdirSync('/sys/class/tty').filter((n) => n.startsWith('ttyACM'))) {
    try {
      const dev = path.dirname(fs.realpathSync(`/sys/class/tty/${name}/device`));   // the USB device above the interface
      const id = (f) => fs.readFileSync(`${dev}/${f}`, 'utf8').trim();
      if (id('idVendor') === '1209' && id('idProduct') === '0001') return `/dev/${name}`;
    } catch { /* not a USB device, or gone */ }
  }
  throw new Error('No DSO Quad serial port found');
}

export class TtyTransport {
  constructor(path = findTty()) { this.path = path; this.label = path; this.onbytes = null; this.ondisconnect = null; }

  async open() {
    execFileSync('stty', ['-F', this.path, 'raw', '-echo', '115200']);
    this.fd = fs.openSync(this.path, 'r+');
    this.rs = fs.createReadStream(null, { fd: this.fd, autoClose: false, highWaterMark: 1 << 16 });
    this.rs.on('data', (b) => this.onbytes?.(new Uint8Array(b.buffer, b.byteOffset, b.length)));
    this.rs.on('error', (e) => this.ondisconnect?.(e.message));
  }

  write(bytes) {
    return new Promise((resolve, reject) => fs.write(this.fd, bytes, (e) => (e ? reject(e) : resolve())));
  }

  async close() { this.rs.destroy(); fs.closeSync(this.fd); }
}

/** A Device on the DSO's tty, ready to use: HELLO until it answers (the first request after
 * opening can go unanswered while the device notices the new DTR state). */
export async function openDevice(Device, path) {
  const dev = new Device(new TtyTransport(path));
  await dev.open();
  for (let i = 0; ; i++) {
    try {
      await dev.request(0x01, new Uint8Array(0), 500);   // HELLO
      return dev;
    } catch (e) {
      if (i >= 4) { await dev.close(); throw e; }
    }
  }
}
