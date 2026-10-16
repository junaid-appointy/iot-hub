import fs from 'fs';
import os from 'os';
import path from 'path';
import { CredentialStore, Device } from './types';

interface StoreData {
  version: 1;
  devices: Device[];
  /** Pairing tokens, passwords, cloud keys — file is chmod 600. */
  credentials: Record<string, unknown>;
}

/** JSON file at ~/.iot-hub/state.json (override the dir with IOT_HUB_HOME). */
export class Store {
  readonly file: string;
  private data: StoreData;

  constructor(dir = process.env.IOT_HUB_HOME ?? path.join(os.homedir(), '.iot-hub')) {
    this.file = path.join(dir, 'state.json');
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
