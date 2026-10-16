/**
 * Musical time for the matrix: where we are in the beat/bar, and which hits
 * (beat, downbeat, kick, snare, hi-hat) land in a frame.
 *
 * All times are wall-clock milliseconds (Date.now()). The browser runs on the
 * same machine, so its timestamps share this clock. Frames are rendered for a
 * *display time* slightly in the future (see MatrixRunner), so a source must
 * answer "what does the music look like at time D?", not "right now".
 */

export type HitType = 'beat' | 'downbeat' | 'kick' | 'snare' | 'hat';

export interface Hit {
  at: number;
  type: HitType;
  strength: number;
}

export interface Hits {
  beat: number;
  downbeat: number;
  kick: number;
  snare: number;
  hat: number;
}

export interface Music {
  /** Display time in seconds (monotonic within a run). */
  t: number;
  /** Continuous beat position (e.g. 12.25 = a quarter past beat 12). */
  beat: number;
  bar: number;
  /** 0..beatsPerBar (continuous). */
  beatInBar: number;
  /** 0..1 within the current beat. */
  phase: number;
  bpm: number;
  /** True when the tempo comes from real music (not the fallback metronome). */
  locked: boolean;
  /** Strength (0..1) of each hit type in this frame; 0 = none. */
  hits: Hits;
  /** Smoothed loudness 0..1 (seconds-scale). */
  energy: number;
  /** Instant loudness 0..1. */
  level: number;
  /** Six bands bass → treble, 0..1. */
  bands: number[];
  /** 0..1 through the current cue (shows); 0 otherwise. */
  progress: number;
  /** Song section at this moment (shows): intro, verse, build, drop, breakdown, outro. */
  section?: string;
}

export type Sample = Omit<Music, 't' | 'progress'> & {
  progress?: number;
  /** Exact wall time of the earliest hit in this frame, so it can be shown on the hit, not at the frame edge. */
  hitAt?: number;
};

export interface MusicSource {
  readonly kind: 'metronome' | 'live' | 'show';
  /** Music at display time D; hits are those in (prevD, D] plus any that arrived late. */
  sample(prevD: number, D: number): Sample;
}

const NO_HITS: Hits = { beat: 0, downbeat: 0, kick: 0, snare: 0, hat: 0 };
const BPB = 4;

/** Hits in a frame plus the time of the earliest one. */
type FrameHits = Hits & { _at?: number };

function addHit(h: FrameHits, type: HitType, strength: number, at?: number) {
  h[type] = Math.max(h[type], Math.max(0.05, Math.min(1, strength)));
  if (at !== undefined && (h._at === undefined || at < h._at)) h._at = at;
}

function finish(h: FrameHits): { hits: Hits; hitAt?: number } {
  const { _at, ...hits } = h;
  return { hits, hitAt: _at };
}

interface Grid {
  anchorMs: number; // wall time of beat `anchorBeat`
  anchorBeat: number;
  periodMs: number;
  /** A beat number that is a downbeat (bar start). */
  downbeat: number;
}

function gridPosition(g: Grid, D: number) {
  const beat = g.anchorBeat + (D - g.anchorMs) / g.periodMs;
  const fromDown = beat - g.downbeat;
  const bar = Math.floor(fromDown / BPB);
  return { beat, bar, beatInBar: fromDown - bar * BPB, phase: beat - Math.floor(beat), bpm: 60000 / g.periodMs };
}

/** Beats (and downbeats) whose integer crossing falls in (prevD, D]. */
function gridHits(g: Grid, prevD: number, D: number, hits: FrameHits, strength = 0.8) {
  if (D - prevD > 1000) return; // a jump, not playback: don't fire a burst of beats
  const b0 = g.anchorBeat + (prevD - g.anchorMs) / g.periodMs;
  const b1 = g.anchorBeat + (D - g.anchorMs) / g.periodMs;
  for (let k = Math.floor(b0) + 1; k <= Math.floor(b1); k++) {
    const at = g.anchorMs + (k - g.anchorBeat) * g.periodMs;
    addHit(hits, 'beat', strength, at);
    if ((((k - g.downbeat) % BPB) + BPB) % BPB === 0) addHit(hits, 'downbeat', strength, at);
  }
}

/** Fallback when no music is connected: a steady 120 BPM with a synthetic kick/snare/hat groove. */
export class Metronome implements MusicSource {
  readonly kind = 'metronome';
  private grid: Grid;

  constructor(bpm = 120, start = Date.now()) {
    this.grid = { anchorMs: start, anchorBeat: 0, periodMs: 60000 / bpm, downbeat: 0 };
  }

