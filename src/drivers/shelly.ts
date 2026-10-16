import { Capability, Command, Device, DeviceError, DeviceKind, DeviceState, Discovered, DiscoveryContext, Driver, DriverContext, SetupIO } from '../core/types';
import { clamp } from '../util/color';
import { httpRequest, settleAll } from '../util/net';

/**
 * Shelly relays, plugs, dimmers and bulbs. Gen1: REST (/relay/0?turn=on).
 * Gen2+/Plus/Pro: JSON-RPC over HTTP (/rpc/Switch.Set). Optional password.
 */

type Auth = { user: string; pass: string } | undefined;
const credKey = (mac: string) => `shelly:${mac}`;

async function get(ip: string, path: string, auth: Auth) {
  const res = await httpRequest(`http://${ip}${path}`, { auth });
  if (res.status === 401) throw new DeviceError('Shelly rejected the password', 'Run: iot setup <device>');
  if (res.status >= 400) throw new DeviceError(`Shelly HTTP ${res.status}: ${res.text.slice(0, 120)}`);
  return res.body;
}

const qs = (p: Record<string, unknown>) =>
  '?' + Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))}`).join('&');

interface Channel {
  key: string; // gen2: "switch:0"; gen1: "relay:0"
  kind: DeviceKind;
  caps: Capability[];
  name?: string;
  state: DeviceState;
}

function gen2Channels(status: any, config: any): Channel[] {
  const out: Channel[] = [];
  for (const [key, s] of Object.entries<any>(status)) {
    const [type] = key.split(':');
    const name = config?.[key]?.name ?? undefined;
    const base = { online: true, on: !!s.output, brightness: s.brightness };
    if (type === 'switch') out.push({ key, kind: 'switch', caps: ['power'], name, state: base });
    else if (type === 'light') out.push({ key, kind: 'dimmer', caps: ['power', 'brightness'], name, state: base });
    else if (type === 'cct') out.push({ key, kind: 'light', caps: ['power', 'brightness', 'color_temp'], name, state: { ...base, colorTemp: s.ct } });
    else if (type === 'rgb' || type === 'rgbw')
      out.push({ key, kind: 'light', caps: ['power', 'brightness', 'color'], name, state: { ...base, color: s.rgb ? { r: s.rgb[0], g: s.rgb[1], b: s.rgb[2] } : undefined } });
  }
  return out;
}

function gen1Channels(type: string, status: any, settings: any): Channel[] {
  const out: Channel[] = [];
  (status.relays ?? []).forEach((r: any, i: number) =>
    out.push({ key: `relay:${i}`, kind: /PLG/i.test(type) ? 'plug' : 'switch', caps: ['power'], name: settings?.relays?.[i]?.name, state: { online: true, on: !!r.ison } })
  );
  const colorMode = settings?.mode === 'color';
  (status.lights ?? []).forEach((l: any, i: number) => {
    const isBulb = /SHBLB/i.test(type);
    const isRgbw2 = /SHRGBW2/i.test(type);
    const caps: Capability[] = ['power', 'brightness'];
    if (isBulb || (isRgbw2 && colorMode)) caps.push('color');
    if (isBulb || /SHBDUO|SHCB/i.test(type)) caps.push('color_temp');
    const endpoint = isRgbw2 ? (colorMode ? 'color' : 'white') : 'light';
    out.push({
      key: `${endpoint}:${i}`,
      kind: caps.length > 2 ? 'light' : 'dimmer',
      caps,
      name: settings?.lights?.[i]?.name,
      state: {
        online: true,
        on: !!l.ison,
        brightness: l.mode === 'color' || endpoint === 'color' ? l.gain : l.brightness,
        color: l.mode === 'color' || endpoint === 'color' ? { r: l.red, g: l.green, b: l.blue } : undefined,
        colorTemp: l.mode === 'white' && l.temp ? l.temp : undefined,
      },
    });
  });
  return out;
}

async function identify(ip: string, ctx: DriverContext): Promise<Discovered[]> {
  const info = await get(ip, '/shelly', undefined);
  const gen = info.gen ?? 1;
  const mac = String(info.mac ?? ip).toLowerCase();
  const model = info.model ?? info.type;
  const needsAuth = gen === 1 ? !!info.auth : !!info.auth_en;
  const auth: Auth = ctx.credentials.get(credKey(mac));

  if (needsAuth && !auth) {
    return [
      {
        id: `shelly:${mac}`,
        driver: 'shelly',
        name: info.name ?? `Shelly ${model}`,
        kind: 'other',
        model,
        address: ip,
        mac,
        capabilities: [],
        status: 'needs_setup',
        statusReason: 'Password protected — enter the device password',
        config: { gen, mac },
      },
    ];
  }

  const channels =
    gen === 1
      ? gen1Channels(info.type, await get(ip, '/status', auth), await get(ip, '/settings', auth).catch(() => ({})))
      : gen2Channels(await get(ip, '/rpc/Shelly.GetStatus', auth), await get(ip, '/rpc/Shelly.GetConfig', auth).catch(() => ({})));

  const deviceName = info.name ?? `Shelly ${model}`;
  return channels.map((c) => ({
    id: `shelly:${mac}:${c.key}`,
    driver: 'shelly',
    name: c.name || (channels.length > 1 ? `${deviceName} ${c.key}` : deviceName),
    kind: c.kind,
    model,
    address: ip,
    mac,
    capabilities: c.caps,
    colorTempRange: c.caps.includes('color_temp') ? [2700, 6500] : undefined,
    status: 'ready' as const,
    config: { gen, mac, channel: c.key },
    state: c.state,
  }));
}

function authFor(device: Device, ctx: DriverContext): Auth {
  return ctx.credentials.get(credKey(device.config.mac));
}

export const shelly: Driver = {
  id: 'shelly',
  name: 'Shelly',
  kinds: ['switch', 'plug', 'dimmer', 'light'],
  troubleshooting: [
    'Shelly devices advertise over mDNS as shelly<model>-<id>.local — they must be on the same network segment.',
    'If you enabled "Restrict login" in the Shelly app/web UI, setup will ask for that password.',
    'Shelly Cloud is not needed; local HTTP must not be disabled in the device settings.',
    'Add by IP if mDNS is blocked: iot add <ip>',
  ],

  async discover(ctx: DiscoveryContext) {
    const hosts = (await ctx.mdns()).filter(
      (h) => h.services.includes('_shelly._tcp.local') || h.hostnames.some((n) => /^shelly/i.test(n)) || Object.keys(h.instances).some((n) => /^shelly/i.test(n))
    );
    return (await settleAll(hosts.map((h) => identify(h.address, ctx)))).flat();
  },

  probe: (ip, ctx) => identify(ip, ctx),

  async setup(device: Device, io: SetupIO, ctx: DriverContext) {
    io.info(`${device.name} (${device.address}) is password protected.`);
    const user = device.config.gen === 1 ? await io.ask('Username', { default: 'admin' }) : 'admin';
    const pass = await io.ask('Password', { secret: true });
    ctx.credentials.set(credKey(device.config.mac), { user, pass });
    try {
      const devices = await io.wait('Connecting…', () => identify(device.address, ctx));
      io.success(`Connected — ${devices.length} channel(s).`);
      return devices;
    } catch (e: any) {
      ctx.credentials.delete(credKey(device.config.mac));
      io.warn(e.message);
      return [device];
    }
  },

  async getState(device, ctx) {
    const all = await identify(device.address, ctx);
    return all.find((d) => d.id === device.id)?.state ?? { online: true };
  },

  async execute(device, cmd: Command, ctx) {
    const auth = authFor(device, ctx);
    const [type, idx] = String(device.config.channel).split(':');
    const ip = device.address;

    if (device.config.gen === 1) {
      const p: Record<string, unknown> = {};
      switch (cmd.type) {
        case 'power':
          p.turn = cmd.on ? 'on' : 'off';
          break;
        case 'toggle':
          p.turn = 'toggle';
          break;
        case 'brightness':
          if (cmd.value <= 0) p.turn = 'off';
          else Object.assign(p, { turn: 'on', [type === 'color' ? 'gain' : 'brightness']: clamp(Math.round(cmd.value), 1, 100) });
          break;
        case 'color':
          Object.assign(p, { turn: 'on', red: cmd.rgb.r, green: cmd.rgb.g, blue: cmd.rgb.b }, type === 'light' ? { mode: 'color' } : {});
          break;
        case 'color_temp':
          Object.assign(p, { turn: 'on', temp: clamp(cmd.kelvin, 2700, 6500) }, /SHBLB/i.test(device.model ?? '') ? { mode: 'white' } : {});
          break;
        default:
          throw new DeviceError(`Shelly doesn't support "${cmd.type}" yet`);
      }
      await get(ip, `/${type}/${idx}${qs(p)}`, auth);
      return;
    }

    const component = type === 'switch' ? 'Switch' : type === 'light' ? 'Light' : type === 'cct' ? 'CCT' : type === 'rgbw' ? 'RGBW' : 'RGB';
    const id = Number(idx);
    switch (cmd.type) {
      case 'power':
        await get(ip, `/rpc/${component}.Set${qs({ id, on: cmd.on })}`, auth);
        return;
      case 'toggle':
        await get(ip, `/rpc/${component}.Toggle${qs({ id })}`, auth);
        return;
      case 'brightness':
        if (cmd.value <= 0) return void (await get(ip, `/rpc/${component}.Set${qs({ id, on: false })}`, auth));
        await get(ip, `/rpc/${component}.Set${qs({ id, on: true, brightness: clamp(Math.round(cmd.value), 1, 100) })}`, auth);
        return;
      case 'color':
        await get(ip, `/rpc/${component}.Set${qs({ id, on: true, rgb: [cmd.rgb.r, cmd.rgb.g, cmd.rgb.b] })}`, auth);
        return;
      case 'color_temp':
        await get(ip, `/rpc/${component}.Set${qs({ id, on: true, ct: clamp(cmd.kelvin, 2700, 6500) })}`, auth);
        return;
      default:
        throw new DeviceError(`Shelly doesn't support "${cmd.type}" yet`);
    }
  },
};
