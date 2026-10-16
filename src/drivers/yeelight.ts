import { Capability, Command, Device, DeviceError, DeviceState, Discovered, DiscoveryContext, Driver } from '../core/types';
import { parseHttpHeaders } from '../discovery/ssdp';
import { clamp } from '../util/color';
import { tcpRequest, udpCollect, udpRequest } from '../util/net';

/**
 * Yeelight (Xiaomi) Wi-Fi bulbs and strips. SSDP-style discovery on
 * 239.255.255.250:1982, JSON-RPC lines over TCP 55443. Needs "LAN Control"
 * switched on per device in the Yeelight app.
 */
const PORT = 55443;
const SEARCH = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n');
const LAN_CONTROL_HINT = 'Open the Yeelight app → the device → ⋯ (top right) → LAN Control → turn it ON.';

let nextId = 1;

async function rpc(ip: string, method: string, params: unknown[] = []): Promise<any[]> {
  const id = nextId++;
  const line = Buffer.from(JSON.stringify({ id, method, params }) + '\r\n');
  let buf: Buffer;
  try {
    // The bulb may interleave {"method":"props"} notifications; read until our id answers.
    buf = await tcpRequest(ip, PORT, line, (b) => b.toString().includes(`"id":${id}`));
  } catch (e: any) {
    if (/refused/i.test(e.message)) throw new DeviceError('Yeelight refused the connection — LAN Control is off', LAN_CONTROL_HINT);
    throw e;
  }
  const reply = buf
    .toString()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((m) => m.id === id);
  if (reply?.error) throw new DeviceError(`Yeelight: ${reply.error.message}`);
  return reply?.result ?? [];
}

function fromHeaders(h: Record<string, string>): Discovered | undefined {
  const loc = h.location?.match(/yeelight:\/\/([\d.]+):(\d+)/);
  if (!loc || !h.id) return undefined;
  const support = new Set((h.support ?? '').split(' '));
  const caps: Capability[] = ['power'];
  if (support.has('set_bright')) caps.push('brightness');
  if (support.has('set_rgb')) caps.push('color');
  if (support.has('set_ct_abx')) caps.push('color_temp');
  return {
    id: `yeelight:${h.id.toLowerCase()}`,
    driver: 'yeelight',
    name: h.name || `Yeelight ${h.model ?? ''}`.trim(),
    kind: 'light',
    model: h.model,
    address: loc[1],
    capabilities: caps,
    colorTempRange: caps.includes('color_temp') ? (caps.includes('color') ? [1700, 6500] : [2700, 6500]) : undefined,
    status: 'ready',
    config: {},
    state: {
      online: true,
      on: h.power === 'on',
      brightness: h.bright ? Number(h.bright) : undefined,
      colorTemp: h.color_mode === '2' ? Number(h.ct) : undefined,
      color: h.color_mode === '1' && h.rgb ? intToRgb(Number(h.rgb)) : undefined,
    },
  };
}

const intToRgb = (n: number) => ({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 });

async function readState(ip: string): Promise<DeviceState> {
  const [power, bright, ct, rgb, mode] = await rpc(ip, 'get_prop', ['power', 'bright', 'ct', 'rgb', 'color_mode']);
  return {
    online: true,
    on: power === 'on',
    brightness: bright ? Number(bright) : undefined,
    colorTemp: mode === '2' ? Number(ct) : undefined,
    color: mode === '1' && rgb ? intToRgb(Number(rgb)) : undefined,
  };
}

export const yeelight: Driver = {
  id: 'yeelight',
  name: 'Yeelight',
  kinds: ['light'],
  troubleshooting: [
    LAN_CONTROL_HINT + ' Without it the bulb neither answers discovery nor accepts commands.',
    'Yeelight limits each device to ~60 commands per minute; rapid scripts may get rate-limited.',
    'Add by IP if discovery is blocked: iot add <ip>',
  ],

  async discover(ctx: DiscoveryContext) {
    const found = new Map<string, Discovered>();
    await udpCollect({
      port: 1982,
      targets: ['239.255.255.250'],
      payload: SEARCH,
      timeoutMs: Math.min(ctx.timeoutMs, 3000),
      onMessage: (msg) => {
        const d = fromHeaders(parseHttpHeaders(msg.toString()));
        if (d) found.set(d.id, d);
      },
    });
    return [...found.values()];
  },

  async probe(ip) {
    await rpc(ip, 'get_prop', ['power']);
    // A unicast search gets us the real device id and capabilities.
    try {
      const reply = await udpRequest(ip, 1982, SEARCH, { timeoutMs: 1000, retries: 1 });
      const d = fromHeaders(parseHttpHeaders(reply.toString()));
      if (d) return [d];
    } catch {}
    return [
      {
        id: `yeelight:${ip}`,
        driver: 'yeelight',
        name: `Yeelight ${ip}`,
        kind: 'light',
        address: ip,
        capabilities: ['power', 'brightness', 'color', 'color_temp'],
        colorTempRange: [1700, 6500],
        status: 'ready',
        config: {},
        state: await readState(ip),
      },
    ];
  },

  getState: (device) => readState(device.address),

  async execute(device: Device, cmd: Command) {
    const ip = device.address;
    const fx = ['smooth', 300];
    // Yeelight rejects colour/brightness changes while off, so power on first.
    const ensureOn = () => rpc(ip, 'set_power', ['on', ...fx]);
    switch (cmd.type) {
      case 'power':
        await rpc(ip, 'set_power', [cmd.on ? 'on' : 'off', ...fx]);
        return;
      case 'toggle':
        await rpc(ip, 'toggle');
        return;
      case 'brightness':
        if (cmd.value <= 0) return void (await rpc(ip, 'set_power', ['off', ...fx]));
        await ensureOn();
        await rpc(ip, 'set_bright', [clamp(Math.round(cmd.value), 1, 100), ...fx]);
        return;
      case 'color':
        await ensureOn();
        await rpc(ip, 'set_rgb', [(cmd.rgb.r << 16) + (cmd.rgb.g << 8) + cmd.rgb.b, ...fx]);
        return;
      case 'color_temp': {
        const [min, max] = device.colorTempRange ?? [1700, 6500];
        await ensureOn();
        await rpc(ip, 'set_ct_abx', [clamp(cmd.kelvin, min, max), ...fx]);
        return;
      }
      default:
        throw new DeviceError(`Yeelight doesn't support "${cmd.type}" yet`);
    }
  },
};