  sample(prevD: number, D: number): Sample {
    const pos = gridPosition(this.grid, D);
    const hits: FrameHits = { ...NO_HITS };
    gridHits(this.grid, prevD, D, hits);
    if (hits.beat) {
      addHit(hits, 'kick', hits.downbeat ? 1 : 0.75, hits._at);
      const inBar = Math.round(pos.beatInBar) % BPB;
      if (inBar === 1 || inBar === 3) addHit(hits, 'snare', 0.8, hits._at);
    }
    // Off-beat hi-hats (8th notes between beats).
    const h0 = (prevD - this.grid.anchorMs) / (this.grid.periodMs / 2);
    const h1 = (D - this.grid.anchorMs) / (this.grid.periodMs / 2);
    if (Math.floor(h1) > Math.floor(h0) && Math.floor(h1) % 2 === 1) addHit(hits, 'hat', 0.5, this.grid.anchorMs + Math.floor(h1) * (this.grid.periodMs / 2));
    const pulse = Math.exp(-pos.phase * 4);
    return {
      ...pos,
      locked: false,
      ...finish(hits),
      energy: 0.65,
      level: 0.45 + 0.4 * pulse,
      bands: [0.9 * pulse + 0.1, 0.7 * pulse + 0.15, 0.45, 0.4, 0.35 + 0.3 * (hits.hat ? 1 : 0), 0.3],
    };
  }
}

/**
 * Live music from the browser (microphone or system sound).
 * The browser's beat tracker sends a tempo grid once it has locked on, so beats
 * can be *predicted* and land on time; kick/snare/hat onsets arrive as they are
 * heard and are shown in the very next frame.
 */
export class LiveClock implements MusicSource {
  readonly kind = 'live';
  private grid?: Grid;
  private gridAt = 0;
  private locked = false;
  private pending: Hit[] = [];
  private level = 0;
  private bands = [0, 0, 0, 0, 0, 0];
  private featuresAt = 0;
  private energy = 0;
  private lastSampleD = 0;
  private fallback = new Metronome();

  setGrid(g: { anchorMs: number; anchorBeat: number; periodMs: number; downbeat: number; locked: boolean } | null) {
    if (!g || !(g.periodMs > 250 && g.periodMs < 2000)) {
      this.locked = false;
      return;
    }
    this.grid = { anchorMs: g.anchorMs, anchorBeat: g.anchorBeat, periodMs: g.periodMs, downbeat: g.downbeat };
    this.gridAt = Date.now();
    this.locked = !!g.locked;
  }

  push(hits: Hit[]) {
    const now = Date.now();
    for (const h of hits) if (h && h.at > now - 2000 && h.at < now + 5000) this.pending.push(h);
    if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
  }

  setFeatures(level: number, bands: number[]) {
    this.level = level;
    this.bands = bands;
    this.featuresAt = Date.now();
  }

  get isLocked() {
    return this.locked && Date.now() - this.gridAt < 4000;
  }

  sample(prevD: number, D: number): Sample {
    const hits: FrameHits = { ...NO_HITS };
    const keep: Hit[] = [];
    for (const h of this.pending) (h.at <= D ? addHit(hits, h.type, h.strength, h.at) : keep.push(h));
    this.pending = keep;

    const fresh = Date.now() - this.featuresAt < 1500;
    const level = fresh ? this.level : 0;
    const dt = Math.max(0, Math.min(1, (D - (this.lastSampleD || D)) / 1000));
    this.lastSampleD = D;
    this.energy += (level - this.energy) * Math.min(1, dt / 1.5);

    if (this.grid && this.isLocked) gridHits(this.grid, prevD, D, hits, 0.6 + 0.4 * this.energy);
    const base = { ...finish(hits), energy: this.energy, level, bands: fresh ? this.bands : [0, 0, 0, 0, 0, 0] };
    if (this.grid && this.isLocked) return { ...gridPosition(this.grid, D), locked: true, ...base };
    // Not locked: keep motion going on a free-running clock, but only react to real hits.
    const pos = this.fallback.sample(prevD, D);
    return { beat: pos.beat, bar: pos.bar, beatInBar: pos.beatInBar, phase: pos.phase, bpm: this.grid ? 60000 / this.grid.periodMs : 0, locked: false, ...base };
  }
}

/** Analysed song data needed to play a show (see shows.ts for the stored form). */
export interface SongMap {
  duration: number;
  beats: number[];
  /** Indices into `beats` that start a bar. */
  downbeats: number[];
  /** [time, strength 0..1] */
  kicks: Array<[number, number]>;
  snares: Array<[number, number]>;
  hats: Array<[number, number]>;
  /** Loudness 0..99 at 10 values per second. */
  env: number[];
  /** Six band envelopes 0..99 at 20 values per second. */
  bands: number[][];
  sections: Array<{ start: number; end: number; type: string }>;
}

