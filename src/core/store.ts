import fs from 'fs';
import os from 'os';
import path from 'path';
import { MatrixLayout, sequence } from './matrix';
import { CredentialStore, Device } from './types';

interface StoreData {
  version: 1;
  devices: Device[];
  /** Pairing tokens, passwords, cloud keys — file is chmod 600. */
  credentials: Record<string, unknown>;
}

/**
 * Layouts live in the repo (layouts/<id>.json), not in ~/.iot-hub: they describe
 * a physical installation (which bulb hangs where) and are meant to be versioned
 * and reused by future features. Override the folder with IOT_HUB_LAYOUTS.
 */
const REPO_LAYOUT_DIR = path.resolve(__dirname, '..', '..', 'layouts');
export const DEFAULT_LAYOUT_ID = 'auditorium';

/** JSON file at ~/.iot-hub/state.json (override the dir with IOT_HUB_HOME). */
export class Store {
  readonly file: string;
  /** Where layouts are read/written. */
  readonly layoutDir: string;
  private data: StoreData;

  /**
   * `dir` given explicitly (tests, tools) means a sandbox: its layouts live in
   * `<dir>/layouts`, never in the repo. Only the default store writes the repo's
   * layouts/ folder (or IOT_HUB_LAYOUTS when set).
   */
  constructor(dir?: string) {
    const home = dir ?? process.env.IOT_HUB_HOME ?? path.join(os.homedir(), '.iot-hub');
    this.file = path.join(home, 'state.json');
    this.layoutDir = process.env.IOT_HUB_LAYOUTS ?? (dir ? path.join(dir, 'layouts') : REPO_LAYOUT_DIR);
    this.data = this.load();
  }

  private load(): StoreData {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { version: 1, devices: parsed.devices ?? [], credentials: parsed.credentials ?? {} };
    } catch {
      return { version: 1, devices: [], credentials: {} };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get devices(): Device[] {
    return this.data.devices;
  }

  set devices(devices: Device[]) {
    this.data.devices = devices;
  }

  layoutFile(id = DEFAULT_LAYOUT_ID) {
    return path.join(this.layoutDir, `${id.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  }

  layout(id = DEFAULT_LAYOUT_ID): MatrixLayout | undefined {
    try {
      const { bulbs, ...layout } = JSON.parse(fs.readFileSync(this.layoutFile(id), 'utf8'));
      return layout;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes the layout plus a derived, human-readable `bulbs` list (number,
   * row/col, MAC, model, last IP) so other tools can use the file directly.
   */
  saveLayout(layout: MatrixLayout) {
    const devices = new Map(this.data.devices.map((d) => [d.id, d]));
    const bulbs = sequence(layout).map(([r, c], i) => {
      const id = layout.cells[r][c];
      const d = id ? devices.get(id) : undefined;
      return {
        number: i + 1,
        row: r + 1,
        col: c + 1,
        id,
        mac: d?.mac ?? null,
        name: d?.name ?? null,
        model: d?.model ?? null,
        brand: d?.driver ?? null,
        lastKnownIp: d?.address ?? null,
      };
    });
    const doc = {
      $comment: 'Physical bulb layout. `cells` and `numbering` are the source of truth (row 0 = top, col 0 = left); `bulbs` is regenerated from them on every save. Devices are identified by MAC; IPs can change.',
      ...layout,
      updatedAt: new Date().toISOString(),
      bulbs,
    };
    fs.mkdirSync(this.layoutDir, { recursive: true });
    const file = this.layoutFile(layout.id);
    fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
  }

  credentials(): CredentialStore {
    return {
      get: <T>(key: string) => this.data.credentials[key] as T | undefined,
      set: (key, value) => {
        this.data.credentials[key] = value;
        this.save();
      },
      delete: (key) => {
        delete this.data.credentials[key];
        this.save();
      },
    };
  }
}
