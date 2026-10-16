import { Command, DeviceError, DeviceState, Discovered, DiscoveryContext, Driver } from '../core/types';
import { clamp, isWhite } from '../util/color';
import dgram from 'dgram';
import { settleAll, udpCollect, udpRequest } from '../util/net';

/**
 * WiZ (Signify / Philips WiZ, Havells, many white-label bulbs and plugs).
 * Local JSON over UDP port 38899. No pairing, no keys.
 */
const PORT = 38899;

const SCENES: Record<number, string> = {
  1: 'Ocean', 2: 'Romance', 3: 'Sunset', 4: 'Party', 5: 'Fireplace', 6: 'Cozy', 7: 'Forest',
  8: 'Pastel Colors', 9: 'Wake up', 10: 'Bedtime', 11: 'Warm White', 12: 'Daylight', 13: 'Cool white',
  14: 'Night light', 15: 'Focus', 16: 'Relax', 17: 'True colors', 18: 'TV time', 19: 'Plantgrowth',
  20: 'Spring', 21: 'Summer', 22: 'Fall', 23: 'Deepdive', 24: 'Jungle', 25: 'Mojito', 26: 'Club',
  27: 'Christmas', 28: 'Halloween', 29: 'Candlelight', 30: 'Golden white', 31: 'Pulse', 32: 'Steampunk',
};

/** Scenes each bulb family accepts; anything else is answered with "Internal error". */
const TW_SCENES = [6, 9, 10, 11, 12, 13, 14, 15, 16, 18, 29, 30, 31, 32];
const DW_SCENES = [9, 10, 14, 29, 30, 31, 32];

async function call(ip: string, method: string, params: Record<string, unknown> = {}, fast = false) {
  // Bulbs with weak signal (≤ -80 dBm) lose over half their packets, and bulbs in
  // Wi-Fi power-save can take ~1 s to answer, so retry generously. setPilot is idempotent.
  const msg = await udpRequest(ip, PORT, Buffer.from(JSON.stringify({ method, params })), {
    timeoutMs: fast ? 700 : 1000,
    retries: fast ? 0 : 5,
    accept: (m) => m.toString().includes(`"${method}"`),
  });
  const res = JSON.parse(msg.toString());
  if (res.error?.code === -32603) {
    throw new DeviceError('The bulb rejected that setting', 'This WiZ model may not support it (e.g. colour scenes on a white-only bulb).');
  }
  if (res.error) throw new DeviceError(`WiZ error: ${res.error.message ?? JSON.stringify(res.error)}`);
  return res.result ?? {};
}

/** setPilot params for a combined `set` command. */
function pilotParams(device: { colorTempRange?: [number, number] }, cmd: Extract<Command, { type: 'set' }>): Record<string, unknown> {
  if (cmd.on === false || cmd.brightness === 0) return { state: false };
  const p: Record<string, unknown> = { state: true };
  if (cmd.brightness !== undefined) p.dimming = clamp(Math.round(cmd.brightness), 10, 100);
  if (cmd.rgb && !isWhite(cmd.rgb)) Object.assign(p, cmd.rgb);
  else if (cmd.rgb || cmd.kelvin !== undefined) {
    const [min, max] = device.colorTempRange ?? [2200, 6500];
    p.temp = clamp(cmd.kelvin ?? 4000, min, max);
  }
  return p;
}

// One shared socket for streaming: creating a socket per packet costs time at 25 fps x 54 bulbs.
let streamSocket: dgram.Socket | undefined;
function streamSend(ip: string, params: Record<string, unknown>) {
  if (!streamSocket) {
    streamSocket = dgram.createSocket('udp4');
    streamSocket.on('error', () => {});
    streamSocket.on('message', () => {}); // acks are ignored
    streamSocket.unref();
  }
  streamSocket.send(JSON.stringify({ method: 'setPilot', params }), PORT, ip, () => {});
}

/** Capabilities from the module name, e.g. ESP01_SHRGB1C_31, ESP06_SHDW9_01, ESP10_SOCKET_06. */
function describeModule(moduleName = ''): Pick<Discovered, 'kind' | 'capabilities' | 'colorTempRange' | 'scenes'> {
  const m = moduleName.toUpperCase();
  const names = (ids: number[]) => ids.map((i) => SCENES[i]);
  if (m.includes('SOCKET')) return { kind: 'plug', capabilities: ['power'] };
  if (m.includes('RGB')) return { kind: 'light', capabilities: ['power', 'brightness', 'color', 'color_temp', 'scene'], colorTempRange: [2200, 6500], scenes: Object.values(SCENES) };
  if (m.includes('TW')) return { kind: 'light', capabilities: ['power', 'brightness', 'color_temp', 'scene'], colorTempRange: [2700, 6500], scenes: names(TW_SCENES) };
  if (m.includes('DW')) return { kind: 'light', capabilities: ['power', 'brightness', 'scene'], scenes: names(DW_SCENES) };
  // Unknown module: assume a full-colour bulb, which is the most common WiZ product.
  return { kind: 'light', capabilities: ['power', 'brightness', 'color', 'color_temp', 'scene'], colorTempRange: [2200, 6500], scenes: Object.values(SCENES) };
}

