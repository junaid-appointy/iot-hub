import fs from 'fs';
import path from 'path';
import type { Palette } from './matrix-runner';
import type { SongMap } from './music';
import { patternById } from './patterns';

/**
 * A choreographed light show: timed cues against a song.
 *
 * Stored in the repo (shows/<id>.json) next to the layout, so shows are
 * versioned and reusable. The audio itself is not stored (size, copyright):
 * we keep its name and duration so the right file can be picked and checked.
 */

export interface ShowCue {
  /** Seconds from the start of the song. */
  t: number;
  pattern: string;
  params?: Record<string, unknown>;
  /** Advance the pattern on each beat instead of on a timer. */
  stepOn?: 'timer' | 'beat';
  tickMs?: number;
  maxBrightness?: number;
  kelvin?: number;
  /** cool / warm / neutral white, or dual = the pattern's own warm/cool layer. */
  palette?: Palette;
  /** 0..1 output brightness for this cue. */
  intensity?: number;
  label?: string;
}

export interface Show extends Omit<SongMap, 'duration'> {
  version: 2;
  id: string;
  name: string;
  layout: string;
  audio: { fileName: string; duration: number };
  bpm?: number;
  /** Manual fine-tune on top of calibration (ms, + = lights later). */
  offsetMs: number;
  cues: ShowCue[];
  updatedAt?: string;
}

export function songMapOf(show: Show): SongMap {
  return { ...show, duration: show.audio.duration };
}

const SHOW_DIR = process.env.IOT_HUB_SHOWS ?? path.resolve(__dirname, '..', '..', 'shows');

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'show';

const fileFor = (id: string) => path.join(SHOW_DIR, `${slug(id)}.json`);

export function listShows(): Array<Pick<Show, 'id' | 'name' | 'audio' | 'updatedAt'> & { cues: number }> {
  if (!fs.existsSync(SHOW_DIR)) return [];
  return fs
    .readdirSync(SHOW_DIR)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const s: Show = JSON.parse(fs.readFileSync(path.join(SHOW_DIR, f), 'utf8'));
        return [{ id: s.id, name: s.name, audio: s.audio, updatedAt: s.updatedAt, cues: s.cues.length }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export function getShow(id: string): Show | undefined {
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
  } catch {
    return undefined;
  }
}

export function validateShow(input: any): Show {
  const name = String(input?.name ?? '').trim();
  if (!name) throw new Error('Give the show a name');
  const duration = Number(input?.audio?.duration);
  if (!(duration > 0)) throw new Error('Load the song first');
  const palettes = ['cool', 'warm', 'neutral', 'dual'];
  const num = (x: unknown, digits = 3) => Math.round(Number(x) * 10 ** digits) / 10 ** digits;
  const times = (xs: unknown, max: number) =>
    (Array.isArray(xs) ? xs : []).slice(0, max).map(Number).filter((t) => t >= 0 && t <= duration).map((t) => num(t));
  const hits = (xs: unknown) =>
    (Array.isArray(xs) ? xs : [])
      .slice(0, 30000)
      .filter((h) => Array.isArray(h) && Number(h[0]) >= 0 && Number(h[0]) <= duration)
      .map((h: any) => [num(h[0]), num(Math.max(0, Math.min(1, Number(h[1]) || 0)), 2)] as [number, number]);
  const envelope = (xs: unknown, max: number) =>
    (Array.isArray(xs) ? xs : []).slice(0, max).map((v) => Math.max(0, Math.min(99, Math.round(Number(v) || 0))));
  const beats = times(input.beats, 6000);
  const cues: ShowCue[] = (Array.isArray(input.cues) ? input.cues : [])
    .map((c: any) => ({
      t: Math.max(0, Math.min(duration, Number(c.t) || 0)),
      pattern: String(c.pattern),
      params: c.params && typeof c.params === 'object' ? c.params : undefined,
      stepOn: c.stepOn === 'beat' ? ('beat' as const) : ('timer' as const),
      tickMs: c.tickMs ? Math.max(100, Math.min(3000, Number(c.tickMs))) : undefined,
      maxBrightness: c.maxBrightness ? Math.max(10, Math.min(100, Number(c.maxBrightness))) : undefined,
      kelvin: c.kelvin ? Math.max(1500, Math.min(9000, Number(c.kelvin))) : undefined,
      palette: palettes.includes(c.palette) ? c.palette : undefined,
      intensity: c.intensity !== undefined ? Math.max(0.1, Math.min(1, Number(c.intensity) || 1)) : undefined,
      label: c.label ? String(c.label).slice(0, 40) : undefined,
    }))
    .filter((c: ShowCue) => patternById(c.pattern) && c.pattern !== 'draw')
    .sort((a: ShowCue, b: ShowCue) => a.t - b.t);
  return {
    version: 2,
    id: slug(input.id || name),
    name,
    layout: String(input.layout ?? 'auditorium'),
    audio: { fileName: String(input.audio.fileName ?? ''), duration: num(duration) },
    bpm: Number(input.bpm) > 0 ? num(input.bpm, 1) : undefined,
    offsetMs: Math.max(-1000, Math.min(1000, Math.round(Number(input.offsetMs) || 0))),
    beats,
    downbeats: (Array.isArray(input.downbeats) ? input.downbeats : []).map(Number).filter((i: number) => Number.isInteger(i) && i >= 0 && i < beats.length),
    kicks: hits(input.kicks),
    snares: hits(input.snares),
    hats: hits(input.hats),
    env: envelope(input.env, Math.ceil(duration * 10) + 10),
    bands: (Array.isArray(input.bands) ? input.bands : []).slice(0, 6).map((b: unknown) => envelope(b, Math.ceil(duration * 20) + 20)),
    sections: (Array.isArray(input.sections) ? input.sections : [])
      .slice(0, 200)
      .map((x: any) => ({ start: num(x.start), end: num(x.end), type: String(x.type).slice(0, 20) }))
      .filter((x: any) => x.end > x.start),
    cues,
  };
}

export function saveShow(show: Show): Show {
  const doc = { ...show, updatedAt: new Date().toISOString() };
  fs.mkdirSync(SHOW_DIR, { recursive: true });
  const file = fileFor(show.id);
  fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
  return doc;
}

export function deleteShow(id: string) {
  fs.rmSync(fileFor(id), { force: true });
}