function lastIndexAtOrBefore(arr: number[], t: number) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) (ans = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  return ans;
}

/**
 * Plays an analysed song: maps display time → song time through an anchor
 * (the wall time at which song time 0 is *heard*), and reads beats, bars,
 * hits, loudness and bands from the song map. Because everything is known in
 * advance, frames for the future are exact — this is what makes shows tight.
 */
export class ShowClock implements MusicSource {
  readonly kind = 'show';
  private downbeatSet: Set<number>;
  private barStartBeat: number[];
  private hitTimes: Record<'kicks' | 'snares' | 'hats', number[]>;
  anchorMs = 0;
  playing = false;

  constructor(readonly song: SongMap) {
    this.downbeatSet = new Set(song.downbeats);
    // For each beat, the beat index of the bar it belongs to.
    this.barStartBeat = song.beats.map(() => 0);
    let current = song.downbeats[0] ?? 0;
    for (let i = 0; i < song.beats.length; i++) {
      if (this.downbeatSet.has(i)) current = i;
      this.barStartBeat[i] = current;
    }
    this.hitTimes = { kicks: song.kicks.map((h) => h[0]), snares: song.snares.map((h) => h[0]), hats: song.hats.map((h) => h[0]) };
  }

  songTime(D: number) {
    return (D - this.anchorMs) / 1000;
  }

  private envAt(s: number) {
    const e = this.song.env;
    const i = s * 10;
    const a = e[Math.max(0, Math.min(e.length - 1, Math.floor(i)))] ?? 0;
    const b = e[Math.max(0, Math.min(e.length - 1, Math.floor(i) + 1))] ?? a;
    return (a + (b - a) * (i - Math.floor(i))) / 99;
  }

  private bandsAt(s: number) {
    return this.song.bands.map((band) => {
      const i = s * 20;
      const a = band[Math.max(0, Math.min(band.length - 1, Math.floor(i)))] ?? 0;
      const b = band[Math.max(0, Math.min(band.length - 1, Math.floor(i) + 1))] ?? a;
      return (a + (b - a) * (i - Math.floor(i))) / 99;
    });
  }

  sample(prevD: number, D: number): Sample {
    const s1 = this.songTime(D);
    const s0 = this.songTime(prevD);
    const beats = this.song.beats;
    const hits: FrameHits = { ...NO_HITS };
    const wall = (songT: number) => this.anchorMs + songT * 1000;
    const jumped = s1 - s0 > 0.5 || s1 < s0;

    // Beat position (interpolated between analysed beats).
    let beat = 0, bpm = 120, bar = 0, beatInBar = 0;
    const i = lastIndexAtOrBefore(beats, s1);
    if (i >= 0 && beats.length > 1) {
      const next = beats[i + 1] ?? beats[i] + (beats[i] - (beats[i - 1] ?? beats[i] - 0.5));
      const span = Math.max(0.2, next - beats[i]);
      beat = i + Math.min(1, (s1 - beats[i]) / span);
      bpm = 60 / span;
      const barStart = this.barStartBeat[i];
      beatInBar = beat - barStart;
      bar = lastIndexAtOrBefore(this.song.downbeats, i);
    } else if (beats.length) {
      beat = (s1 - beats[0]) * 2;
    }

    if (this.playing && !jumped) {
      const energy = this.envAt(s1);
      for (let k = Math.max(0, lastIndexAtOrBefore(beats, s0) + 1); k < beats.length && beats[k] <= s1; k++) {
        addHit(hits, 'beat', 0.5 + 0.5 * energy, wall(beats[k]));
        if (this.downbeatSet.has(k)) addHit(hits, 'downbeat', 0.5 + 0.5 * energy, wall(beats[k]));
      }
      for (const [key, type] of [['kicks', 'kick'], ['snares', 'snare'], ['hats', 'hat']] as const) {
        const times = this.hitTimes[key];
        for (let k = Math.max(0, lastIndexAtOrBefore(times, s0) + 1); k < times.length && times[k] <= s1; k++) {
          addHit(hits, type, this.song[key][k][1], wall(times[k]));
        }
      }
    }

    const sectionAt = this.song.sections.find((x) => s1 >= x.start && s1 < x.end)?.type;
    // Energy: the loudness envelope averaged over ~2 s, so looks don't flicker with every note.
    let energy = 0;
    for (let k = -10; k <= 10; k++) energy += this.envAt(s1 + k * 0.1);
    energy /= 21;
    return {
      beat, bar: Math.max(0, bar), beatInBar, phase: beat - Math.floor(beat), bpm, locked: true, ...finish(hits),
      energy, level: this.envAt(s1), bands: this.bandsAt(s1), section: sectionAt,
    };
  }
}
