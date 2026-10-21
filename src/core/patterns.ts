import type { Music } from './music';

/**
 * Matrix patterns. Each turns (time, music, grid size, params) into a frame:
 * brightness 0..1 per cell, plus optionally a warmth layer (0 = warm amber,
 * 1 = cool white) — with white-only bulbs, warm vs cool is the "second colour".
 * Pure and device-agnostic: the runner decides how values become commands.
 */

export type Frame = number[][];

/** A pattern may return just brightness, or brightness + warmth. */
export type Look = Frame | { v: Frame; w?: Frame };

export interface PatternContext {
  rows: number;
  cols: number;
  /** Steps of the pattern's own timer (or beats, when stepped on the beat). */
  tick: number;
  /** Grid positions in sequence order (cell #1 first), from the layout's numbering. */
  seq: Array<[number, number]>;
  params: Record<string, any>;
  /** Scratch space that persists between frames of one run. */
  state: Record<string, any>;
  /** Pixels painted by the user (draw mode). */
  canvas: Frame;
  /** Musical time and hits at this frame's display time. */
  music: Music;
}

export interface PatternParam {
  key: string;
  label: string;
  type: 'text' | 'select' | 'toggle';
  default: string | boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface Pattern {
  id: string;
  name: string;
  description: string;
  /** basic: timer-driven; music: follows beats/hits (falls back to a 120 BPM metronome). */
  category?: 'basic' | 'music';
  params?: PatternParam[];
  frame(ctx: PatternContext): Look;
}

export const blank = (rows: number, cols: number, v = 0): Frame => Array.from({ length: rows }, () => Array<number>(cols).fill(v));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const REVERSE: PatternParam = { key: 'reverse', label: 'End to start', type: 'toggle', default: false };

/** Triangle 0 → 1 → 0 over x in 0..1 (wraps). */
const tri = (x: number) => 1 - Math.abs(((x % 1) + 1) % 1 * 2 - 1);
const gauss = (d: number, sigma: number) => Math.exp(-(d * d) / (2 * sigma * sigma));

/** Seconds since the previous frame (0 on the first). */
function step(state: Record<string, any>, t: number) {
  const dt = state._t === undefined ? 0 : Math.max(0, Math.min(0.5, t - state._t));
  state._t = t;
  return dt;
}

/** Hit-triggered envelope: jumps to `hit` and decays exponentially with time constant tau (s). */
function decay(state: Record<string, any>, key: string, t: number, hit: number, tau: number) {
  if (hit > 0) state[key] = { at: t, s: Math.max(hit, state[key] ? state[key].s * Math.exp(-(t - state[key].at) / tau) : 0) };
  const e = state[key];
  return e ? e.s * Math.exp(-(t - e.at) / tau) : 0;
}

/** Split a Look into brightness and (optional) warmth. */
export function splitLook(look: Look): { v: Frame; w?: Frame } {
  return Array.isArray(look) ? { v: look } : look;
}

// ---- 5x7 font (rows of 5 bits, MSB = left) ----------------------------------
const FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.....', '..#..'],
  ':': ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'],
  '*': ['.#.#.', '#####', '#####', '#####', '.###.', '..#..', '.....'], // heart
};

/** Text → columns of 7 pixels (1 blank column between characters). */
export function textColumns(text: string): number[][] {
  const cols: number[][] = [];
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT['?'];
    for (let x = 0; x < 5; x++) cols.push(glyph.map((row) => (row[x] === '#' ? 1 : 0)));
    cols.push(Array(7).fill(0));
  }
  return cols;
}

function spiralOrder(rows: number, cols: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let top = 0, bottom = rows - 1, left = 0, right = cols - 1;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) out.push([top, c]);
    for (let r = top + 1; r <= bottom; r++) out.push([r, right]);
    if (top < bottom) for (let c = right - 1; c >= left; c--) out.push([bottom, c]);
    if (left < right) for (let r = bottom - 1; r > top; r--) out.push([r, left]);
    top++, bottom--, left++, right--;
  }
  return out;
}

