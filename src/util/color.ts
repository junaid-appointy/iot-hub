import { RGB } from '../core/types';

const NAMED: Record<string, string> = {
  red: 'ff0000',
  green: '00ff00',
  blue: '0000ff',
  white: 'ffffff',
  yellow: 'ffd700',
  orange: 'ff8000',
  amber: 'ffbf00',
  purple: '8000ff',
  violet: 'ee82ee',
  magenta: 'ff00ff',
  pink: 'ff69b4',
  cyan: '00ffff',
  teal: '008080',
  lime: '80ff00',
  gold: 'ffd700',
  indigo: '4b0082',
};

/** Accepts `#ff8800`, `ff8800`, `f80`, `255,136,0`, or a color name. */
export function parseColor(input: string): RGB {
  const s = input.trim().toLowerCase();
  const rgbMatch = s.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
  if (rgbMatch) return { r: clamp(+rgbMatch[1], 0, 255), g: clamp(+rgbMatch[2], 0, 255), b: clamp(+rgbMatch[3], 0, 255) };
  let hex = NAMED[s] ?? s.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(hex)) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    throw new Error(`Unknown color "${input}". Use a hex code (#ff8800), r,g,b, or one of: ${Object.keys(NAMED).join(', ')}`);
  }
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
}

/** Accepts Kelvin (2700, 2700k) or warm/neutral/cool/daylight. */
export function parseKelvin(input: string): number {
  const presets: Record<string, number> = { candle: 1900, warm: 2700, soft: 3000, neutral: 4000, cool: 5000, daylight: 6500 };
  const s = input.trim().toLowerCase().replace(/k$/, '');
  if (presets[s]) return presets[s];
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1000 || n > 10000) throw new Error(`Invalid color temperature "${input}". Use Kelvin (e.g. 2700) or warm/neutral/cool/daylight`);
  return n;
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const toHex = ({ r, g, b }: RGB) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export const isWhite = ({ r, g, b }: RGB) => r > 240 && g > 240 && b > 240;

/** h: 0-360, s: 0-1, v: 0-1 */
export function rgbToHsv({ r, g, b }: RGB): { h: number; s: number; v: number } {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** RGB → CIE xy (wide gamut, sRGB gamma), as used by Philips Hue. */
export function rgbToXy({ r, g, b }: RGB): [number, number] {
  const lin = (c: number) => {
    c /= 255;
    return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
  const Z = R * 0.000088 + G * 0.07231 + B * 0.986039;
  const sum = X + Y + Z;
  if (!sum) return [0.3227, 0.329];
  return [+(X / sum).toFixed(4), +(Y / sum).toFixed(4)];
}

export function xyToRgb(x: number, y: number): RGB {
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const max = Math.max(r, g, b, 1e-9);
  [r, g, b] = [r / max, g / max, b / max];
  const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  return { r: Math.round(clamp(gamma(r), 0, 1) * 255), g: Math.round(clamp(gamma(g), 0, 1) * 255), b: Math.round(clamp(gamma(b), 0, 1) * 255) };
}

export const kelvinToMired = (k: number) => Math.round(1_000_000 / k);
export const miredToKelvin = (m: number) => Math.round(1_000_000 / m / 10) * 10;

/** Map a Kelvin value into a device's 0..max scale where 0 = warmest. */
export function kelvinToScale(k: number, [minK, maxK]: [number, number], max: number) {
  return Math.round(((clamp(k, minK, maxK) - minK) / (maxK - minK)) * max);
}

export function scaleToKelvin(v: number, [minK, maxK]: [number, number], max: number) {
  return Math.round((minK + (v / max) * (maxK - minK)) / 10) * 10;
}
