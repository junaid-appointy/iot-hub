import crypto from 'crypto';
import { Command, Device, DeviceError, DeviceState, Discovered, DiscoveryContext, Driver } from '../core/types';
import { clamp, hsvToRgb, rgbToHsv } from '../util/color';
import { settleAll, udpCollect, udpRequest } from '../util/net';

/**
 * LIFX LAN protocol: little-endian binary packets on UDP 56700.
 * Header = frame (8) + frame address (16) + protocol header (12) = 36 bytes.
 */
const PORT = 56700;
const SOURCE = crypto.randomBytes(4).readUInt32LE() || 1;
const T = { GetService: 2, StateService: 3, GetColor: 101, SetColor: 102, LightState: 107, SetLightPower: 117, Ack: 45 };

let sequence = 0;

function packet(type: number, payload: Buffer = Buffer.alloc(0), mac?: string, opts: { ack?: boolean; res?: boolean } = {}) {
  const size = 36 + payload.length;
  const b = Buffer.alloc(size);
  b.writeUInt16LE(size, 0);
  b.writeUInt16LE(1024 | (1 << 12) | (mac ? 0 : 1 << 13), 2); // protocol | addressable | tagged
  b.writeUInt32LE(SOURCE, 4);
  if (mac) Buffer.from(mac.replace(/:/g, ''), 'hex').copy(b, 8);
  b.writeUInt8((opts.res ? 1 : 0) | (opts.ack ? 2 : 0), 22);
  sequence = (sequence + 1) & 255;
  b.writeUInt8(sequence, 23);
  b.writeUInt16LE(type, 32);
  payload.copy(b, 36);
  return { buf: b, seq: sequence };
}

const msgType = (b: Buffer) => (b.length >= 36 ? b.readUInt16LE(32) : -1);
const macOf = (b: Buffer) => b.subarray(8, 14).toString('hex');

async function request(ip: string, mac: string, type: number, payload: Buffer | undefined, expect: number) {
  const { buf, seq } = packet(type, payload, mac, { ack: expect === T.Ack, res: expect !== T.Ack });
  return udpRequest(ip, PORT, buf, {
    accept: (m) => msgType(m) === expect && m.readUInt32LE(4) === SOURCE && m[23] === seq,
  });
}

interface Hsbk {
  hue: number;
  sat: number;
  bri: number;
  kelvin: number;
  power: boolean;
  label: string;
}

async function getColor(ip: string, mac: string): Promise<Hsbk> {
  const m = await request(ip, mac, T.GetColor, undefined, T.LightState);
  return {
    hue: m.readUInt16LE(36),
    sat: m.readUInt16LE(38),
    bri: m.readUInt16LE(40),
    kelvin: m.readUInt16LE(42),
    power: m.readUInt16LE(46) > 0,
    label: m.subarray(48, 80).toString('utf8').replace(/\0+$/, ''),
  };
}

function toState(c: Hsbk): DeviceState {
  const s = c.sat / 65535;
  return {
    online: true,
    on: c.power,
    brightness: Math.round((c.bri / 65535) * 100),
    color: s > 0.05 ? hsvToRgb((c.hue / 65535) * 360, s, 1) : undefined,
    colorTemp: s <= 0.05 ? c.kelvin : undefined,
  };
}

async function setColor(device: Device, c: Pick<Hsbk, 'hue' | 'sat' | 'bri' | 'kelvin'>) {
  const p = Buffer.alloc(13);
  p.writeUInt16LE(Math.round(c.hue), 1);
  p.writeUInt16LE(Math.round(c.sat), 3);
  p.writeUInt16LE(Math.round(c.bri), 5);
  p.writeUInt16LE(Math.round(c.kelvin), 7);
  p.writeUInt32LE(300, 9);
  await request(device.address, device.config.mac, T.SetColor, p, T.Ack);
}

async function setPower(device: Device, on: boolean) {
  const p = Buffer.alloc(6);
  p.writeUInt16LE(on ? 65535 : 0, 0);
  p.writeUInt32LE(300, 2);
  await request(device.address, device.config.mac, T.SetLightPower, p, T.Ack);
}

async function identify(ip: string, mac: string): Promise<Discovered> {
  const c = await getColor(ip, mac);
  return {
    id: `lifx:${mac}`,
    driver: 'lifx',
    name: c.label || `LIFX ${mac.slice(-4)}`,
    kind: 'light',
    address: ip,
    mac,
    capabilities: ['power', 'brightness', 'color', 'color_temp'],
    colorTempRange: [2500, 9000],
    status: 'ready',
    config: { mac },
    state: toState(c),
  };
}

async function discoverMacs(targets: string[], timeoutMs: number) {
  const found = new Map<string, string>();
  await udpCollect({
    port: PORT,
    targets,
    payload: packet(T.GetService).buf,
    timeoutMs,
    onMessage: (m, rinfo) => {
      if (msgType(m) === T.StateService) found.set(rinfo.address, macOf(m));
    },
  });
  return found;
}

export const lifx: Driver = {
  id: 'lifx',
  name: 'LIFX',
  kinds: ['light'],
  troubleshooting: [
    'LIFX bulbs must be on the same 2.4 GHz network as this computer; LAN control is always on.',
    'Some mesh routers drop UDP broadcasts — add by IP: iot add <ip>',
  ],

  async discover(ctx: DiscoveryContext) {
    const macs = await discoverMacs(ctx.broadcastAddresses, Math.min(ctx.timeoutMs, 3000));
    return settleAll([...macs].map(([ip, mac]) => identify(ip, mac)));
  },

  async probe(ip) {
    const macs = await discoverMacs([ip], 1500);
    const mac = macs.get(ip);
    return mac ? [await identify(ip, mac)] : [];
  },

  async getState(device) {
    return toState(await getColor(device.address, device.config.mac));
  },

  async execute(device, cmd: Command) {
    switch (cmd.type) {
      case 'power':
        return setPower(device, cmd.on);
      case 'toggle': {
        const c = await getColor(device.address, device.config.mac);
        return setPower(device, !c.power);
      }
      case 'brightness': {
        if (cmd.value <= 0) return setPower(device, false);
        const c = await getColor(device.address, device.config.mac);
        await setColor(device, { ...c, bri: (clamp(cmd.value, 1, 100) / 100) * 65535 });
        if (!c.power) await setPower(device, true);
        return;
      }
      case 'color': {
        const c = await getColor(device.address, device.config.mac);
        const { h, s } = rgbToHsv(cmd.rgb);
        await setColor(device, { hue: (h / 360) * 65535, sat: s * 65535, bri: c.bri || 65535, kelvin: c.kelvin || 3500 });
        if (!c.power) await setPower(device, true);
        return;
      }
      case 'color_temp': {
        const c = await getColor(device.address, device.config.mac);
        const [min, max] = device.colorTempRange ?? [2500, 9000];
        await setColor(device, { hue: 0, sat: 0, bri: c.bri || 65535, kelvin: clamp(cmd.kelvin, min, max) });
        if (!c.power) await setPower(device, true);
        return;
      }
      default:
        throw new DeviceError(`LIFX doesn't support "${cmd.type}" yet`);
    }
  },
};
