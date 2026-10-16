import { Capability, Command, Device, DeviceError, DeviceKind, DeviceState, Discovered, DiscoveryContext, Driver, DriverContext, SetupIO } from '../../core/types';
import { clamp, hsvToRgb, kelvinToScale, rgbToHsv, scaleToKelvin } from '../../util/color';
import { settleAll, udpListen } from '../../util/net';
import { REGIONS, TuyaCloud, TuyaCloudCreds } from './cloud';
import { BroadcastInfo, decodeBroadcast, TuyaLocal } from './protocol';

/**
 * Tuya / Smart Life / every "works with Smart Life" white-label brand
 * (Wipro, Syska, Havells, Gosund, Teckin, Feit, Lidl…).
 *
 * Devices announce themselves on the LAN, but local traffic is encrypted with
 * a per-device key that only Tuya's cloud knows. One-time setup: log in to a
 * Tuya IoT cloud project → we fetch every key → everything after that is local.
 * Protocols we can't speak locally yet (3.4/3.5) are driven through the cloud.
 */
const CLOUD_CRED = 'tuya:cloud';
const TEMP_RANGE: [number, number] = [2700, 6500];

/** How generic capabilities map to this device's datapoints (local) or codes (cloud). */
interface Schema {
  kind: DeviceKind;
  power: string;
  mode?: string;
  bright?: string;
  brightRange?: [number, number];
  temp?: string;
  tempMax?: number;
  colour?: string;
  colourFormat?: 'v1' | 'v2' | 'cloud-v1' | 'cloud-v2';
}

const capsOf = (s: Schema): Capability[] =>
  ['power', s.bright && 'brightness', s.colour && 'color', s.temp && 'color_temp'].filter(Boolean) as Capability[];

/** Infer a schema from local datapoints — standard Tuya light/switch layouts. */
function schemaFromDps(dps: Record<string, any>): Schema | undefined {
  if (typeof dps['20'] === 'boolean') {
    return { kind: 'light', power: '20', mode: '21', bright: '22', brightRange: [10, 1000], temp: dps['23'] !== undefined ? '23' : undefined, tempMax: 1000, colour: dps['24'] !== undefined ? '24' : undefined, colourFormat: 'v2' };
  }
  if (typeof dps['1'] === 'boolean' && typeof dps['2'] === 'string' && /white|colour|scene/.test(dps['2'])) {
    return { kind: 'light', power: '1', mode: '2', bright: '3', brightRange: [25, 255], temp: dps['4'] !== undefined ? '4' : undefined, tempMax: 255, colour: dps['5'] !== undefined ? '5' : undefined, colourFormat: 'v1' };
  }
  if (typeof dps['1'] === 'boolean') {
    return { kind: dps['2'] !== undefined && typeof dps['2'] === 'number' && dps['2'] <= 1000 ? 'dimmer' : 'plug', power: '1', bright: typeof dps['2'] === 'number' ? '2' : undefined, brightRange: [10, 1000] };
  }
  return undefined;
}

/** Infer a schema from cloud function codes. */
function schemaFromFunctions(category: string, fns: Array<{ code: string; values: any }>): Schema | undefined {
  const has = (c: string) => fns.find((f) => f.code === c);
  const power = ['switch_led', 'switch_1', 'switch'].find(has);
  if (!power) return undefined;
  const bright = ['bright_value_v2', 'bright_value', 'bright_value_1'].find(has);
  const temp = ['temp_value_v2', 'temp_value'].find(has);
  const colour = ['colour_data_v2', 'colour_data'].find(has);
  const kind: DeviceKind = ['dj', 'dd', 'fwd', 'dc', 'xdd', 'fsd', 'gyd', 'tyndj'].includes(category)
    ? 'light'
    : category === 'tgq' || category === 'tgkg'
      ? 'dimmer'
      : category === 'kg'
        ? 'switch'
        : category === 'cz' || category === 'pc'
          ? 'plug'
          : 'other';
  const range = (c?: string): [number, number] | undefined => {
    const v = c && has(c)?.values;
    return v && typeof v.min === 'number' ? [v.min, v.max] : undefined;
  };
  return {
    kind,
    power,
    mode: has('work_mode') ? 'work_mode' : undefined,
    bright,
    brightRange: range(bright) ?? [10, 1000],
    temp,
    tempMax: range(temp)?.[1] ?? 1000,
    colour,
    colourFormat: colour === 'colour_data' ? 'cloud-v1' : 'cloud-v2',
  };
}

// ---- value encoding -------------------------------------------------------

