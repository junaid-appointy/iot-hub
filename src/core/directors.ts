import { MatrixOptions, Palette, Selection, Director } from './matrix-runner';
import { Sample, ShowClock } from './music';

/**
 * Directors decide *what* plays, frame by frame:
 *  - showDirector: a choreographed cue list against a song.
 *  - Autopilot: live "lighting designer" that changes the look on phrase
 *    boundaries by energy, rides build-ups and hits the drop.
 */

export interface DirectorCue {
  t: number;
  pattern: string;
  params?: Record<string, unknown>;
  stepOn?: 'timer' | 'beat';
  tickMs?: number;
  palette?: Palette;
  /** 0..1 scales the output brightness for this cue. */
  intensity?: number;
  maxBrightness?: number;
  kelvin?: number;
}

export function showDirector(clock: ShowClock, getCues: () => DirectorCue[], base: () => MatrixOptions): Director {
  return (D) => {
    if (!clock.playing) return null;
    const s = clock.songTime(D);
    const cues = getCues();
    let i = -1;
    for (let k = 0; k < cues.length; k++) if (cues[k].t <= s) i = k;
    if (i < 0) return null;
    const cue = cues[i];
    const end = cues[i + 1]?.t ?? clock.song.duration;
    const b = base();
    const options: Partial<MatrixOptions> = {
      stepOn: cue.stepOn ?? 'timer',
      tickMs: cue.tickMs ?? 500,
      palette: cue.palette ?? b.palette,
      maxBrightness: Math.max(10, Math.round((cue.maxBrightness ?? b.maxBrightness) * (cue.intensity ?? 1))),
    };
    if (cue.kelvin) options.kelvin = cue.kelvin;
    return {
      pattern: cue.pattern,
      params: cue.params as Record<string, any>,
      options,
      key: `cue:${i}:${cue.pattern}`,
      progress: Math.max(0, Math.min(1, (s - cue.t) / Math.max(0.5, end - cue.t))),
    };
  };
}

interface Look {
  pattern: string;
  palette: Palette;
  stepOn?: 'timer' | 'beat';
  params?: Record<string, unknown>;
}

const LOOKS: Record<'calm' | 'groove' | 'peak', Look[]> = {
  calm: [
    { pattern: 'aurora', palette: 'dual' },
    { pattern: 'chladni', palette: 'dual' },
    { pattern: 'ripple-tank', palette: 'dual' },
    { pattern: 'breathe', palette: 'dual' },
  ],
  groove: [
    { pattern: 'mix', palette: 'dual' },
    { pattern: 'harp', palette: 'dual' },
    { pattern: 'ripple-tank', palette: 'dual' },
    { pattern: 'chladni', palette: 'dual' },
    { pattern: 'kick-snare', palette: 'dual' },
    { pattern: 'scanner', palette: 'dual' },
  ],
  peak: [
    { pattern: 'embers', palette: 'dual' },
    { pattern: 'mix', palette: 'dual' },
    { pattern: 'ripple-tank', palette: 'dual' },
    { pattern: 'harp', palette: 'dual' },
    { pattern: 'burst', palette: 'dual' },
  ],
};

/**
 * Live autopilot. Works in bars when the beat tracker is locked (phrase = 8
 * bars), otherwise in 4-second blocks. Energy thresholds adapt to the room:
 * "loud" means loud relative to the last few minutes, so it works for a quiet
 * lounge and a club alike.
 */
export class Autopilot {
  private history: number[] = []; // energy per bar (or block)
  private lastUnit = -1;
  private unitsInLook = 0;
  private look: Look = LOOKS.calm[0];
  private lookKey = '';
  private counters = { calm: 0, groove: 0, peak: 0 };
  private dropUntilUnit = -1;
  private lastDropUnit = -1000;
  private mode: 'calm' | 'groove' | 'peak' | 'build' | 'drop' = 'calm';
  label = 'Listening…';

  constructor(private phraseUnits = 8) {}

