import { Command, Device, DeviceError, DeviceState, Discovered, DiscoveryContext, Driver, DriverContext, SetupIO } from '../core/types';
import { instancePort, txtValue } from '../discovery/mdns';
import { clamp, hsvToRgb, rgbToHsv } from '../util/color';
import { httpRequest, settleAll, sleep } from '../util/net';

/**
 * Nanoleaf panels/bulbs/strips (Light Panels, Canvas, Shapes, Lines, Essentials over Wi-Fi).
 * REST API on port 16021. Pairing: hold the power button 5–7 s, then request a token.
 */
const DEFAULT_PORT = 16021;
const credKey = (id: string) => `nanoleaf:${id}`;

const base = (d: { address: string; config: Record<string, any> }) => `http://${d.address}:${d.config.port ?? DEFAULT_PORT}/api/v1`;

async function api(device: Device, ctx: DriverContext, path: string, method = 'GET', body?: unknown) {
  const token = ctx.credentials.get<{ token: string }>(credKey(device.config.nlId))?.token;
  if (!token) throw new DeviceError('Nanoleaf is not paired', 'Run: iot setup');
  const res = await httpRequest(`${base(device)}/${token}${path}`, { method, body });
  if (res.status === 401) throw new DeviceError('Nanoleaf rejected the token', 'Pair again with: iot setup');
  if (res.status >= 400) throw new DeviceError(`Nanoleaf HTTP ${res.status}`);
  return res.body;
}

function toState(info: any): DeviceState {
  const s = info.state ?? {};
  const isCt = s.colorMode === 'ct';
  return {
    online: true,
    on: !!s.on?.value,
    brightness: s.brightness?.value,
    color: !isCt && s.hue ? hsvToRgb(s.hue.value, (s.sat?.value ?? 0) / 100, 1) : undefined,
    colorTemp: isCt ? s.ct?.value : undefined,
    scene: s.colorMode === 'effect' ? info.effects?.select : undefined,
  };
}

function ready(placeholder: Discovered | Device, info: any): Discovered {
  return {
    ...placeholder,
    name: info.name ?? placeholder.name,
    model: info.model,
    kind: 'light',
    capabilities: ['power', 'brightness', 'color', 'color_temp', 'scene'],
    colorTempRange: [info.state?.ct?.min ?? 1200, info.state?.ct?.max ?? 6500],
    scenes: info.effects?.effectsList ?? [],
    status: 'ready',
    statusReason: undefined,
    state: toState(info),
  } as Discovered;
}

async function identify(ip: string, port: number, nlId: string, name: string, ctx: DriverContext): Promise<Discovered> {
  const placeholder: Discovered = {
    id: `nanoleaf:${nlId}`,
    driver: 'nanoleaf',
    name,
    kind: 'light',
    address: ip,
    capabilities: [],
    status: 'needs_setup',
    statusReason: 'Hold the power button 5–7 s to pair',
    config: { nlId, port },
  };
  if (!ctx.credentials.get(credKey(nlId))) return placeholder;
  try {
    return ready(placeholder, await api(placeholder as Device, ctx, '/'));
  } catch {
    return { ...placeholder, statusReason: 'Pairing lost — pair again' };
  }
}

export const nanoleaf: Driver = {
  id: 'nanoleaf',
  name: 'Nanoleaf',
  kinds: ['light'],
  troubleshooting: [
    'Wi-Fi Nanoleaf products advertise _nanoleafapi._tcp over mDNS. Thread-only Essentials bulbs need a Thread border router and are not reachable this way.',
    'Pairing: hold the controller\'s power button for 5–7 seconds until the LEDs flash, then run: iot setup',
  ],

  async discover(ctx: DiscoveryContext) {
    const hosts = (await ctx.mdns()).filter((h) => h.services.includes('_nanoleafapi._tcp.local'));
    return settleAll(
      hosts.map((h) => {
        const nlId = (txtValue(h, '_nanoleafapi._tcp.local', 'id') ?? h.address).toLowerCase();
        const name = Object.keys(h.instances)[0]?.split('._')[0] ?? 'Nanoleaf';
        return identify(h.address, instancePort(h, '_nanoleafapi._tcp.local') ?? DEFAULT_PORT, nlId, name, ctx);
      })
    );
  },

  async probe(ip, ctx) {
    const res = await httpRequest(`http://${ip}:${DEFAULT_PORT}/api/v1/`, { timeoutMs: 1500 });
    // Unauthenticated calls return 401 — that's enough to know it's a Nanoleaf.
    if (res.status !== 401 && res.status !== 403) return [];
    return [await identify(ip, DEFAULT_PORT, ip, 'Nanoleaf', ctx)];
  },

  async setup(device: Device, io: SetupIO, ctx: DriverContext) {
    io.steps(`Pair with ${device.name} (${device.address})`, [
      'Go to the Nanoleaf controller (the unit with the power button).',
      'Hold the power button for 5–7 seconds until the LEDs start flashing.',
      'Pairing stays open for 30 seconds — I will keep trying during that time.',
    ]);
    if (!(await io.confirm('Ready to start?', true))) return [device];

    const token = await io.wait('Waiting for pairing mode…', async (update) => {
      for (let left = 40; left > 0; left -= 2) {
        const res = await httpRequest(`${base(device)}/new`, { method: 'POST' }).catch(() => undefined);
        if (res?.status === 200 && res.body?.auth_token) return res.body.auth_token as string;
        update(`Waiting for pairing mode… ${left}s (hold the power button 5–7 s)`);
        await sleep(2000);
      }
      return undefined;
    });
    if (!token) {
      io.warn('Pairing mode not detected. Try again with `iot setup`.');
      return [device];
    }
    ctx.credentials.set(credKey(device.config.nlId), { token });
    const info = await api(device, ctx, '/');
    io.success(`Paired with ${info.name}.`);
    return [ready(device, info)];
  },

  async getState(device, ctx) {
    return toState(await api(device, ctx, '/'));
  },

  async execute(device, cmd: Command, ctx) {
    const state = (body: object) => api(device, ctx, '/state', 'PUT', body);
    switch (cmd.type) {
      case 'power':
        return void (await state({ on: { value: cmd.on } }));
      case 'toggle': {
        const info = await api(device, ctx, '/');
        return void (await state({ on: { value: !info.state?.on?.value } }));
      }
      case 'brightness':
        if (cmd.value <= 0) return void (await state({ on: { value: false } }));
        return void (await state({ on: { value: true }, brightness: { value: clamp(Math.round(cmd.value), 1, 100) } }));
      case 'color': {
        const { h, s } = rgbToHsv(cmd.rgb);
        return void (await state({ on: { value: true }, hue: { value: Math.round(h) }, sat: { value: Math.round(s * 100) } }));
      }
      case 'color_temp': {
        const [min, max] = device.colorTempRange ?? [1200, 6500];
        return void (await state({ on: { value: true }, ct: { value: clamp(cmd.kelvin, min, max) } }));
      }
      case 'scene':
        return void (await api(device, ctx, '/effects', 'PUT', { select: cmd.scene }));
    }
  },
};
