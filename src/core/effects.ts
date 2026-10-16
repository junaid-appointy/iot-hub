import { hsvToRgb } from '../util/color';
import { Hub } from './hub';
import { Command, Device } from './types';

/**
 * Light effects driven from the hub (so all bulbs stay in sync).
 * Each tick computes one `set` command per device from its capabilities —
 * colour bulbs get colours, white-only bulbs get brightness/temperature
 * patterns — and sends it fire-and-forget. A device whose previous frame is
 * still in flight skips the tick, so slow or weak-signal bulbs can't build a queue.
 */

export type EffectName = 'club';

export interface EffectStatus {
  running: boolean;
  effect?: EffectName;
  devices: number;
  startedAt?: string;
  stopsAt?: string;
}

const MAX_RUN_MS = 30 * 60_000;
const TICK_MS = 450;

function clubFrame(device: Device, index: number, count: number, tick: number): Command {
  const caps = new Set(device.capabilities);
  const [minK, maxK] = device.colorTempRange ?? [2700, 6500];
  const beat = tick % 8 === 0; // every ~3.6 s the whole room flashes together
  const head = tick % count; // a bright "chase" running around the room
  const dist = Math.min(Math.abs(index - head), count - Math.abs(index - head));
  const sparkle = Math.random() < 0.12;

  if (caps.has('color')) {
    const hue = (tick * 23 + (index * 360) / count + Math.random() * 40) % 360;
    return { type: 'set', on: true, brightness: beat || dist === 0 ? 100 : 45 + Math.random() * 45, rgb: hsvToRgb(hue, 1, 1) };
  }
  if (beat || dist === 0 || sparkle) return { type: 'set', on: true, brightness: 100, kelvin: maxK };
  if (dist === 1) return { type: 'set', on: true, brightness: 55, kelvin: Math.round((minK + maxK) / 2) };
  return { type: 'set', on: true, brightness: 10 + Math.round(Math.random() * 15), kelvin: minK };
}

export class EffectRunner {
  private timer?: NodeJS.Timeout;
  private stopTimer?: NodeJS.Timeout;
  private inflight = new Set<string>();
  private devices: Device[] = [];
  private status: EffectStatus = { running: false, devices: 0 };

  constructor(private hub: Hub) {}

  start(effect: EffectName, devices: Device[]) {
    this.stop();
    this.devices = devices.filter((d) => d.status === 'ready' && d.capabilities.includes('power'));
    if (!this.devices.length) return this.getStatus();
    let tick = 0;
    const frame = () => {
      tick++;
      this.devices.forEach((d, i) => {
        if (this.inflight.has(d.id)) return;
        this.inflight.add(d.id);
        this.hub
          .run(d, clubFrame(d, i, this.devices.length, tick), { fast: true })
          .catch(() => {})
          .finally(() => this.inflight.delete(d.id));
      });
    };
    frame();
    this.timer = setInterval(frame, TICK_MS);
    this.stopTimer = setTimeout(() => this.stop(), MAX_RUN_MS);
    const now = Date.now();
    this.status = {
      running: true,
      effect,
      devices: this.devices.length,
      startedAt: new Date(now).toISOString(),
      stopsAt: new Date(now + MAX_RUN_MS).toISOString(),
    };
    return this.getStatus();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.stopTimer);
    this.timer = this.stopTimer = undefined;
    this.status = { running: false, devices: 0 };
    return this.getStatus();
  }

  getStatus(): EffectStatus {
    return { ...this.status };
  }

  /** Wait for in-flight frames so a following "all white" isn't overwritten by a late frame. */
  async drain(timeoutMs = 1600) {
    const end = Date.now() + timeoutMs;
    while (this.inflight.size && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  }
}
