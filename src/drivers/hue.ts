import { Capability, Command, Device, DeviceError, DeviceState, Discovered, DiscoveryContext, Driver, DriverContext, SetupIO } from '../core/types';
import { clamp, kelvinToMired, miredToKelvin, rgbToXy, xyToRgb } from '../util/color';
import { httpRequest, settleAll, sleep, withTimeout } from '../util/net';

/**
 * Philips Hue via the bridge's local REST API (v1, http://<bridge>/api/...).
 * The bridge is discovered first; after a one-time link-button pairing every
 * light behind it becomes its own device.
 */

interface Bridge {
  id: string;
  ip: string;
  name?: string;
  model?: string;
}

const credKey = (bridgeId: string) => `hue:${bridgeId}`;

async function bridgeConfig(ip: string): Promise<Bridge | undefined> {
  try {
    const res = await httpRequest(`http://${ip}/api/config`, { timeoutMs: 2000 });
    if (res.body?.bridgeid) return { id: String(res.body.bridgeid).toLowerCase(), ip, name: res.body.name, model: res.body.modelid };
  } catch {}
  return undefined;
}

async function api(ip: string, user: string, path: string, method = 'GET', body?: unknown) {
  const res = await httpRequest(`http://${ip}/api/${user}${path}`, { method, body });
  const errors = Array.isArray(res.body) ? res.body.filter((r: any) => r.error) : [];
  if (errors.length) {
    if (errors[0].error.type === 1) throw new DeviceError('Hue bridge rejected our credentials', 'Pair again with: iot setup');
    throw new DeviceError(`Hue: ${errors.map((e: any) => e.error.description).join('; ')}`);
  }
  return res.body;
}

function lightCaps(light: any): Pick<Discovered, 'kind' | 'capabilities' | 'colorTempRange'> {
  const caps: Capability[] = ['power'];
  const s = light.state ?? {};
  if (s.bri !== undefined) caps.push('brightness');
  if (s.xy !== undefined) caps.push('color');
  let range: [number, number] | undefined;
  if (s.ct !== undefined) {
    caps.push('color_temp');
    const ct = light.capabilities?.control?.ct;
    range = ct ? [miredToKelvin(ct.max), miredToKelvin(ct.min)] : [2200, 6500];
  }
  const isPlug = /plug|on\/off/i.test(light.type ?? '') && caps.length === 1;
  return { kind: isPlug ? 'plug' : 'light', capabilities: caps, colorTempRange: range };
}

function toState(light: any): DeviceState {
  const s = light.state ?? {};
  return {
    online: s.reachable !== false,
    on: !!s.on,
    brightness: s.bri !== undefined ? Math.round((s.bri / 254) * 100) : undefined,
    color: s.colormode === 'xy' && s.xy ? xyToRgb(s.xy[0], s.xy[1]) : undefined,
    colorTemp: s.colormode === 'ct' && s.ct ? miredToKelvin(s.ct) : undefined,
  };
}

async function lightsOf(bridge: Bridge, user: string): Promise<Discovered[]> {
  const lights = await api(bridge.ip, user, '/lights');
  return Object.entries<any>(lights).map(([lightId, light]) => ({
    id: `hue:${bridge.id}:${light.uniqueid ?? lightId}`,
    driver: 'hue',
    name: light.name,
    model: light.productname ?? light.modelid,
    address: bridge.ip,
    ...lightCaps(light),
    status: 'ready' as const,
    config: { bridgeId: bridge.id, lightId },
    state: toState(light),
  }));
}

function bridgePlaceholder(bridge: Bridge, reason: string): Discovered {
  return {
    id: `hue:${bridge.id}`,
    driver: 'hue',
    name: bridge.name ?? 'Hue Bridge',
    kind: 'hub',
    model: bridge.model,
    address: bridge.ip,
    capabilities: [],
    status: 'needs_setup',
    statusReason: reason,
    config: { bridgeId: bridge.id },
  };
}

async function expand(bridge: Bridge, ctx: DriverContext): Promise<Discovered[]> {
  const cred = ctx.credentials.get<{ username: string }>(credKey(bridge.id));
  if (!cred) return [bridgePlaceholder(bridge, 'Press the link button on the bridge to pair')];
  try {
    return await lightsOf(bridge, cred.username);
  } catch (e) {
    if (e instanceof DeviceError && /credentials/.test(e.message)) {
      return [bridgePlaceholder(bridge, 'Pairing was revoked — pair again')];
    }
    throw e;
  }
}

