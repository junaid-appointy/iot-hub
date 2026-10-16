import { Capability, Command, Device, DeviceError, DeviceState, Discovered, DiscoveryContext, Driver } from '../core/types';
import { clamp, hsvToRgb, rgbToHsv } from '../util/color';
import { tcpRequest, udpCollect } from '../util/net';

/**
 * TP-Link Kasa (plugs, power strips, switches, dimmers, bulbs, light strips)
 * over the local protocol: JSON obfuscated with an autokey XOR cipher on
 * port 9999. UDP broadcast for discovery, TCP (length-prefixed) for control.
 */
const PORT = 9999;

function encrypt(json: string): Buffer {
  const out = Buffer.alloc(json.length);
  let key = 171;
  for (let i = 0; i < json.length; i++) key = out[i] = json.charCodeAt(i) ^ key;
  return out;
}

function decrypt(buf: Buffer): string {
  const out = Buffer.alloc(buf.length);
  let key = 171;
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key;
    key = buf[i];
  }
  return out.toString('utf8');
}

async function send(ip: string, payload: object): Promise<any> {
  const body = encrypt(JSON.stringify(payload));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const res = await tcpRequest(ip, PORT, Buffer.concat([header, body]), (b) => b.length >= 4 && b.length >= 4 + b.readUInt32BE(0));
  const json = JSON.parse(decrypt(res.subarray(4)));
  // Every module answers with { err_code, ... }; surface the first failure.
  for (const mod of Object.values<any>(json)) {
    for (const r of Object.values<any>(mod ?? {})) {
      if (r && typeof r === 'object' && r.err_code) throw new DeviceError(`Kasa error ${r.err_code}: ${r.err_msg ?? 'command rejected'}`);
    }
  }
  return json;
}

const lightModule = (model = '') => (/^KL4/i.test(model) ? 'smartlife.iot.lightStrip' : 'smartlife.iot.smartbulb.lightingservice');

/** One sysinfo can describe several devices (power strips have child outlets). */
function fromSysinfo(ip: string, info: any): Discovered[] {
  const deviceId: string = info.deviceId ?? info.mic_mac ?? info.mac ?? ip;
  const type: string = info.mic_type ?? info.type ?? '';
  const base = {
    driver: 'kasa',
    model: info.model,
    address: ip,
    mac: (info.mac ?? info.mic_mac)?.toLowerCase(),
    status: 'ready' as const,
  };

  if (/SMARTBULB/i.test(type)) {
    const caps: Capability[] = ['power'];
    if (info.is_dimmable) caps.push('brightness');
    if (info.is_color) caps.push('color');
    if (info.is_variable_color_temp) caps.push('color_temp');
    const wide = /^(KL130|LB130|LB120|KL120)/i.test(info.model ?? '');
    return [
      {
        ...base,
        id: `kasa:${deviceId}`,
        name: info.alias,
        kind: 'light',
        capabilities: caps,
        colorTempRange: info.is_variable_color_temp ? (wide ? [2500, 9000] : [2500, 6500]) : undefined,
        config: { type: 'bulb', module: lightModule(info.model) },
        state: bulbState(info.light_state),
      },
    ];
  }

  if (Array.isArray(info.children) && info.children.length) {
    return info.children.map((c: any, i: number) => ({
      ...base,
      id: `kasa:${deviceId}:${c.id ?? i}`,
      name: c.alias || `${info.alias} outlet ${i + 1}`,
      kind: 'plug' as const,
      capabilities: ['power'] as Capability[],
      config: { type: 'outlet', childId: String(c.id).startsWith(deviceId) ? c.id : `${deviceId}${c.id}` },
      state: { online: true, on: !!c.state },
    }));
  }

  const dimmer = info.brightness !== undefined;
  return [
    {
      ...base,
      id: `kasa:${deviceId}`,
      name: info.alias,
      kind: dimmer ? 'dimmer' : /HS2|KS2/i.test(info.model ?? '') ? 'switch' : 'plug',
      capabilities: dimmer ? ['power', 'brightness'] : ['power'],
      config: { type: dimmer ? 'dimmer' : 'plug' },
      state: { online: true, on: info.relay_state === 1, brightness: info.brightness },
    },
  ];
}

