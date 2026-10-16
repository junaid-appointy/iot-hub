import { describeUnknownHosts } from '../discovery/identify';
import { scanMdns } from '../discovery/mdns';
import { scanSsdp } from '../discovery/ssdp';
import { builtInDrivers } from '../drivers';
import { broadcastAddresses, localIPv4, settleAll, tcpPortOpen, withTimeout } from '../util/net';
import { Store } from './store';
import {
  Capability,
  Command,
  Device,
  DeviceError,
  DeviceState,
  Discovered,
  DiscoveryContext,
  Driver,
  DriverContext,
  MdnsHost,
  SetupIO,
  SsdpHost,
  UnknownHost,
} from './types';

export interface ScanResult {
  devices: Device[];
  added: Device[];
  states: Map<string, DeviceState>;
  unknown: UnknownHost[];
  errors: Array<{ driver: string; message: string }>;
}

const REQUIRED: Record<Command['type'], Capability> = {
  power: 'power',
  toggle: 'power',
  brightness: 'brightness',
  color: 'color',
  color_temp: 'color_temp',
  scene: 'scene',
  set: 'power',
};

/** Signal at or below which Wi-Fi bulbs start losing packets. */
export const WEAK_SIGNAL_DBM = -78;

/** Ports that hint at a brand when `iot add <ip>` can't identify a device. */
const PORT_HINTS: Array<[number, string]> = [
  [6668, 'Tuya / Smart Life device — it will show up in `iot scan` once it broadcasts (try --timeout 15)'],
  [9999, 'TP-Link Kasa (legacy protocol)'],
  [20002, 'TP-Link Kasa/Tapo with new KLAP firmware — not supported yet'],
  [55443, 'Yeelight'],
  [16021, 'Nanoleaf'],
  [9123, 'Elgato light — no driver yet'],
  [8008, 'Google Cast device'],
  [1400, 'Sonos speaker'],
  [80, 'Has a web UI — try opening http://<ip> in a browser'],
];

/**
 * The hub owns the device registry and is the only thing callers talk to.
 * It fans discovery out to every driver, merges results into the store,
 * runs guided setup, and dispatches generic commands.
 */
export class Hub {
  private debugEnabled = !!process.env.IOT_DEBUG;
  /** Last good state + consecutive misses, so one dropped UDP reply doesn't flip a device offline. */
  private lastGood = new Map<string, DeviceState>();
  private misses = new Map<string, number>();
  static readonly OFFLINE_AFTER_MISSES = 3;

  constructor(
    readonly store = new Store(),
    readonly drivers: Driver[] = builtInDrivers
  ) {}

  driver(id: string): Driver {
    const d = this.drivers.find((x) => x.id === id);
    if (!d) throw new DeviceError(`No driver named "${id}"`, `Available: ${this.drivers.map((x) => x.id).join(', ')}`);
    return d;
  }

  devices(): Device[] {
    return [...this.store.devices].sort((a, b) => a.name.localeCompare(b.name));
  }

  context(driverId: string, fast = false): DriverContext {
    return {
      fast,
      credentials: this.store.credentials(),
      devices: () => this.store.devices.filter((d) => d.driver === driverId),
      debug: (m) => this.debugEnabled && console.error(`[${driverId}] ${m}`),
    };
  }

  async scan(opts: { timeoutMs?: number; onDriverDone?: (driver: Driver, found: number, error?: string) => void } = {}): Promise<ScanResult> {
    const timeoutMs = opts.timeoutMs ?? 6000;
    let mdnsP: Promise<MdnsHost[]> | undefined;
    let ssdpP: Promise<SsdpHost[]> | undefined;
    const mdns = () => (mdnsP ??= scanMdns(Math.min(timeoutMs, 4000)));
    const ssdp = () => (ssdpP ??= scanSsdp(Math.min(timeoutMs, 4000)));
    const broadcast = broadcastAddresses();

    const errors: ScanResult['errors'] = [];
    const perDriver = await Promise.all(
      this.drivers.map(async (driver) => {
        const ctx: DiscoveryContext = { ...this.context(driver.id), timeoutMs, broadcastAddresses: broadcast, mdns, ssdp };
        try {
          // Discovery plus per-device identification must finish in bounded time.
          const found = await withTimeout(driver.discover(ctx), timeoutMs + 8000, `${driver.name} discovery timed out`);
          opts.onDriverDone?.(driver, found.length);
          return found;
        } catch (e: any) {
          errors.push({ driver: driver.id, message: e.message });
          opts.onDriverDone?.(driver, 0, e.message);
          return [];
        }
      })
    );

    const discovered = perDriver.flat();
    const before = new Set(this.store.devices.map((d) => d.id));
    const states = this.upsert(discovered);

    // Setup placeholders that weren't seen again are stale (e.g. a Hue bridge now expanded into lights).
    const seen = new Set(discovered.map((d) => d.id));
    this.store.devices = this.store.devices.filter((d) => d.status === 'ready' || seen.has(d.id));
    this.store.save();

    const claimed = new Set(discovered.map((d) => d.address));
    const self = localIPv4();
    if (self) claimed.add(self);
    const unknown = await describeUnknownHosts(await mdns(), await ssdp(), claimed);

    return {
      devices: this.devices(),
      added: this.devices().filter((d) => !before.has(d.id)),
      states,
      unknown,
      errors,
    };
  }

