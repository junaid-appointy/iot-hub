import { Device, DeviceState, UnknownHost } from '../core/types';
import { toHex } from '../util/color';

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  cyan: wrap(36),
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function swatch(hex: string) {
  if (!useColor) return hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m●\x1b[0m ${hex}`;
}

export function table(rows: string[][], header?: string[]) {
  const all = header ? [header.map((h) => c.dim(h)), ...rows] : rows;
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => strip(r[i] ?? '').length)));
  for (const row of all) console.log('  ' + row.map((cell, i) => cell + ' '.repeat(widths[i] - strip(cell).length)).join('  ').trimEnd());
}

export function describeState(d: Device, s?: DeviceState): string {
  if (d.status === 'needs_setup') return c.yellow('⚠ needs setup') + c.dim(d.statusReason ? ` — ${d.statusReason}` : '');
  if (d.status === 'unsupported') return c.red('✗ unsupported') + c.dim(d.statusReason ? ` — ${d.statusReason}` : '');
  if (!s) return c.dim('—');
  if (!s.online) return c.red('offline');
  const parts = [s.on ? c.green('● on') : c.dim('○ off')];
  if (s.on) {
    if (s.brightness !== undefined && d.capabilities.includes('brightness')) parts.push(`${s.brightness}%`);
    if (s.scene) parts.push(s.scene);
    else if (s.color) parts.push(swatch(toHex(s.color)));
    else if (s.colorTemp) parts.push(`${s.colorTemp}K`);
  }
  return parts.join(' ');
}

const BRANDS: Record<string, string> = {
  wiz: 'WiZ',
  hue: 'Hue',
  kasa: 'Kasa',
  yeelight: 'Yeelight',
  lifx: 'LIFX',
  tuya: 'Tuya',
  shelly: 'Shelly',
  wled: 'WLED',
  nanoleaf: 'Nanoleaf',
};

export function deviceTable(devices: Device[], states: Map<string, DeviceState>, indexOf: (d: Device) => number) {
  table(
    devices.map((d) => [c.dim(String(indexOf(d))), c.bold(d.name), d.kind, BRANDS[d.driver] ?? d.driver, d.address, describeState(d, states.get(d.id))]),
    ['#', 'NAME', 'TYPE', 'BRAND', 'ADDRESS', 'STATE']
  );
}

export function unknownTable(hosts: UnknownHost[]) {
  table(hosts.map((h) => [h.address, h.name ?? c.dim('(unnamed)'), c.dim(h.hints.join(', ') || h.services.slice(0, 3).join(', '))]));
}