/** Light cells along an ordered path: either a moving head with a fading tail, or a fill. */
function alongPath(ctx: PatternContext, path: Array<[number, number]>, mode: 'chase' | 'wipe') {
  const f = blank(ctx.rows, ctx.cols);
  const order = ctx.params.reverse ? [...path].reverse() : path;
  const n = order.length;
  if (mode === 'chase') {
    const head = ctx.tick % n;
    for (let t = 0; t < 4; t++) {
      const [r, c] = order[(head - t + n) % n];
      f[r][c] = Math.max(f[r][c], 1 - t * 0.3);
    }
  } else {
    const phase = ctx.tick % (2 * n);
    order.forEach(([r, c], i) => (f[r][c] = phase < n ? (i <= phase ? 1 : 0) : i > phase - n ? 1 : 0));
  }
  return f;
}

/** Ping-pong position 0..len-1..0 */
const bounce = (tick: number, len: number) => (len < 2 ? 0 : len - 1 - Math.abs((tick % (2 * len - 2)) - (len - 1)));

export const PATTERNS: Pattern[] = [
  {
    id: 'chase',
    name: 'Sequence chase',
    description: 'A light runs through the bulbs in number order (1 → last), with a fading tail.',
    params: [REVERSE],
    frame: (ctx) => alongPath(ctx, ctx.seq, 'chase'),
  },
  {
    id: 'wipe',
    name: 'Sequence fill',
    description: 'Lights up bulbs one by one in number order, then clears them. Good for checking the numbering.',
    params: [REVERSE],
    frame: (ctx) => alongPath(ctx, ctx.seq, 'wipe'),
  },
  {
    id: 'rows',
    name: 'Row sweep',
    description: 'A bright row moves down and back up.',
    frame: ({ rows, cols, tick }) => {
      const at = bounce(tick, rows);
      return Array.from({ length: rows }, (_, r) => Array(cols).fill(r === at ? 1 : Math.abs(r - at) === 1 ? 0.3 : 0));
    },
  },
  {
    id: 'columns',
    name: 'Column sweep',
    description: 'A bright column moves left and right.',
    frame: ({ rows, cols, tick }) => {
      const at = bounce(tick, cols);
      return Array.from({ length: rows }, () => Array.from({ length: cols }, (_, c) => (c === at ? 1 : Math.abs(c - at) === 1 ? 0.3 : 0)));
    },
  },
  {
    id: 'rain',
    name: 'Rain',
    description: 'Drops fall down the columns with short trails.',
    frame: ({ rows, cols, state }) => {
      state.drops ??= [] as Array<{ c: number; r: number }>;
      for (const d of state.drops) d.r++;
      state.drops = state.drops.filter((d: any) => d.r - 2 < rows);
      for (let c = 0; c < cols; c++) if (Math.random() < 0.18) state.drops.push({ c, r: 0 });
      const f = blank(rows, cols);
      for (const d of state.drops) {
        for (let t = 0; t < 3; t++) {
          const r = d.r - t;
          if (r >= 0 && r < rows) f[r][d.c] = Math.max(f[r][d.c], 1 - t * 0.4);
        }
      }
      return f;
    },
  },
  {
    id: 'ripple',
    name: 'Ripple',
    description: 'Rings spread out from the centre.',
    frame: ({ rows, cols, tick }) => {
      const cr = (rows - 1) / 2, cc = (cols - 1) / 2;
      const maxR = Math.hypot(cr, cc) + 1;
      const radius = (tick * 0.8) % maxR;
      return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => clamp01(1 - Math.abs(Math.hypot(r - cr, c - cc) - radius))));
    },
  },
  {
    id: 'checker',
    name: 'Checkerboard',
    description: 'Alternating cells swap on every beat.',
    frame: ({ rows, cols, tick }) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ((r + c + tick) % 2 ? 1 : 0))),
  },
  {
    id: 'equalizer',
    name: 'Equaliser',
    description: 'Columns bounce like a music level meter.',
    frame: ({ rows, cols, state }) => {
      state.h ??= Array.from({ length: cols }, () => Math.random() * rows);
      state.h = state.h.map((h: number) => Math.max(1, Math.min(rows, h + (Math.random() - 0.5) * rows * 0.6)));
      return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (rows - r <= Math.round(state.h[c]) ? (r === rows - Math.round(state.h[c]) ? 1 : 0.55) : 0)));
    },
  },
  {
    id: 'sparkle',
    name: 'Sparkle',
    description: 'Random bulbs twinkle and fade.',
    frame: ({ rows, cols, state }) => {
      const prev: Frame = state.prev ?? blank(rows, cols);
      const f = prev.map((row) => row.map((v) => (v > 0.15 ? v * 0.45 : 0)));
      const n = Math.max(1, Math.round(rows * cols * 0.12));
      for (let i = 0; i < n; i++) f[Math.floor(Math.random() * rows)][Math.floor(Math.random() * cols)] = 1;
      state.prev = f;
      return f;
    },
  },
  {
    id: 'spiral',
    name: 'Spiral',
    description: 'Fills from the outside in, then clears.',
    params: [REVERSE],
    frame: (ctx) => alongPath(ctx, spiralOrder(ctx.rows, ctx.cols), 'wipe'),
  },
  {
    id: 'text',
    name: 'Text',
    description: 'Scrolls a message across the matrix (letters are 5×7, so they fit 6 wide).',
    params: [
      { key: 'text', label: 'Message', type: 'text', default: 'HELLO' },
      { key: 'mode', label: 'Style', type: 'select', default: 'scroll', options: [{ label: 'Scroll left', value: 'scroll' }, { label: 'One letter at a time', value: 'flash' }] },
    ],
    frame: ({ rows, cols, tick, params }) => {
      const message = String(params.text || 'HELLO').slice(0, 60);
      const top = Math.max(0, Math.floor((rows - 7) / 2));
      const f = blank(rows, cols);
      const put = (x: number, column: number[]) => column.forEach((v, y) => y + top < rows && x >= 0 && x < cols && (f[y + top][x] = v));
      if (params.mode === 'flash') {
        // Each letter holds for 3 beats, then a blank beat so repeated letters are readable.
        const chars = message.replace(/\s+/g, ' ').split('');
        const step = tick % (chars.length * 4);
        if (step % 4 === 3) return f;
        const glyph = textColumns(chars[Math.floor(step / 4)]).slice(0, 5);
        const left = Math.floor((cols - 5) / 2);
        glyph.forEach((col, x) => put(left + x, col));
        return f;
      }
      const columns = [...Array.from({ length: cols }, () => Array(7).fill(0)), ...textColumns(message)];
      const offset = tick % columns.length;
      for (let x = 0; x < cols; x++) put(x, columns[(offset + x) % columns.length]);
      return f;
    },
  },
  {
    id: 'life',
    name: 'Game of Life',
    description: "Conway's cellular automaton; reseeds when it dies out or gets stuck.",
    frame: ({ rows, cols, state }) => {
      const seed = () => blank(rows, cols).map((row) => row.map(() => (Math.random() < 0.35 ? 1 : 0)));
      if (!state.grid) {
        state.grid = seed();
        state.seen = [] as string[];
        return state.grid;
      }
      const g: Frame = state.grid;
      const next = g.map((row, r) =>
        row.map((v, c) => {
          let n = 0;
          for (let dr = -1; dr <= 1; dr++)
            for (let dc = -1; dc <= 1; dc++) if (dr || dc) n += g[(r + dr + rows) % rows][(c + dc + cols) % cols];
          return n === 3 || (v && n === 2) ? 1 : 0;
        })
      );
      const key = next.flat().join('');
      state.seen = [key, ...state.seen].slice(0, 6);
      const stuck = !key.includes('1') || state.seen.indexOf(key, 1) !== -1;
      state.grid = stuck ? seed() : next;
      return state.grid;
    },
  },
  // ---- music: locked to beats, bars and drum hits ------------------------------
  // These read ctx.music (beat position, bar, kick/snare/hat hits, energy). Without
  // music they run on a 120 BPM metronome, so they can be previewed anywhere.
  {
    id: 'mix',
    name: 'Full mix',
    category: 'music',
    description:
      'Every part of the sound in its own layer: kick on the floor, snare on the ceiling, hi-hat glints, a bass column, the melody as a point (height = pitch, side = stereo position), and a background wash whose warmth follows how bright the sound is and whose spread follows its stereo width. Blinder on drops.',
    params: [
      { key: 'wash', label: 'Background wash (energy, brightness, width)', type: 'toggle', default: true },
      { key: 'bass', label: 'Bass column', type: 'toggle', default: true },
      { key: 'kick', label: 'Kick on the floor', type: 'toggle', default: true },
      { key: 'snare', label: 'Snare on the ceiling', type: 'toggle', default: true },
      { key: 'hats', label: 'Hi-hat glints', type: 'toggle', default: true },
      { key: 'melody', label: 'Melody point (pitch + stereo)', type: 'toggle', default: true },
      { key: 'drops', label: 'Blinder on drops', type: 'toggle', default: true },
    ],
    frame: ({ rows, cols, music, state, params }) => {
      const on = (k: string) => params[k] !== false;
      const t = music.t;
      const dt = step(state, t);
      const v = blank(rows, cols), w = blank(rows, cols, 0.5);
      const put = (r: number, c: number, val: number, warm: number) => {
        if (r < 0 || c < 0 || r >= rows || c >= cols || val <= v[r][c]) return;
        v[r][c] = clamp01(val);
        w[r][c] = clamp01(warm);
      };
      const mid = (cols - 1) / 2;

      // Background wash: brightness from energy, white from the sound's brightness, spread from stereo width.
      if (on('wash')) {
        const level = 0.05 + 0.2 * music.energy;
        const spread = 0.2 + 0.8 * music.stereo.width;
        const warmth = 0.1 + 0.75 * music.timbre.centroid;
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++) {
            const d = Math.abs(c - mid) / Math.max(1, mid);
            const inside = d <= spread + 0.15 ? 1 : 0.25;
            put(r, c, level * inside * (0.75 + 0.25 * Math.sin(t * 1.4 + r * 0.7 + c * 0.4)), warmth);
          }
      }

      // Bass: a warm column in the middle, as tall as the low end is loud (fast rise, slower fall).
      if (on('bass')) {
        const low = (music.bands[0] + music.bands[1]) / 2;
        state.bass = Math.max(low, (state.bass ?? 0) - dt * 2.2);
        const height = state.bass * rows * 0.6;
        const centre = [Math.floor(mid), Math.ceil(mid)];
        for (let k = 0; k < Math.ceil(height); k++) for (const c of centre) put(rows - 1 - k, c, state.bass * (1 - k * 0.12) * Math.min(1, height - k), 0.06);
      }

      // Kick: thump on the floor.
      if (on('kick')) {
        const k = decay(state, 'kick', t, music.hits.kick, 0.16);
        for (let c = 0; c < cols; c++) (put(rows - 1, c, k, 0.04), put(rows - 2, c, k * 0.55, 0.1));
      }

      // Snare: crack on the ceiling.
      if (on('snare')) {
        const sn = decay(state, 'snare', t, music.hits.snare, 0.11);
        for (let c = 0; c < cols; c++) (put(0, c, sn, 1), put(1, c, sn * 0.5, 0.95));
      }

      // Hi-hats: glints in the middle rows; noisier sounds glint more.
      if (on('hats')) {
        state.glints ??= [] as Array<{ r: number; c: number; at: number; s: number }>;
        if (music.hits.hat) {
          const n = 1 + Math.round(music.timbre.flatness * 3);
          for (let i = 0; i < n; i++) state.glints.push({ r: 2 + Math.floor(Math.random() * Math.max(1, rows - 4)), c: Math.floor(Math.random() * cols), at: t, s: 0.5 + 0.5 * music.hits.hat });
        }
        state.glints = state.glints.filter((g: any) => t - g.at < 0.3);
        for (const g of state.glints) put(g.r, g.c, g.s * Math.exp(-(t - g.at) / 0.08), 0.95);
      }

      // Melody: a point at the note's height, on the side the mids are panned to, leaving a short trail.
      if (on('melody')) {
        state.trail ??= [] as Array<{ r: number; c: number; at: number }>;
        const p = music.pitch;
        if (p && p.confidence > 0.5) {
          const r = Math.round((1 - clamp01((p.midi - 48) / 36)) * (rows - 1));
          const c = Math.round(((music.stereo.pan[1] + 1) / 2) * (cols - 1));
          const last = state.trail[state.trail.length - 1];
          if (!last || last.r !== r || last.c !== c || t - last.at > 0.12) state.trail.push({ r, c, at: t });
        }
        state.trail = state.trail.filter((x: any) => t - x.at < 1);
        for (const x of state.trail) put(x.r, x.c, Math.exp(-(t - x.at) / 0.3), 0.72);
      }

      // Drops: loudness jumps well above the last few seconds → blinder.
      if (on('drops')) {
        state.eHist ??= [] as number[];
        state.eAt ??= t;
        if (t - state.eAt >= 0.25) {
          state.eHist.push(music.energy);
          if (state.eHist.length > 16) state.eHist.shift();
          state.eAt = t;
        }
        const h: number[] = state.eHist;
        const before = h.length >= 12 ? h.slice(0, 8).reduce((a, b) => a + b, 0) / 8 : 1;
        if (music.energy - before > 0.28 && music.hits.kick && t - (state.lastDrop ?? -99) > 12) state.lastDrop = t;
        const bl = state.lastDrop !== undefined ? Math.exp(-(t - state.lastDrop) / 0.35) : 0;
        if (bl > 0.02) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) put(r, c, bl, 0.6 + 0.4 * bl);
      }
      return { v, w };
    },
  },
  {
    id: 'blinder',
    name: 'Blinder',
    category: 'music',
    description: 'The whole wall slams to full cool white on the bar and on big kicks, then fades through warm. The classic drop hit.',
    frame: ({ rows, cols, music, state }) => {
      const hit = Math.max(music.hits.downbeat, music.hits.kick >= 0.8 ? music.hits.kick : 0);
      const v = decay(state, 'b', music.t, hit, 0.25);
      return { v: blank(rows, cols, v), w: blank(rows, cols, 0.25 + 0.75 * v) };
    },
  },
  {
    id: 'kick-snare',
    name: 'Kick & snare',
    category: 'music',
    description: 'Bottom rows punch warm on the kick, top rows snap cool on the snare, hi-hats tick in the middle.',
    frame: ({ rows, cols, music, state }) => {
      const k = decay(state, 'k', music.t, music.hits.kick, 0.2);
      const s = decay(state, 's', music.t, music.hits.snare, 0.16);
      const h = decay(state, 'h', music.t, music.hits.hat, 0.09);
      const third = rows / 3;
      const v = Array.from({ length: rows }, (_, r) => Array(cols).fill(r >= rows - third ? k : r < third ? s : h * 0.7));
      const w = Array.from({ length: rows }, (_, r) => Array(cols).fill(r >= rows - third ? 0.1 : r < third ? 1 : 0.6));
      return { v, w };
    },
  },
  {
    id: 'hat-rain',
    name: 'Hi-hat rain',
    category: 'music',
    description: 'Each hi-hat drops a light from the top; snares drop two. Falls one wall-height per bar.',
    frame: ({ rows, cols, music, state }) => {
      const dt = step(state, music.t);
      state.drops ??= [] as Array<{ c: number; y: number; s: number }>;
      const speed = (rows / (4 * 60 / Math.max(60, music.bpm || 120))); // rows per second: one height per bar
      for (const d of state.drops) d.y += speed * dt;
      state.drops = state.drops.filter((d: any) => d.y - 2 < rows);
      const spawn = (s: number) => state.drops.push({ c: Math.floor(Math.random() * cols), y: 0, s });
      if (music.hits.hat) spawn(0.6 + 0.4 * music.hits.hat);
      if (music.hits.snare) (spawn(1), spawn(1));
      const v = blank(rows, cols), w = blank(rows, cols, 1);
      for (const d of state.drops) {
        for (let tail = 0; tail < 3; tail++) {
          const r = Math.floor(d.y) - tail;
          if (r >= 0 && r < rows && d.s * (1 - tail * 0.38) > v[r][d.c]) {
            v[r][d.c] = d.s * (1 - tail * 0.38);
            w[r][d.c] = 1 - tail * 0.4;
          }
        }
      }
      return { v, w };
    },
  },
  {
    id: 'wave',
    name: 'Tempo wave',
    category: 'music',
    description: 'A smooth wave rolls across the wall, one cycle every two beats; warmth drifts slowly up and down.',
    frame: ({ rows, cols, music }) => {
      const amp = 0.45 + 0.4 * music.energy;
      const v = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => 0.1 + amp * (0.5 + 0.5 * Math.sin(2 * Math.PI * (music.beat / 2 - c / cols - r / (rows * 2)))))
      );
      const w = Array.from({ length: rows }, (_, r) => Array(cols).fill(0.5 + 0.5 * Math.sin(2 * Math.PI * (music.beat / 16 + r / rows))));
      return { v, w };
    },
  },
  {
    id: 'scanner',
    name: 'Bar scanner',
    category: 'music',
    description: 'A bright bar sweeps across and back once per bar, like a moving-head sweep. Flashes on the downbeat.',
    params: [{ key: 'axis', label: 'Direction', type: 'select', default: 'columns', options: [{ label: 'Left ↔ right', value: 'columns' }, { label: 'Up ↕ down', value: 'rows' }] }],
    frame: ({ rows, cols, music, state, params }) => {
      const vertical = params.axis === 'rows';
      const len = vertical ? rows : cols;
      const x = tri(music.beatInBar / 4) * (len - 1);
      const flash = decay(state, 'f', music.t, music.hits.downbeat, 0.15) * 0.35;
      const v = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => Math.min(1, gauss((vertical ? r : c) - x, 0.7) + flash)));
      const w = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => 0.3 + 0.7 * gauss((vertical ? r : c) - x, 0.7)));
      return { v, w };
    },
  },
  {
    id: 'diagonal',
    name: 'Diagonal sweep',
    category: 'music',
    description: 'A diagonal line crosses the wall on every beat, alternating direction.',
    frame: ({ rows, cols, music }) => {
      const span = rows + cols - 2;
      const flip = Math.floor(music.beat) % 2 === 1;
      const target = music.phase * (span + 2) - 1;
      const v = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => gauss((flip ? rows - 1 - r : r) + c - target, 0.8) * (0.5 + 0.5 * Math.max(music.energy, 0.4)))
      );
      return { v, w: blank(rows, cols, flip ? 0.2 : 1) };
    },
  },
  {
    id: 'mirror-spectrum',
    name: 'Mirror spectrum',
    category: 'music',
    description: 'Bass in the middle columns, treble at the edges, bars rising from the bottom — symmetric like a stage rig.',
    frame: ({ rows, cols, music, state }) => {
      const b = music.bands;
      const groups = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2]; // bass, mid, treble
      const half = cols / 2;
      state.h ??= Array(cols).fill(0);
      const dt = step(state, music.t);
      const v = blank(rows, cols), w = blank(rows, cols);
      for (let c = 0; c < cols; c++) {
        const dist = Math.abs(c + 0.5 - half) / half; // 0 centre .. 1 edge
        const g = Math.min(2, Math.floor(dist * 3));
        const target = Math.pow(groups[g] ?? 0, 1.3) * rows;
        state.h[c] = Math.max(target, state.h[c] - dt * rows * 2.5); // fall in ~0.4 s
        for (let r = 0; r < rows; r++) {
          const fromBottom = rows - r;
          v[r][c] = fromBottom <= state.h[c] ? (fromBottom > state.h[c] - 1 ? 1 : 0.55) : 0;
          w[r][c] = g / 2;
        }
      }
      return { v, w };
    },
  },
  {
    id: 'riser',
    name: 'Riser',
    category: 'music',
    description: 'For build-ups: the wall fills from the bottom while a strobe speeds up (1 → 2 → 4 per beat), turning from warm to cool.',
    frame: ({ rows, cols, music }) => {
      const p = music.progress || music.energy;
      const level = Math.max(1, Math.round(p * rows));
      // Strobe subdivision rises with progress, capped at ~8 flashes/s (bulbs can't go faster).
      let sub = p < 0.5 ? 1 : p < 0.8 ? 2 : 4;
      while (sub > 1 && (music.bpm / 60) * sub > 8) sub /= 2;
      const on = Math.floor(music.beat * sub * 2) % 2 === 0;
      const v = Array.from({ length: rows }, (_, r) => Array(cols).fill(rows - r <= level ? (on ? 1 : 0.2) : 0.04));
      return { v, w: blank(rows, cols, p) };
    },
  },
  {
    id: 'breathe',
    name: 'Breathe',
    category: 'music',
    description: 'Ambient: the wall slowly breathes over two bars, drifting between warm and cool. For intros and breakdowns.',
    frame: ({ rows, cols, music }) => {
      const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * music.beat) / 8);
      const v = Array.from({ length: rows }, (_, r) => Array(cols).fill(0.12 + (0.3 + 0.3 * music.energy) * breath * (0.75 + 0.25 * Math.sin(r / 2 + music.beat / 4))));
      return { v, w: blank(rows, cols, 0.5 - 0.5 * Math.cos((2 * Math.PI * music.beat) / 16)) };
    },
  },
  {
    id: 'quadrants',
    name: 'Quadrants',
    category: 'music',
    description: 'Beat 1 left, 2 right, 3 top, 4 bottom — each half punches and fades. Cool on the downbeat, warm otherwise.',
    frame: ({ rows, cols, music }) => {
      const b = Math.floor(music.beatInBar) % 4;
      const hit = Math.exp(-music.phase * 3.2);
      const v = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => ((b === 0 && c < cols / 2) || (b === 1 && c >= cols / 2) || (b === 2 && r < rows / 2) || (b === 3 && r >= rows / 2) ? hit : 0))
      );
      return { v, w: blank(rows, cols, b === 0 ? 1 : 0.15) };
    },
  },
  {
    id: 'strobe',
    name: 'Strobe',
    category: 'music',
    description: 'Short full flashes on beats (and snares). Dark in between. Use for peaks only.',
    params: [{ key: 'rate', label: 'Flashes', type: 'select', default: 'beat', options: [{ label: 'Every beat', value: 'beat' }, { label: 'Every half beat', value: 'half' }, { label: 'Snares only', value: 'snare' }] }],
    frame: ({ rows, cols, music, state, params }) => {
      let hit = params.rate === 'snare' ? music.hits.snare : Math.max(music.hits.beat, music.hits.snare);
      if (params.rate === 'half' && (music.bpm / 60) * 2 <= 8) {
        const h = Math.floor(music.beat * 2);
        if (state.half !== undefined && h !== state.half) hit = Math.max(hit, 0.7);
        state.half = h;
      }
      if (hit) state.flashAt = music.t;
      const v = state.flashAt !== undefined && music.t - state.flashAt < 0.08 ? 1 : 0;
      return { v: blank(rows, cols, v), w: blank(rows, cols, 1) };
    },
  },
  {
    id: 'pulse',
    name: 'Bass pulse',
    category: 'music',
    description: 'The whole wall breathes with the bass and punches on every kick. Warm.',
    frame: ({ rows, cols, music, state }) => {
      const k = decay(state, 'k', music.t, music.hits.kick, 0.18);
      const v = Math.max(k, Math.pow(music.bands[0] ?? 0, 1.6) * 0.55);
      return { v: blank(rows, cols, v), w: blank(rows, cols, 0.1 + 0.3 * k) };
    },
  },
  {
    id: 'burst',
    name: 'Kick burst',
    category: 'music',
    description: 'Every kick sends a ring out from the centre; harder kicks travel further.',
    frame: ({ rows, cols, music, state }) => {
      state.rings ??= [] as Array<{ at: number; s: number }>;
      if (music.hits.kick) state.rings.push({ at: music.t, s: Math.max(0.5, music.hits.kick) });
      const cr = (rows - 1) / 2, cc = (cols - 1) / 2;
      const maxR = Math.hypot(cr, cc) + 1;
      const speed = maxR / (60 / Math.max(60, music.bpm || 120)); // reach the edge in one beat
      state.rings = state.rings.filter((ring: any) => (music.t - ring.at) * speed <= maxR * ring.s + 1);
      const v = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => {
          const d = Math.hypot(r - cr, c - cc);
          return clamp01(Math.max(0, ...state.rings.map((ring: any) => (1 - Math.abs(d - (music.t - ring.at) * speed)) * ring.s)));
        })
      );
      return { v, w: v.map((row) => row.map((x) => 0.3 + 0.7 * x)) };
    },
  },
  {
    id: 'beat-sparkle',
    name: 'Hat sparkle',
    category: 'music',
    description: 'Random bulbs glint on every hi-hat and snare, fading quickly.',
    frame: ({ rows, cols, music, state }) => {
      const dt = step(state, music.t);
      const prev: Frame = state.prev ?? blank(rows, cols);
      const fade = Math.exp(-dt / 0.12);
      const f = prev.map((row) => row.map((v) => (v * fade > 0.08 ? v * fade : 0)));
      const strike = Math.max(music.hits.hat, music.hits.snare);
      if (strike) {
        const n = Math.max(1, Math.round(rows * cols * (0.06 + 0.12 * strike) * (music.hits.snare ? 2 : 1)));
        for (let i = 0; i < n; i++) f[Math.floor(Math.random() * rows)][Math.floor(Math.random() * cols)] = 1;
      }
      state.prev = f;
      return { v: f, w: blank(rows, cols, 1) };
    },
  },
  {
    id: 'beat-climb',
    name: 'Bar climb',
    category: 'music',
    description: 'Each beat lights the next row up; a full climb takes two bars, then restarts on the downbeat.',
    frame: ({ rows, cols, music }) => {
      const steps = Math.floor(music.beatInBar + (music.bar % 2) * 4); // 0..7 over two bars
      const lit = rows - 1 - Math.round((steps / 7) * (rows - 1));
      const hit = Math.exp(-music.phase * 2.5);
      const v = Array.from({ length: rows }, (_, r) => Array(cols).fill(r === lit ? 0.4 + 0.6 * hit : r > lit ? 0.22 : 0));
      return { v, w: Array.from({ length: rows }, (_, r) => Array(cols).fill(1 - r / rows)) };
    },
  },
  {
    id: 'spectrum',
    name: 'Spectrum',
    category: 'music',
    description: 'Each column is a frequency band (bass left, treble right); bars rise with the music.',
    frame: ({ rows, cols, music, state }) => {
      state.h ??= Array(cols).fill(0);
      const dt = step(state, music.t);
      const v = blank(rows, cols), w = blank(rows, cols);
      for (let c = 0; c < cols; c++) {
        const band = music.bands[Math.min(music.bands.length - 1, Math.floor((c * music.bands.length) / cols))] ?? 0;
        state.h[c] = Math.max(band * rows, state.h[c] - dt * rows * 2.5);
        for (let r = 0; r < rows; r++) {
          const fromBottom = rows - r;
          v[r][c] = fromBottom <= state.h[c] ? (fromBottom > state.h[c] - 1 ? 1 : 0.55) : 0;
          w[r][c] = c / Math.max(1, cols - 1);
        }
      }
      return { v, w };
    },
  },
  {
    id: 'level',
    name: 'Level meter',
    category: 'music',
    description: 'Loudness grows outwards from the middle rows.',
    frame: ({ rows, cols, music }) => {
      const mid = (rows - 1) / 2;
      const reach = music.level * (rows / 2 + 0.5);
      const v = Array.from({ length: rows }, (_, r) => Array(cols).fill(Math.abs(r - mid) < reach ? 1 - (Math.abs(r - mid) / (rows / 2 + 1)) * 0.5 : 0));
      return { v, w: Array.from({ length: rows }, (_, r) => Array(cols).fill(Math.abs(r - mid) / (rows / 2))) };
    },
  },
  {
    id: 'fill',
    name: 'All on',
    description: 'Every mapped bulb fully on. Useful to check every cell is assigned.',
    frame: ({ rows, cols }) => blank(rows, cols, 1),
  },
  {
    id: 'draw',
    name: 'Draw',
    description: 'Click cells on the grid to switch them on and off live.',
    frame: ({ canvas }) => canvas.map((row) => [...row]),
  },
];

export const patternById = (id: string) => PATTERNS.find((p) => p.id === id);
