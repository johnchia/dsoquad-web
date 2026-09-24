// Node transport for the web modules' Device on Linux: the CDC tty in raw mode (opening it
// raises DTR, which the firmware needs to stream). For hardware scripts; the page uses Web Serial.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export class TtyTransport {
  constructor(path = '/dev/ttyACM0') { this.path = path; this.label = path; this.onbytes = null; this.ondisconnect = null; }

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