function toState(p: any): DeviceState {
  return {
    online: true,
    on: !!p.state,
    brightness: p.dimming,
    color: p.r !== undefined && (p.r || p.g || p.b) ? { r: p.r, g: p.g, b: p.b } : undefined,
    colorTemp: p.temp || undefined,
    scene: p.sceneId ? SCENES[p.sceneId] : undefined,
    extra: { rssi: p.rssi },
  };
}

async function identify(ip: string, mac?: string): Promise<Discovered> {
  const [sys, pilot, model] = await Promise.all([
    call(ip, 'getSystemConfig').catch(() => ({})),
    call(ip, 'getPilot'),
    call(ip, 'getModelConfig').catch(() => ({})),
  ]);
  const id = String(mac ?? sys.mac ?? pilot.mac ?? ip).toLowerCase();
  const kindInfo = describeModule(sys.moduleName);
  // The bulb reports its real white range, e.g. cctRange [2700, 2700, 6500, 6500].
  const cct: number[] | undefined = model.cctRange;
  if (kindInfo.colorTempRange && Array.isArray(cct) && cct.length >= 2) kindInfo.colorTempRange = [Math.min(...cct), Math.max(...cct)];
  return {
    id: `wiz:${id}`,
    driver: 'wiz',
    name: `WiZ ${kindInfo.kind === 'plug' ? 'Plug' : 'Light'} ${id.slice(-4).toUpperCase()}`,
    model: sys.moduleName,
    address: ip,
    mac: id,
    ...kindInfo,
    status: 'ready',
    config: {},
    state: toState(pilot),
  };
}

export const wiz: Driver = {
  id: 'wiz',
  name: 'WiZ',
  kinds: ['light', 'plug'],
  troubleshooting: [
    'In the WiZ app: Settings → Security → turn ON "Allow local communication". Without it the bulb ignores LAN commands.',
    'The bulb must be on the same Wi-Fi network/VLAN as this computer (guest networks usually block device-to-device traffic).',
    'Router "AP/client isolation" blocks discovery — disable it, or add the bulb by IP: iot add <ip>.',
    'Find the IP in the WiZ app (bulb → Device info) or in your router\'s DHCP client list.',
  ],

  async discover(ctx: DiscoveryContext) {
    const found = new Map<string, string>();
    const payload = Buffer.from(
      JSON.stringify({ method: 'registration', params: { phoneMac: 'AAAAAAAAAAAA', register: false, phoneIp: '1.2.3.4', id: '1' } })
    );
    await udpCollect({
      port: PORT,
      targets: ctx.broadcastAddresses,
      payload,
      timeoutMs: Math.min(ctx.timeoutMs, 3000),
      onMessage: (msg, rinfo) => {
        const res = JSON.parse(msg.toString());
        if (res.result?.mac) found.set(rinfo.address, res.result.mac);
      },
    });
    return settleAll([...found].map(([ip, mac]) => identify(ip, mac)));
  },

  async probe(ip) {
    return [await identify(ip)];
  },

  async getState(device, ctx) {
    return toState(await call(device.address, 'getPilot', {}, ctx?.fast));
  },

  nativeSet: true,

  stream(device, cmd) {
    streamSend(device.address, pilotParams(device, cmd));
  },

  async execute(device, cmd: Command, ctx) {
    const ip = device.address;
    switch (cmd.type) {
      case 'set':
        await call(ip, 'setPilot', pilotParams(device, cmd), ctx.fast);
        return;
      case 'power':
        await call(ip, 'setPilot', { state: cmd.on });
        return;
      case 'toggle': {
        const { state } = await call(ip, 'getPilot');
        await call(ip, 'setPilot', { state: !state });
        return;
      }
      case 'brightness':
        if (cmd.value <= 0) return void (await call(ip, 'setPilot', { state: false }));
        await call(ip, 'setPilot', { state: true, dimming: clamp(Math.round(cmd.value), 10, 100) });
        return;
      case 'color':
        // Pure white mixed from RGB LEDs looks blue/purple — use the white LEDs instead.
        if (isWhite(cmd.rgb)) await call(ip, 'setPilot', { state: true, temp: 4000 });
        else await call(ip, 'setPilot', { state: true, r: cmd.rgb.r, g: cmd.rgb.g, b: cmd.rgb.b });
        return;
      case 'color_temp': {
        const [min, max] = device.colorTempRange ?? [2200, 6500];
        await call(ip, 'setPilot', { state: true, temp: clamp(cmd.kelvin, min, max) });
        return;
      }
      case 'scene': {
        const available = device.scenes ?? Object.values(SCENES);
        const entry = Object.entries(SCENES).find(([, name]) => name.toLowerCase() === cmd.scene.toLowerCase());
        if (!entry || !available.includes(entry[1])) throw new DeviceError(`"${cmd.scene}" isn't available on ${device.name}`, `Available: ${available.join(', ')}`);
        await call(ip, 'setPilot', { state: true, sceneId: Number(entry[0]) });
        return;
      }
    }
  },
};