/** Resolve the bridge's current IP (DHCP can move it) from any of its devices. */
function bridgeFor(device: Device, ctx: DriverContext): { ip: string; user: string } {
  const cred = ctx.credentials.get<{ username: string }>(credKey(device.config.bridgeId));
  if (!cred) throw new DeviceError('Hue bridge is not paired', 'Run: iot setup');
  return { ip: device.address, user: cred.username };
}

export const hue: Driver = {
  id: 'hue',
  name: 'Philips Hue',
  kinds: ['hub', 'light', 'plug'],
  troubleshooting: [
    'Hue bulbs are Zigbee — this tool talks to the Hue Bridge, which must be on your LAN (ethernet to the router).',
    'Pairing needs the round link button on top of the bridge pressed within 30 s of running: iot setup',
    'Bluetooth-only Hue bulbs (no bridge) cannot be controlled over the network.',
    'If discovery fails, find the bridge IP in the Hue app (Settings → My Hue system → bridge → i) and run: iot add <ip>',
  ],

  async discover(ctx: DiscoveryContext) {
    const ips = new Set<string>();
    const [mdns, ssdp] = await Promise.all([ctx.mdns(), ctx.ssdp()]);
    for (const h of mdns) if (h.services.includes('_hue._tcp.local')) ips.add(h.address);
    for (const h of ssdp) if (h.headers.some((x) => /IpBridge/i.test(x.server ?? '') || x['hue-bridgeid'])) ips.add(h.address);
    // Cloud fallback (Signify's N-UPnP) for networks where multicast is filtered.
    if (!ips.size) {
      try {
        const res = await withTimeout(fetch('https://discovery.meethue.com/'), 2500);
        const list: any = await res.json();
        if (Array.isArray(list)) list.forEach((b) => b.internalipaddress && ips.add(b.internalipaddress));
      } catch {}
    }
    const bridges = (await settleAll([...ips].map(bridgeConfig))).filter((b): b is Bridge => !!b);
    return (await settleAll(bridges.map((b) => expand(b, ctx)))).flat();
  },

  async probe(ip, ctx) {
    const bridge = await bridgeConfig(ip);
    return bridge ? expand(bridge, ctx) : [];
  },

  async setup(device: Device, io: SetupIO, ctx: DriverContext) {
    const bridge: Bridge = (await bridgeConfig(device.address)) ?? { id: device.config.bridgeId, ip: device.address };
    io.steps(`Pair with ${bridge.name ?? 'your Hue Bridge'} (${bridge.ip})`, [
      'Walk to the Hue Bridge.',
      'Press the large round link button on top of it.',
      'Come back — I will keep trying for 45 seconds.',
    ]);
    if (!(await io.confirm('Ready to start?', true))) return [device];

    const username = await io.wait('Waiting for the link button…', async (update) => {
      for (let left = 45; left > 0; left -= 2) {
        const res = await httpRequest(`http://${bridge.ip}/api`, { method: 'POST', body: { devicetype: 'iot-hub#cli' } });
        const ok = Array.isArray(res.body) && res.body[0]?.success?.username;
        if (ok) return ok as string;
        update(`Waiting for the link button… ${left}s`);
        await sleep(2000);
      }
      return undefined;
    });

    if (!username) {
      io.warn('The link button was not pressed in time. Run `iot setup` to try again.');
      return [device];
    }
    ctx.credentials.set(credKey(bridge.id), { username });
    const lights = await lightsOf(bridge, username);
    io.success(`Paired! Found ${lights.length} light(s) on the bridge.`);
    return lights;
  },

  async getState(device, ctx) {
    const { ip, user } = bridgeFor(device, ctx);
    return toState(await api(ip, user, `/lights/${device.config.lightId}`));
  },

  async execute(device, cmd: Command, ctx) {
    const { ip, user } = bridgeFor(device, ctx);
    const path = `/lights/${device.config.lightId}/state`;
    let body: Record<string, unknown>;
    switch (cmd.type) {
      case 'power':
        body = { on: cmd.on };
        break;
      case 'toggle': {
        const light = await api(ip, user, `/lights/${device.config.lightId}`);
        body = { on: !light.state?.on };
        break;
      }
      case 'brightness':
        body = cmd.value <= 0 ? { on: false } : { on: true, bri: clamp(Math.round((cmd.value / 100) * 254), 1, 254) };
        break;
      case 'color':
        body = { on: true, xy: rgbToXy(cmd.rgb) };
        break;
      case 'color_temp': {
        const [minK, maxK] = device.colorTempRange ?? [2200, 6500];
        body = { on: true, ct: kelvinToMired(clamp(cmd.kelvin, minK, maxK)) };
        break;
      }
      default:
        throw new DeviceError(`Hue lights don't support "${cmd.type}" yet`);
    }
    await api(ip, user, path, 'PUT', body);
  },
};