  /** Merge discovered devices into the store; returns any state that came along. */
  upsert(discovered: Discovered[]): Map<string, DeviceState> {
    const states = new Map<string, DeviceState>();
    const now = new Date().toISOString();
    for (const d of discovered) {
      const { state, ...rest } = d;
      if (state) {
        states.set(d.id, state);
        this.lastGood.set(d.id, state);
        this.misses.set(d.id, 0);
      }
      const i = this.store.devices.findIndex((x) => x.id === d.id);
      const existing = i >= 0 ? this.store.devices[i] : undefined;
      const merged: Device = {
        ...existing,
        ...rest,
        name: existing?.nameSource === 'user' ? existing.name : rest.name,
        nameSource: existing?.nameSource ?? 'device',
        config: { ...existing?.config, ...rest.config },
        lastSeen: now,
      };
      if (i >= 0) this.store.devices[i] = merged;
      else this.store.devices.push(merged);
    }
    this.store.save();
    return states;
  }

  /** Run a driver's guided setup; replaces the device with whatever setup produced. */
  async setup(device: Device, io: SetupIO): Promise<Device[]> {
    const driver = this.driver(device.driver);
    if (!driver.setup) throw new DeviceError(`${driver.name} devices don't need setup`);
    const result = await driver.setup(device, io, this.context(driver.id));
    const ids = new Set(result.map((d) => d.id));
    if (!ids.has(device.id)) this.store.devices = this.store.devices.filter((d) => d.id !== device.id);
    this.upsert(result);
    return this.store.devices.filter((d) => ids.has(d.id));
  }

  /** Identify whatever is at `ip`. Tries every driver (or one) in parallel. */
  async probe(ip: string, driverId?: string): Promise<{ devices: Device[]; hints: string[] }> {
    const drivers = driverId ? [this.driver(driverId)] : this.drivers.filter((d) => d.probe);
    const found = (
      await settleAll(drivers.map((d) => withTimeout(d.probe!(ip, this.context(d.id)), 6000).then((r) => r, () => [] as Discovered[])))
    ).flat();
    if (found.length) {
      this.upsert(found);
      const ids = new Set(found.map((d) => d.id));
      return { devices: this.store.devices.filter((d) => ids.has(d.id)), hints: [] };
    }
    const open = await Promise.all(PORT_HINTS.map(async ([port, hint]) => ((await tcpPortOpen(ip, port)) ? `port ${port} open → ${hint}` : undefined)));
    return { devices: [], hints: open.filter((h): h is string => !!h) };
  }

  /**
   * Resolve a user-typed selector: "all", "lights", a list index (1-based),
   * an id, an exact name, or a unique name fragment.
   */
  find(selector: string): Device[] {
    const all = this.devices();
    const s = selector.trim().toLowerCase();
    if (s === 'all') return all.filter((d) => d.status === 'ready');
    const kindPlural: Record<string, string> = { lights: 'light', plugs: 'plug', switches: 'switch', dimmers: 'dimmer' };
    if (kindPlural[s]) return all.filter((d) => d.status === 'ready' && d.kind === kindPlural[s]);
    if (/^\d+$/.test(s) && all[Number(s) - 1]) return [all[Number(s) - 1]];
    const exact = all.filter((d) => d.id.toLowerCase() === s || d.name.toLowerCase() === s);
    if (exact.length) return exact;
    return all.filter((d) => d.name.toLowerCase().includes(s) || d.id.toLowerCase().includes(s));
  }