function encodeColour(rgb: { r: number; g: number; b: number }, fmt: Schema['colourFormat'], brightness?: number) {
  const { h, s, v: v0 } = rgbToHsv(rgb);
  const v = brightness !== undefined ? brightness / 100 : v0;
  const hex = (n: number, w: number) => Math.round(n).toString(16).padStart(w, '0');
  switch (fmt) {
    case 'v2':
      return hex(h, 4) + hex(s * 1000, 4) + hex(v * 1000, 4);
    case 'v1':
      return hex(rgb.r, 2) + hex(rgb.g, 2) + hex(rgb.b, 2) + hex(h, 4) + hex(s * 255, 2) + hex(v * 255, 2);
    case 'cloud-v1':
      return { h: Math.round(h), s: Math.round(s * 255), v: Math.round(v * 255) };
    default:
      return { h: Math.round(h), s: Math.round(s * 1000), v: Math.round(v * 1000) };
  }
}

function decodeColour(val: any, fmt: Schema['colourFormat']): { rgb: { r: number; g: number; b: number }; v: number } | undefined {
  try {
    if (fmt === 'v2' && typeof val === 'string' && val.length >= 12) {
      const h = parseInt(val.slice(0, 4), 16), s = parseInt(val.slice(4, 8), 16) / 1000, v = parseInt(val.slice(8, 12), 16) / 1000;
      return { rgb: hsvToRgb(h, s, 1), v };
    }
    if (fmt === 'v1' && typeof val === 'string' && val.length >= 14) {
      return { rgb: { r: parseInt(val.slice(0, 2), 16), g: parseInt(val.slice(2, 4), 16), b: parseInt(val.slice(4, 6), 16) }, v: parseInt(val.slice(12, 14), 16) / 255 };
    }
    if (val && typeof val === 'object') {
      const max = fmt === 'cloud-v1' ? 255 : 1000;
      return { rgb: hsvToRgb(val.h, val.s / max, 1), v: val.v / max };
    }
  } catch {}
  return undefined;
}

const scaleBright = (pct: number, [min, max]: [number, number]) => Math.round(min + (clamp(pct, 1, 100) / 100) * (max - min));
const unscaleBright = (v: number, [min, max]: [number, number]) => Math.round(((v - min) / (max - min)) * 99 + 1);

function toState(values: Record<string, any>, s: Schema): DeviceState {
  const colourMode = s.mode && values[s.mode] === 'colour';
  const colour = colourMode && s.colour ? decodeColour(values[s.colour], s.colourFormat) : undefined;
  return {
    online: true,
    on: !!values[s.power],
    brightness: colour ? Math.round(colour.v * 100) : s.bright && values[s.bright] !== undefined ? unscaleBright(values[s.bright], s.brightRange!) : undefined,
    color: colour?.rgb,
    colorTemp: !colourMode && s.temp && values[s.temp] !== undefined ? scaleToKelvin(values[s.temp], TEMP_RANGE, s.tempMax!) : undefined,
  };
}

// ---- transport ------------------------------------------------------------

interface Transport {
  read(): Promise<Record<string, any>>;
  write(values: Record<string, unknown>): Promise<void>;
}

function transportFor(device: Device, ctx: DriverContext): Transport {
  const { transport, gwId, localKey, version } = device.config;
  if (transport === 'local') {
    const t = new TuyaLocal(device.address, gwId, localKey, version);
    return { read: () => t.query(), write: (v) => t.set(v) };
  }
  const creds = ctx.credentials.get<TuyaCloudCreds>(CLOUD_CRED);
  if (!creds) throw new DeviceError('Tuya cloud credentials are missing', 'Run: iot setup');
  const cloud = new TuyaCloud(creds);
  return {
    read: () => cloud.status(gwId),
    write: (v) => cloud.command(gwId, Object.entries(v).map(([code, value]) => ({ code, value }))),
  };
}

// ---- configuration --------------------------------------------------------

