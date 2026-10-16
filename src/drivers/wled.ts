import { Capability, Command, DeviceError, DeviceState, Discovered, DiscoveryContext, Driver } from '../core/types';
import { clamp } from '../util/color';
import { httpRequest, settleAll } from '../util/net';

/** WLED (ESP8266/ESP32 LED controllers) — JSON API on port 80, mDNS _wled._tcp. */

async function json(ip: string, path: string, body?: unknown) {
  const res = await httpRequest(`http://${ip}/json${path}`, { method: body ? 'POST' : 'GET', body });
  if (res.status >= 400) throw new DeviceError(`WLED HTTP ${res.status}`);
  return res.body;
}

function toState(s: any, effects?: string[]): DeviceState {
  const col = s.seg?.[0]?.col?.[0];
  return {
    online: true,
    on: !!s.on,
    brightness: Math.round(((s.bri ?? 0) / 255) * 100),
    color: col ? { r: col[0], g: col[1], b: col[2] } : undefined,
    scene: effects && s.seg?.[0]?.fx ? effects[s.seg[0].fx] : undefined,
  };
}

async function identify(ip: string): Promise<Discovered> {
  const [info, state, effects] = await Promise.all([json(ip, '/info'), json(ip, '/state'), json(ip, '/eff').catch(() => [])]);
  if (!info?.ver || !info?.leds) throw new DeviceError(`${ip} is not a WLED device`);
  const caps: Capability[] = ['power', 'brightness', 'color', 'scene'];
  if (info.leds.cct) caps.push('color_temp');
  const mac = String(info.mac).toLowerCase();
  return {
    id: `wled:${mac}`,
    driver: 'wled',
    name: info.name ?? 'WLED',
    kind: 'light',
    model: `WLED ${info.ver} (${info.leds.count} LEDs)`,
    address: ip,
    mac,
    capabilities: caps,
    colorTempRange: info.leds.cct ? [1900, 10000] : undefined,
    scenes: effects,
    status: 'ready',
    config: {},
    state: toState(state, effects),
  };
}

export const wled: Driver = {
  id: 'wled',
  name: 'WLED',
  kinds: ['light'],
  troubleshooting: ['WLED advertises as _wled._tcp over mDNS. If not found, open http://<ip> to confirm it\'s reachable, then: iot add <ip>'],

  async discover(ctx: DiscoveryContext) {
    const hosts = (await ctx.mdns()).filter((h) => h.services.includes('_wled._tcp.local'));
    return settleAll(hosts.map((h) => identify(h.address)));
  },

  probe: async (ip) => [await identify(ip)],

  async getState(device) {
    return toState(await json(device.address, '/state'), device.scenes);
  },

  async execute(device, cmd: Command) {
    const ip = device.address;
    switch (cmd.type) {
      case 'power':
        return void (await json(ip, '/state', { on: cmd.on }));
      case 'toggle':
        return void (await json(ip, '/state', { on: 't' }));
      case 'brightness':
        if (cmd.value <= 0) return void (await json(ip, '/state', { on: false }));
        return void (await json(ip, '/state', { on: true, bri: clamp(Math.round((cmd.value / 100) * 255), 1, 255) }));
      case 'color':
        return void (await json(ip, '/state', { on: true, seg: [{ fx: 0, col: [[cmd.rgb.r, cmd.rgb.g, cmd.rgb.b]] }] }));
      case 'color_temp':
        return void (await json(ip, '/state', { on: true, seg: [{ cct: clamp(cmd.kelvin, 1900, 10000) }] }));
      case 'scene': {
        const fx = (device.scenes ?? []).findIndex((e) => e.toLowerCase() === cmd.scene.toLowerCase());
        if (fx < 0) throw new DeviceError(`Unknown WLED effect "${cmd.scene}"`, 'List effects with: iot scene <device>');
        return void (await json(ip, '/state', { on: true, seg: [{ fx }] }));
      }
    }
  },
};
