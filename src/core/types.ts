/**
 * Generic device model.
 *
 * Every device — whatever brand or protocol — is described by the same shape:
 * a kind, a list of capabilities, and a driver-specific `config` blob. Callers
 * only ever speak in generic Commands; drivers translate them to the wire
 * protocol. Adding a new device category (locks, sensors, thermostats…) means
 * adding capabilities/commands here, not changing the hub or the CLI plumbing.
 */

export type DeviceKind = 'light' | 'plug' | 'switch' | 'dimmer' | 'hub' | 'sensor' | 'other';

export type Capability =
  | 'power' //       on / off / toggle
  | 'brightness' //  0-100 %
  | 'color' //       RGB
  | 'color_temp' //  Kelvin
  | 'scene'; //      named presets

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface DeviceState {
  online: boolean;
  on?: boolean;
  brightness?: number;
  color?: RGB;
  colorTemp?: number;
  scene?: string;
  /** Brand-specific extras (power usage, rssi, mode…). */
  extra?: Record<string, unknown>;
}

export type Command =
  | { type: 'power'; on: boolean }
  | { type: 'toggle' }
  | { type: 'brightness'; value: number }
  | { type: 'color'; rgb: RGB }
  | { type: 'color_temp'; kelvin: number }
  | { type: 'scene'; scene: string }
  /** Several attributes in one go. Fields the device can't do are dropped by the hub. */
  | { type: 'set'; on?: boolean; brightness?: number; kelvin?: number; rgb?: RGB };

export type DeviceStatus = 'ready' | 'needs_setup' | 'unsupported';

export interface Device {
  /** Stable id: `<driver>:<unique id from the device>` (usually MAC/serial). */
  id: string;
  driver: string;
  name: string;
  /** 'user' once renamed, so rescans don't overwrite it. */
  nameSource?: 'device' | 'user';
  kind: DeviceKind;
  model?: string;
  /** IP address (may change; refreshed on every scan). */
  address: string;
  mac?: string;
  capabilities: Capability[];
  colorTempRange?: [number, number];
  scenes?: string[];
  status: DeviceStatus;
  /** Shown to the user when status isn't 'ready'. */
  statusReason?: string;
  /** Driver-private settings: channel ids, protocol versions, keys, etc. */
  config: Record<string, any>;
  lastSeen?: string;
}

/** What a driver returns from discovery. State is optional (saves a round trip). */
export interface Discovered extends Omit<Device, 'lastSeen' | 'nameSource'> {
  state?: DeviceState;
}

/**
 * Interactive channel used by drivers during setup. The CLI implements it with
 * readline; a web UI could implement it over a websocket.
 */
export interface SetupIO {
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  /** Numbered instructions for the user to follow. */
  steps(title: string, steps: string[]): void;
  ask(question: string, opts?: { default?: string; secret?: boolean; validate?: (v: string) => string | undefined }): Promise<string>;
  confirm(question: string, def?: boolean): Promise<boolean>;
  choose<T>(question: string, options: Array<{ label: string; value: T; hint?: string }>): Promise<T>;
  /** Show a live countdown/progress line while `task` runs. */
  wait<T>(message: string, task: (update: (msg: string) => void) => Promise<T>): Promise<T>;
}

export interface CredentialStore {
  get<T = any>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export interface DriverContext {
  credentials: CredentialStore;
  /** All stored devices of this driver (e.g. Tuya setup fixes every Tuya device at once). */
  devices(): Device[];
  debug(message: string): void;
  /** Fire-and-forget for effects: no retries, short timeouts. */
  fast?: boolean;
}

export interface MdnsHost {
  address: string;
  hostnames: string[];
  /** Service types, e.g. `_hue._tcp.local`. */
  services: string[];
  /** Instance name → { port, txt } */
  instances: Record<string, { service: string; port?: number; txt: Record<string, string> }>;
}

export interface SsdpHost {
  address: string;
  headers: Record<string, string>[];
}

export interface DiscoveryContext extends DriverContext {
  timeoutMs: number;
  broadcastAddresses: string[];
  /** Shared, memoized network scans — any driver can await them. */
  mdns(): Promise<MdnsHost[]>;
  ssdp(): Promise<SsdpHost[]>;
}

export interface Driver {
  id: string;
  name: string;
  /** What kinds of devices this driver can produce (for docs / filtering). */
  kinds: DeviceKind[];
  /** Tips shown by `iot guide <driver>` when a device isn't found or won't connect. */
  troubleshooting: string[];

  discover(ctx: DiscoveryContext): Promise<Discovered[]>;
  /** Identify a device at a known IP (manual add, or when broadcasts are blocked). */
  probe?(ip: string, ctx: DriverContext): Promise<Discovered[]>;
  /**
   * Guided setup for devices with status 'needs_setup'. Returns the devices
   * that now exist as a result (a Hue bridge turns into N lights, for example).
   * The input device is removed if it isn't part of the returned list.
   */
  setup?(device: Device, io: SetupIO, ctx: DriverContext): Promise<Discovered[]>;

  getState(device: Device, ctx: DriverContext): Promise<DeviceState>;
  execute(device: Device, command: Command, ctx: DriverContext): Promise<void>;
  /** True if `execute` handles { type: 'set' } in one round trip; otherwise the hub splits it. */
  nativeSet?: boolean;
  /**
   * Fire-and-forget send for real-time effects: no ack, no retry, returns
   * immediately. Lost packets are repaired by the caller re-sending state.
   */
  stream?(device: Device, command: Extract<Command, { type: 'set' }>): void;
}

/** A host seen on the network that no driver claimed. */
export interface UnknownHost {
  address: string;
  name?: string;
  hints: string[];
  services: string[];
}

export class DeviceError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}