  async state(device: Device): Promise<DeviceState> {
    if (device.status !== 'ready') return { online: false };
    try {
      const s = await withTimeout(this.driver(device.driver).getState(device, this.context(device.driver)), 8000, 'No response');
      this.lastGood.set(device.id, s);
      this.misses.set(device.id, 0);
      return s;
    } catch {
      const misses = (this.misses.get(device.id) ?? 0) + 1;
      this.misses.set(device.id, misses);
      const last = this.lastGood.get(device.id);
      return last && misses < Hub.OFFLINE_AFTER_MISSES ? last : { online: false };
    }
  }

  /**
   * Send a command. `fast` is for effects: one attempt, short timeout, and a
   * failure doesn't mark the device offline (the next frame replaces it anyway).
   */
  async run(device: Device, command: Command, opts: { fast?: boolean } = {}): Promise<void> {
    if (device.status !== 'ready') {
      throw new DeviceError(`${device.name} isn't set up yet${device.statusReason ? `: ${device.statusReason}` : ''}`, `Run: iot setup "${device.name}"`);
    }
    const need = REQUIRED[command.type];
    if (!device.capabilities.includes(need)) {
      throw new DeviceError(`${device.name} doesn't support ${need.replace('_', ' ')}`, `It supports: ${device.capabilities.join(', ') || 'nothing yet'}`);
    }
    const driver = this.driver(device.driver);
    const ctx = this.context(driver.id, opts.fast);
    try {
      const timeout = opts.fast ? 1500 : 10000;
      await withTimeout(this.dispatch(driver, device, command, ctx), timeout, `${device.name} did not respond`);
      this.misses.set(device.id, 0);
    } catch (e: any) {
      if (opts.fast || e instanceof DeviceError) throw e;
      if (/EHOSTUNREACH|ENETUNREACH|unreachable|No response|did not respond|Timed out|refused/i.test(e.message)) {
        const rssi = this.lastGood.get(device.id)?.extra?.rssi;
        if (typeof rssi === 'number' && rssi <= WEAK_SIGNAL_DBM) {
          // Weak link: packets were lost, but the bulb is probably still there.
          throw new DeviceError(
            `${device.name} didn't get the command (weak Wi-Fi, ${rssi} dBm)`,
            'Its signal is too weak, so many packets are lost. Try again, or move the router/extender closer to this bulb.'
          );
        }
        // Show it as offline right away instead of waiting for the next few polls.
        this.misses.set(device.id, Hub.OFFLINE_AFTER_MISSES);
        throw new DeviceError(
          `${device.name} isn't responding`,
          'It may be switched off at the wall or out of Wi-Fi range. If it was re-plugged, its IP may have changed. Scan again.'
        );
      }
      throw new DeviceError(`${device.name}: ${e.message}`);
    }
  }

  /** Adapt a command to the device: drop unsupported `set` fields, split `set` for drivers without native support. */
  private async dispatch(driver: Driver, device: Device, command: Command, ctx: DriverContext) {
    if (command.type !== 'set') return driver.execute(device, command, ctx);
    const has = (c: Capability) => device.capabilities.includes(c);
    const set = {
      type: 'set' as const,
      on: command.on,
      brightness: has('brightness') ? command.brightness : undefined,
      kelvin: has('color_temp') ? command.kelvin : undefined,
      rgb: has('color') ? command.rgb : undefined,
    };
    if (set.rgb) set.kelvin = undefined;
    if (driver.nativeSet) return driver.execute(device, set, ctx);
    if (set.on === false) return driver.execute(device, { type: 'power', on: false }, ctx);
    if (set.on) await driver.execute(device, { type: 'power', on: true }, ctx);
    if (set.brightness !== undefined) await driver.execute(device, { type: 'brightness', value: set.brightness }, ctx);
    if (set.rgb) await driver.execute(device, { type: 'color', rgb: set.rgb }, ctx);
    if (set.kelvin !== undefined) await driver.execute(device, { type: 'color_temp', kelvin: set.kelvin }, ctx);
  }

  rename(device: Device, name: string) {
    Object.assign(this.store.devices.find((d) => d.id === device.id)!, { name, nameSource: 'user' });
    this.store.save();
  }

  remove(device: Device) {
    this.store.devices = this.store.devices.filter((d) => d.id !== device.id);
    this.store.save();
  }
}