  /**
   * calm / groove / peak, relative to the range heard so far. Until the room has
   * shown a real range (quiet *and* loud), fall back to absolute levels — otherwise
   * a long quiet intro would make the first slightly louder bar look like a peak.
   */
  private level(e: number): 'calm' | 'groove' | 'peak' {
    const h = this.history.slice(-128);
    const s = [...h].sort((a, b) => a - b);
    const p = (q: number) => s[Math.floor(q * (s.length - 1))] ?? 0;
    const lo = p(0.05), hi = p(0.95);
    if (h.length < 8 || hi - lo < 0.3) return e < 0.3 ? 'calm' : e < 0.65 ? 'groove' : 'peak';
    const n = (e - lo) / (hi - lo);
    return n < 0.3 ? 'calm' : n < 0.7 ? 'groove' : 'peak';
  }

  private pick(kind: 'calm' | 'groove' | 'peak') {
    const pool = LOOKS[kind];
    let next = pool[this.counters[kind]++ % pool.length];
    if (next.pattern === this.look.pattern) next = pool[this.counters[kind]++ % pool.length];
    return next;
  }

  director: Director = (D, music) => {
    // A "unit" is a bar when locked, else a 4 s block.
    const unit = music.locked ? music.bar : Math.floor(D / 4000);
    const e = music.energy;
    if (unit !== this.lastUnit) {
      this.lastUnit = unit;
      this.unitsInLook++;
      this.history.push(e);
      if (this.history.length > 256) this.history.shift();
      const h = this.history;
      const recent = h.slice(-4);
      const before = h.slice(-12, -4);
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      const rising = h.length >= 6 && h.slice(-5).every((x, i, a) => i === 0 || x >= a[i - 1] - 0.02) && h[h.length - 1] - h[h.length - 5] > 0.12;
      // A drop: loud now, clearly quieter over the previous 8 units, and not right after another drop.
      const jump = before.length >= 4 && avg(recent.slice(-2)) - avg(before) > 0.22 && unit - this.lastDropUnit > 16;
      const kind = this.level(e);

      if (jump && this.mode !== 'drop' && kind === 'peak') {
        this.lastDropUnit = unit;
        // The drop: blinder for a bar, then straight into a peak look.
        this.mode = 'drop';
        this.dropUntilUnit = unit + 1;
        this.look = { pattern: 'blinder', palette: 'dual' };
        this.unitsInLook = 0;
        this.label = 'Drop!';
      } else if (this.mode === 'drop' && unit > this.dropUntilUnit) {
        this.mode = 'peak';
        this.look = this.pick('peak');
        this.unitsInLook = 0;
      } else if (rising && kind !== 'peak' && this.mode !== 'build') {
        this.mode = 'build';
        this.look = { pattern: 'riser', palette: 'dual' };
        this.unitsInLook = 0;
        this.label = 'Build-up';
      } else if (this.mode === 'build' && !rising && this.unitsInLook > 2) {
        this.mode = kind;
        this.look = this.pick(kind);
        this.unitsInLook = 0;
      } else if (this.mode !== 'drop' && this.mode !== 'build') {
        // Change looks on phrase boundaries, or straight away if the energy class changed.
        const phraseEnd = music.locked ? unit % this.phraseUnits === 0 : this.unitsInLook >= this.phraseUnits;
        if (kind !== this.mode || (phraseEnd && this.unitsInLook >= this.phraseUnits / 2)) {
          this.mode = kind;
          this.look = this.pick(kind);
          this.unitsInLook = 0;
        }
      }
      if (this.mode !== 'drop' && this.mode !== 'build') this.label = { calm: 'Calm', groove: 'Groove', peak: 'Peak' }[this.mode];
      this.lookKey = `${this.look.pattern}:${this.look.palette}:${JSON.stringify(this.look.params ?? {})}:${unit - this.unitsInLook}`;
    }
    const build = this.mode === 'build' ? Math.min(1, this.unitsInLook / 8) : undefined;
    return {
      pattern: this.look.pattern,
      params: this.look.params as Record<string, any>,
      options: { palette: this.look.palette, stepOn: this.look.stepOn ?? 'timer', tickMs: 400 },
      key: this.lookKey,
      progress: build,
    } satisfies Selection;
  };

  snapshot(music?: Sample) {
    return { mode: this.mode, label: this.label, pattern: this.look.pattern, energy: music ? Math.round(music.energy * 100) / 100 : undefined };
  }
}