/** Turn a broadcast (+ optional key / cloud access) into a ready device if we can. */
async function configure(info: BroadcastInfo, ctx: DriverContext, opts: { localKey?: string; cloud?: TuyaCloud }): Promise<Discovered> {
  const base: Discovered = {
    id: `tuya:${info.gwId}`,
    driver: 'tuya',
    name: `Tuya device ${info.gwId.slice(-4)}`,
    kind: 'other',
    address: info.ip,
    capabilities: [],
    status: 'needs_setup',
    statusReason: 'Needs its Tuya local key (one-time cloud login)',
    config: { gwId: info.gwId, version: info.version, productKey: info.productKey },
  };

  let localKey = opts.localKey;
  let cloudInfo: Awaited<ReturnType<TuyaCloud['device']>> | undefined;
  if (opts.cloud) {
    try {
      cloudInfo = await opts.cloud.device(info.gwId);
      localKey ??= cloudInfo.local_key;
      base.name = cloudInfo.name || base.name;
      base.model = cloudInfo.product_name;
    } catch (e: any) {
      ctx.debug(`tuya cloud lookup for ${info.gwId} failed: ${e.message}`);
    }
  }
  if (!localKey && !opts.cloud) return base;

  // Prefer local control; fall back to cloud for protocols we can't speak.
  if (localKey && info.version === '3.3') {
    try {
      const dps = await new TuyaLocal(info.ip, info.gwId, localKey, info.version).query();
      const schema = schemaFromDps(dps);
      if (schema) {
        return {
          ...base,
          kind: schema.kind,
          capabilities: capsOf(schema),
          colorTempRange: schema.temp ? TEMP_RANGE : undefined,
          status: 'ready',
          statusReason: undefined,
          config: { ...base.config, transport: 'local', localKey, schema },
          state: toState(dps, schema),
        };
      }
      ctx.debug(`tuya ${info.gwId}: unrecognised datapoints ${JSON.stringify(dps)}`);
    } catch (e: any) {
      ctx.debug(`tuya local query ${info.gwId} failed: ${e.message}`);
      if (!opts.cloud) return { ...base, statusReason: e.message, config: { ...base.config, localKey } };
    }
  }

  if (opts.cloud && cloudInfo) {
    const schema = schemaFromFunctions(cloudInfo.category, await opts.cloud.functions(info.gwId));
    if (schema) {
      return {
        ...base,
        kind: schema.kind,
        capabilities: capsOf(schema),
        colorTempRange: schema.temp ? TEMP_RANGE : undefined,
        status: 'ready',
        statusReason: undefined,
        config: { ...base.config, transport: 'cloud', localKey, schema },
      };
    }
  }

  return {
    ...base,
    status: 'unsupported',
    statusReason: info.version !== '3.3' ? `Tuya protocol ${info.version} — set up cloud access to control it` : 'Device type not supported yet',
  };
}

function cloudFrom(ctx: DriverContext) {
  const creds = ctx.credentials.get<TuyaCloudCreds>(CLOUD_CRED);
  return creds ? new TuyaCloud(creds) : undefined;
}

async function listenForBroadcasts(timeoutMs: number) {
  const found = new Map<string, BroadcastInfo>();
  const onMsg = (msg: Buffer, rinfo: { address: string }) => {
    const info = decodeBroadcast(msg);
    if (info?.gwId) found.set(info.gwId, { ...info, ip: info.ip ?? rinfo.address, version: String(info.version ?? '3.3') });
  };
  await Promise.all([udpListen(6666, timeoutMs, onMsg), udpListen(6667, timeoutMs, onMsg)]);
  return found;
}

