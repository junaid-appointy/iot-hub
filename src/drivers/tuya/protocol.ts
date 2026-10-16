import crypto from 'crypto';
import { DeviceError } from '../../core/types';
import { tcpRequest } from '../../util/net';

/**
 * Tuya local protocol (v3.1 broadcasts, v3.3 control) on TCP 6668.
 *
 * Packet: 000055AA | seq u32 | cmd u32 | len u32 | [retcode u32 from device] | payload | crc32 u32 | 0000AA55
 * v3.3 payloads are AES-128-ECB encrypted with the device's 16-char local key.
 */
const PREFIX = 0x000055aa;
const SUFFIX = 0x0000aa55;
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
const PORT = 6668;

export const CMD = { CONTROL: 7, STATUS: 8, DP_QUERY: 10 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encrypt = (key: Buffer, data: Buffer) => {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(data), c.final()]);
};

const decrypt = (key: Buffer, data: Buffer) => {
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(data), d.final()]);
};

export interface BroadcastInfo {
  ip: string;
  gwId: string;
  version: string;
  productKey?: string;
  encrypt?: boolean;
}

/** Devices announce themselves on UDP 6666 (plain) and 6667 (AES with a fixed key). */
export function decodeBroadcast(msg: Buffer): BroadcastInfo | undefined {
  if (msg.length < 28 || msg.readUInt32BE(0) !== PREFIX) return undefined;
  const len = msg.readUInt32BE(12);
  const body = msg.subarray(16, 16 + len - 8);
  const candidates = [body, body.subarray(4)];
  for (const c of candidates) {
    const text = c.toString('utf8');
    const start = text.indexOf('{');
    if (start >= 0 && text.lastIndexOf('}') > start) {
      try {
        return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
      } catch {}
    }
    if (c.length % 16 === 0) {
      try {
        return JSON.parse(decrypt(UDP_KEY, c).toString('utf8'));
      } catch {}
    }
  }
  return undefined;
}

function encode(seq: number, cmd: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(PREFIX, 0);
  header.writeUInt32BE(seq, 4);
  header.writeUInt32BE(cmd, 8);
  header.writeUInt32BE(payload.length + 8, 12);
  const body = Buffer.concat([header, payload]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32BE(crc32(body), 0);
  tail.writeUInt32BE(SUFFIX, 4);
  return Buffer.concat([body, tail]);
}

interface Message {
  cmd: number;
  payload: Buffer;
}

function decodeAll(buf: Buffer): Message[] {
  const out: Message[] = [];
  let off = 0;
  while (off + 24 <= buf.length) {
    if (buf.readUInt32BE(off) !== PREFIX) {
      off++;
      continue;
    }
    const len = buf.readUInt32BE(off + 12);
    if (off + 16 + len > buf.length) break;
    const cmd = buf.readUInt32BE(off + 8);
    // Device → client packets carry a 4-byte return code before the payload.
    out.push({ cmd, payload: buf.subarray(off + 20, off + 16 + len - 8) });
    off += 16 + len;
  }
  return out;
}

export class TuyaLocal {
  private key: Buffer;
  private seq = 1;

  constructor(
    private ip: string,
    private devId: string,
    localKey: string,
    private version = '3.3'
  ) {
    if (version !== '3.3') throw new DeviceError(`Tuya protocol ${version} isn't supported for local control yet`);
    if (Buffer.byteLength(localKey) !== 16) throw new DeviceError('Tuya local key must be 16 characters');
    this.key = Buffer.from(localKey, 'utf8');
  }

  private async exchange(cmd: number, json: object, withVersionHeader: boolean): Promise<any> {
    let payload = encrypt(this.key, Buffer.from(JSON.stringify(json)));
    if (withVersionHeader) payload = Buffer.concat([Buffer.from(this.version), Buffer.alloc(12), payload]);
    const wantCmds = cmd === CMD.CONTROL ? [CMD.STATUS] : [cmd];
    let raw: Buffer;
    try {
      raw = await tcpRequest(this.ip, PORT, encode(this.seq++, cmd, payload), (b) => decodeAll(b).some((m) => wantCmds.includes(m.cmd) && m.payload.length > 0), 4000);
    } catch (e: any) {
      // Devices silently drop packets they can't decrypt, and allow only one local client.
      if (/closed|Timed out|reset/i.test(e.message)) {
        throw new DeviceError(`Tuya device didn't answer (${e.message})`, 'Usually a wrong/changed local key (re-run: iot setup <device>), or the Smart Life app is holding the connection — close it.');
      }
      throw e;
    }
    for (const m of decodeAll(raw)) {
      if (!m.payload.length) continue;
      let p = m.payload;
      if (p.subarray(0, 3).toString() === this.version) p = p.subarray(15);
      let text: string;
      try {
        text = decrypt(this.key, p).toString('utf8');
      } catch {
        text = p.toString('utf8');
        if (/unvalid|format error/i.test(text)) throw new DeviceError(`Tuya device rejected the request: ${text}`);
        throw new DeviceError('Could not decrypt the Tuya response — the local key is wrong or has changed', 'Run: iot setup <device> to refresh the key');
      }
      return JSON.parse(text);
    }
    return {};
  }

  /** Current datapoints, e.g. { "20": true, "22": 1000 }. */
  async query(): Promise<Record<string, any>> {
    const t = String(Math.floor(Date.now() / 1000));
    try {
      const res = await this.exchange(CMD.DP_QUERY, { gwId: this.devId, devId: this.devId, uid: this.devId, t }, false);
      return res.dps ?? {};
    } catch (e: any) {
      // "device22" firmware rejects DP_QUERY; asking for specific dps via CONTROL works instead.
      if (!/unvalid/i.test(e.message)) throw e;
      const dps = Object.fromEntries(['1', '2', '3', '4', '5', '20', '21', '22', '23', '24'].map((k) => [k, null]));
      const res = await this.exchange(CMD.CONTROL, { devId: this.devId, uid: this.devId, t, dps }, true);
      return res.dps ?? {};
    }
  }

  async set(dps: Record<string, unknown>): Promise<void> {
    const t = String(Math.floor(Date.now() / 1000));
    await this.exchange(CMD.CONTROL, { devId: this.devId, uid: this.devId, t, dps }, true).catch((e) => {
      // Some devices apply the change but never send a STATUS back.
      if (!/Timed out/.test(e.message)) throw e;
    });
  }
}