function bulbState(ls: any = {}): DeviceState {
  const s = ls.on_off ? ls : { ...ls, ...ls.dft_on_state };
  return {
    online: true,
    on: !!ls.on_off,
    brightness: s.brightness,
    colorTemp: s.color_temp || undefined,
    color: !s.color_temp && s.saturation ? hsvToRgb(s.hue ?? 0, (s.saturation ?? 0) / 100, 1) : undefined,
  };
}

async function sysinfo(ip: string) {
  const res = await send(ip, { system: { get_sysinfo: {} } });
  return res.system.get_sysinfo;
}

async function stateOf(device: Device): Promise<DeviceState> {
  const info = await sysinfo(device.address);
  return fromSysinfo(device.address, info).find((d) => d.id === device.id)?.state ?? { online: true };
}

export const kasa: Driver = {
  id: 'kasa',
  name: 'TP-Link Kasa',
  kinds: ['plug', 'switch', 'dimmer', 'light'],
  troubleshooting: [
    'Kasa devices must be set up in the Kasa app first, on the same Wi-Fi as this computer.',
    'Newer firmware (2023+) and all Tapo devices use an encrypted protocol (KLAP) this driver does not speak yet — they will not answer on port 9999.',
    'If a device answers in the app but not here, check for AP/client isolation on your router.',
    'Add by IP if broadcasts are blocked: iot add <ip>',
  ],

  async discover(ctx: DiscoveryContext) {
    const found: Discovered[] = [];
    await udpCollect({
      port: PORT,
      targets: ctx.broadcastAddresses,
      payload: encrypt(JSON.stringify({ system: { get_sysinfo: {} } })),
      timeoutMs: Math.min(ctx.timeoutMs, 3000),
      onMessage: (msg, rinfo) => {
        const info = JSON.parse(decrypt(msg)).system?.get_sysinfo;
        if (info && !found.some((d) => d.address === rinfo.address)) found.push(...fromSysinfo(rinfo.address, info));
      },
    });
    return found;
  },

  async probe(ip) {
    return fromSysinfo(ip, await sysinfo(ip));
  },

  getState: stateOf,

  async execute(device: Device, cmd: Command) {
    const ip = device.address;
    const { type, module, childId } = device.config;

    if (cmd.type === 'toggle') cmd = { type: 'power', on: !(await stateOf(device)).on };

    if (type === 'bulb') {
      const light: Record<string, unknown> = { ignore_default: 1, transition_period: 300 };
      switch (cmd.type) {
        case 'power':
          light.on_off = cmd.on ? 1 : 0;
          break;
        case 'brightness':
          Object.assign(light, cmd.value <= 0 ? { on_off: 0 } : { on_off: 1, brightness: clamp(Math.round(cmd.value), 1, 100) });
          break;
        case 'color': {
          const { h, s } = rgbToHsv(cmd.rgb);
          Object.assign(light, { on_off: 1, hue: Math.round(h), saturation: Math.round(s * 100), color_temp: 0 });
          break;
        }
        case 'color_temp': {
          const [min, max] = device.colorTempRange ?? [2500, 6500];
          Object.assign(light, { on_off: 1, color_temp: clamp(cmd.kelvin, min, max) });
          break;
        }
        default:
          throw new DeviceError(`Kasa bulbs don't support "${cmd.type}"`);
      }
      await send(ip, { [module]: { transition_light_state: light } });
      return;
    }

    const context = childId ? { context: { child_ids: [childId] } } : {};
    switch (cmd.type) {
      case 'power':
        await send(ip, { ...context, system: { set_relay_state: { state: cmd.on ? 1 : 0 } } });
        return;
      case 'brightness':
        if (type !== 'dimmer') throw new DeviceError('This Kasa device is not dimmable');
        if (cmd.value <= 0) return void (await send(ip, { system: { set_relay_state: { state: 0 } } }));
        await send(ip, { 'smartlife.iot.dimmer': { set_brightness: { brightness: clamp(Math.round(cmd.value), 1, 100) } } });
        await send(ip, { system: { set_relay_state: { state: 1 } } });
        return;
      default:
        throw new DeviceError(`Kasa ${type}s don't support "${cmd.type}"`);
    }
  },
};