export const tuya: Driver = {
  id: 'tuya',
  name: 'Tuya / Smart Life',
  kinds: ['light', 'plug', 'switch', 'dimmer'],
  troubleshooting: [
    'Tuya devices announce themselves every few seconds — scan longer if some are missing: iot scan --timeout 15',
    'Close the Smart Life / Tuya app on your phone while controlling locally: devices accept only one local connection at a time.',
    'Local keys change when a device is re-paired in the app — re-run: iot setup <device>',
    'Newer firmware (protocol 3.4/3.5) is controlled through the Tuya cloud for now.',
  ],

  async discover(ctx: DiscoveryContext) {
    const broadcasts = await listenForBroadcasts(ctx.timeoutMs);
    const cloud = cloudFrom(ctx);
    const stored = new Map(ctx.devices().map((d) => [d.config.gwId, d]));
    return settleAll(
      [...broadcasts.values()].map(async (info) => {
        const known = stored.get(info.gwId);
        // Already configured: keep its schema, just refresh the address.
        if (known?.status === 'ready' && known.config.version === info.version) {
          const { lastSeen, nameSource, ...rest } = known;
          return { ...rest, address: info.ip };
        }
        return configure(info, ctx, { cloud, localKey: known?.config.localKey });
      })
    );
  },

  async setup(device: Device, io: SetupIO, ctx: DriverContext) {
    io.steps('Tuya devices encrypt their local traffic', [
      'Each device has a secret "local key" that only Tuya\'s cloud knows.',
      'I can fetch the keys for ALL your Tuya devices in one go using a free Tuya IoT developer project.',
      'After that, control is fully local — the cloud is only used if a device\'s firmware is too new.',
    ]);
    const method = await io.choose('How do you want to continue?', [
      { label: 'Log in with Tuya IoT Platform credentials', value: 'cloud', hint: 'recommended, ~5 minutes once' },
      { label: 'I already have the local key for this device', value: 'key' },
      { label: 'Skip for now', value: 'skip' },
    ]);
    if (method === 'skip') return [device];

    const info: BroadcastInfo = { ip: device.address, gwId: device.config.gwId, version: device.config.version ?? '3.3' };

    if (method === 'key') {
      const localKey = await io.ask('Local key (16 characters)', {
        secret: true,
        validate: (v) => (Buffer.byteLength(v) === 16 ? undefined : 'The local key is exactly 16 characters'),
      });
      const result = await io.wait('Connecting to the device…', () => configure(info, ctx, { localKey, cloud: cloudFrom(ctx) }));
      result.status === 'ready' ? io.success(`Connected to ${result.name}`) : io.warn(result.statusReason ?? 'Could not connect');
      return [result];
    }

    io.steps('Create a Tuya IoT cloud project (one time)', [
      'Go to https://iot.tuya.com and sign up (free).',
      'Cloud → Development → Create Cloud Project. Industry: Smart Home. Data center: the one matching your app\'s region.',
      'When asked for API services, keep the defaults (IoT Core, Authorization). If IoT Core shows "trial expired", renew it — it\'s free.',
      'Open the project → Devices → Link App Account → Add App Account. Scan the QR code with the Smart Life / Tuya app (Me → scan icon top-right).',
      'Open the project\'s Overview tab — copy the Access ID and Access Secret.',
    ]);

    let cloud: TuyaCloud | undefined;
    for (let attempt = 0; attempt < 3 && !cloud; attempt++) {
      const accessId = await io.ask('Access ID / Client ID');
      const accessSecret = await io.ask('Access Secret / Client Secret', { secret: true });
      const region = await io.choose('Data center', REGIONS.map((r) => ({ label: r.label, value: r.value })));
      const candidate = new TuyaCloud({ accessId, accessSecret, region });
      try {
        await io.wait('Checking credentials…', () => candidate.verify());
        ctx.credentials.set(CLOUD_CRED, { accessId, accessSecret, region });
        cloud = candidate;
      } catch (e: any) {
        io.warn(e.message + (e.hint ? `\n  → ${e.hint}` : ''));
      }
    }
    if (!cloud) return [device];

    // Configure every Tuya device we know about, not just this one.
    const pending = [device, ...ctx.devices().filter((d) => d.id !== device.id && d.status !== 'ready')];
    const results = await io.wait(`Fetching keys for ${pending.length} device(s)…`, () =>
      settleAll(pending.map((d) => configure({ ip: d.address, gwId: d.config.gwId, version: d.config.version ?? '3.3' }, ctx, { cloud })))
    );
    for (const r of results) {
      if (r.status === 'ready') io.success(`${r.name}: ready (${r.config.transport})`);
      else io.warn(`${r.name}: ${r.statusReason}`);
    }
    return results;
  },

  async getState(device, ctx) {
    return toState(await transportFor(device, ctx).read(), device.config.schema);
  },

  async execute(device, cmd: Command, ctx) {
    const s: Schema = device.config.schema;
    const t = transportFor(device, ctx);
    const values: Record<string, unknown> = {};
    switch (cmd.type) {
      case 'power':
        values[s.power] = cmd.on;
        break;
      case 'toggle':
        values[s.power] = !(await t.read())[s.power];
        break;
      case 'brightness': {
        if (cmd.value <= 0) {
          values[s.power] = false;
          break;
        }
        if (!s.bright) throw new DeviceError('This device is not dimmable');
        values[s.power] = true;
        const current = s.mode ? await t.read() : {};
        // In colour mode brightness lives inside the colour value.
        if (s.mode && current[s.mode] === 'colour' && s.colour) {
          const c = decodeColour(current[s.colour], s.colourFormat);
          if (c) values[s.colour] = encodeColour(c.rgb, s.colourFormat, cmd.value);
        } else {
          values[s.bright] = scaleBright(cmd.value, s.brightRange!);
        }
        break;
      }
      case 'color':
        if (!s.colour) throw new DeviceError('This device has no colour support');
        Object.assign(values, { [s.power]: true, ...(s.mode ? { [s.mode]: 'colour' } : {}), [s.colour]: encodeColour(cmd.rgb, s.colourFormat) });
        break;
      case 'color_temp':
        if (!s.temp) throw new DeviceError('This device has no colour temperature support');
        Object.assign(values, { [s.power]: true, ...(s.mode ? { [s.mode]: 'white' } : {}), [s.temp]: kelvinToScale(cmd.kelvin, TEMP_RANGE, s.tempMax!) });
        break;
      default:
        throw new DeviceError(`Tuya doesn't support "${cmd.type}" yet`);
    }
    await t.write(values);
  },
};
