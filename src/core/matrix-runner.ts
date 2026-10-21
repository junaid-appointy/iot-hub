import { hsvToRgb } from '../util/color';
import { Hub } from './hub';
import { MatrixLayout, sequence } from './matrix';
import { Metronome, Music, MusicSource, Sample } from './music';
import { blank, Frame, patternById, splitLook } from './patterns';
import { Command, Device } from './types';

/**
 * Plays matrix patterns on real bulbs, in sync with music.
 *
 * Timing model: every FRAME_MS the runner renders the look for a *display time*
 * D = now + lookahead, then sends each bulb its change at D − (that bulb's
 * latency). Fast bulbs are sent later, slow bulbs earlier, so all of them change
 * at D. Music sources (show, live beat grid) can answer for future times, so
 * beats land on the beat instead of after it.
 *
 * Sends are fire-and-forget (no ack/retry); only changes are sent, plus a slow
 * refresh of unchanged state to repair lost packets.
 */

export type Palette = 'cool' | 'warm' | 'neutral' | 'dual';

export interface MatrixOptions {
  /** Timer step for basic patterns. */
  tickMs: number;
  maxBrightness: number; // 10..100
  /** Legacy single white; used when no palette is given. */
  kelvin: number;
  /** cool/warm/neutral = one white; dual = the pattern's own warm/cool layer. */
  palette: Palette;
  background: 'off' | 'dim';
  preview: boolean;
  /** 'beat': basic patterns advance one step per beat instead of on their timer. */
  stepOn: 'timer' | 'beat';
  /** Soft glow every bulb keeps (0..0.4), so no bulb ever drops to black. */
  ambient: number;
  /** Afterglow in seconds: light rises instantly and fades out like a filament. 0 = off. */
  glow: number;
}

/** What to play; set by the UI, a show's cue list or the autopilot. */
export interface Selection {
  pattern: string;
  params?: Record<string, any>;
  options?: Partial<MatrixOptions>;
  /** Changes when the selection changes (e.g. cue index). */
  key: string;
  /** 0..1 progress through this selection (e.g. through a cue), for risers. */
  progress?: number;
}

export type Director = (D: number, music: Sample) => Selection | null;

export interface Latency {
  /** Typical bulb latency (ms): command sent → light visibly changes. */
  baseMs: number;
  /** Per-bulb latency (ms) where measured. */
  perBulb: Record<string, number>;
}

export interface MatrixStatus {
  running: boolean;
  pattern?: string;
  params?: Record<string, any>;
  options?: MatrixOptions;
  tick: number;
  frame: Frame;
  warm?: Frame;
  identifying?: string;
  source: MusicSource['kind'];
  locked: boolean;
  bpm: number;
  bar: number;
  beatInBar: number;
  section?: string;
  lookaheadMs: number;
  director?: string;
}

/** Per-bulb delivery state: last command sent and the single pending one. */
interface SentState {
  key: string;
  at: number;
  /** The one command waiting to go out. `hit` = a beat/drum frame, which later frames may not overwrite. */
  pending?: { key: string; command: Extract<Command, { type: 'set' }>; at: number; timer?: NodeJS.Timeout; hit?: boolean };
  /** The newest ordinary frame that arrived while a hit was waiting; sent right after it. */
  next?: { key: string; command: Extract<Command, { type: 'set' }>; ideal: number };
}

const FRAME_MS = 40; // 25 fps render; bulbs only get changes
const RESEND_MS = 1500; // repair lost UDP packets
// At most ~16 commands/s per bulb; newer frames replace a pending one, so there's never a backlog.
const MIN_GAP_MS = 60;
/** Even hits are never sent to one bulb closer together than this. */
const HARD_GAP_MS = 30;
const PALETTE_K = { warm: 2700, neutral: 4000, cool: 6500 } as const;

export const DEFAULT_OPTIONS: MatrixOptions = {
  tickMs: 500,
  maxBrightness: 100,
  kelvin: 6500,
  palette: 'cool',
  background: 'off',
  preview: false,
  stepOn: 'timer',
  ambient: 0.1,
  glow: 0.15,
};

export function normaliseOptions(o: Partial<MatrixOptions> = {}, base: MatrixOptions = DEFAULT_OPTIONS): MatrixOptions {
  const palettes: Palette[] = ['cool', 'warm', 'neutral', 'dual'];
  const kelvin = Math.max(1500, Math.min(9000, Number(o.kelvin) || base.kelvin));
  const palette: Palette = palettes.includes(o.palette as Palette)
    ? (o.palette as Palette)
    : o.kelvin !== undefined
      ? kelvin >= 5000 ? 'cool' : kelvin <= 3000 ? 'warm' : 'neutral'
      : base.palette;
  return {
    tickMs: Math.max(100, Math.min(3000, Number(o.tickMs) || base.tickMs)),
    maxBrightness: Math.max(10, Math.min(100, Number(o.maxBrightness) || base.maxBrightness)),
    kelvin,
    palette,
    background: o.background === 'dim' ? 'dim' : o.background === 'off' ? 'off' : base.background,
    preview: o.preview === undefined ? base.preview : !!o.preview,
    stepOn: o.stepOn === 'beat' ? 'beat' : o.stepOn === 'timer' ? 'timer' : base.stepOn,
    ambient: o.ambient !== undefined && Number.isFinite(Number(o.ambient)) ? Math.max(0, Math.min(0.4, Number(o.ambient))) : base.ambient,
    glow: o.glow !== undefined && Number.isFinite(Number(o.glow)) ? Math.max(0, Math.min(1.5, Number(o.glow))) : base.glow,
  };
}

export class MatrixRunner {
  private loop?: NodeJS.Timeout;
  private stopTimer?: NodeJS.Timeout;
  private selection?: Selection;
  private options: MatrixOptions = DEFAULT_OPTIONS;
  private state: Record<string, any> = {};
  private tick = 0;
  private lastTickAt = 0;
  private canvas: Frame = [];
  private source: MusicSource = new Metronome();
  private director?: { name: string; fn: Director };
  private prevD = 0;
  private startMs = 0;
  /** Recent rendered frames, so the on-screen preview shows what's visible *now*, not the future. */
  private history: Array<{ D: number; v: Frame; w?: Frame }> = [];
  private lastMusic?: Sample;
  /** Per bulb: what was last sent, and the one command waiting to be sent (if any). */
  private sent = new Map<string, SentState>();
  /** Previous displayed frame and when, for afterglow. */
  private glowFrame?: Frame;
  private glowAt = 0;
  private timers = new Set<NodeJS.Timeout>();
  private flasher?: { id: string; timer: NodeJS.Timeout };

  constructor(
    private hub: Hub,
    private layout: () => MatrixLayout | undefined,
    private latency: () => Latency
  ) {}

  get running() {
    return !!this.loop;
  }

  get sourceKind() {
    return this.source.kind;
  }

  // ---- control -----------------------------------------------------------------

  /** Play a pattern chosen by the user (clears any director). */
  start(patternId: string, params: Record<string, any> = {}, options: Partial<MatrixOptions> = {}) {
    if (!patternById(patternId)) throw new Error(`Unknown pattern "${patternId}"`);
    this.director = undefined;
    this.select({ pattern: patternId, params, options, key: `manual:${patternId}:${Date.now()}` }, true);
    this.ensureLoop();
    return this.status();
  }

  /** Let something else pick patterns frame by frame (show cues, autopilot). */
  direct(name: string, fn: Director, baseOptions: Partial<MatrixOptions> = {}) {
    if (!this.layout()) throw new Error('Set up the matrix layout first');
    this.stopIdentify();
    this.director = { name, fn };
    this.options = normaliseOptions(baseOptions, this.options);
    this.selection = undefined;
    this.ensureLoop();
    return this.status();
  }

  /** Change speed/brightness/params of what's playing without restarting it. */
  update(params?: Record<string, any>, options?: Partial<MatrixOptions>) {
    if (options) this.options = normaliseOptions(options, this.options);
    if (params && this.selection) {
      this.selection = { ...this.selection, params };
      this.state = {}; // content changed: restart the pattern's own state
    }
    if (options?.preview === false) this.sent.clear();
    return this.status();
  }

  setSource(source: MusicSource) {
    this.source = source;
    this.prevD = 0;
  }

  stop() {
    clearInterval(this.loop);
    clearTimeout(this.stopTimer);
    this.loop = this.stopTimer = undefined;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.selection = undefined;
    this.director = undefined;
    this.history = [];
    this.glowFrame = undefined;
    this.glowAt = 0;
    this.sent.clear();
    return this.status();
  }

  private ensureLoop() {
    const layout = this.layout();
    if (!layout) throw new Error('Set up the matrix layout first');
    this.stopIdentify();
    if (this.canvas.length !== layout.rows || this.canvas[0]?.length !== layout.cols) this.canvas = blank(layout.rows, layout.cols);
    if (this.loop) return;
    this.sent.clear(); // bulbs may have been changed by something else since
    this.prevD = 0;
    this.startMs = Date.now();
    this.render();
    this.loop = setInterval(() => this.render(), FRAME_MS);
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.stop(), 3 * 60 * 60_000); // never run forever by accident
  }

  private select(sel: Selection, reset: boolean) {
    const changed = !this.selection || this.selection.key !== sel.key;
    this.selection = sel;
    if (sel.options) this.options = normaliseOptions(sel.options, reset ? normaliseOptions(sel.options, this.options) : this.options);
    if (changed || reset) {
      this.state = {};
      this.tick = 0;
      this.lastTickAt = Date.now();
    }
  }

  // ---- draw mode -----------------------------------------------------------------

  setPixel(row: number, col: number, value: number) {
    const layout = this.layout();
    if (!layout) return;
    if (this.canvas.length !== layout.rows || this.canvas[0]?.length !== layout.cols) this.canvas = blank(layout.rows, layout.cols);
    if (this.canvas[row]?.[col] === undefined) return;
    this.canvas[row][col] = Math.max(0, Math.min(1, value));
  }

  clearCanvas() {
    const layout = this.layout();
    if (layout) this.canvas = blank(layout.rows, layout.cols);
  }

  // ---- rendering -----------------------------------------------------------------

  /** Per-bulb latency and the lookahead needed to cover the slowest bulb. */
  private timing() {
    const lat = this.latency();
    const values = Object.values(lat.perBulb);
    const max = Math.max(lat.baseMs, ...values);
    // One extra frame: a hit at the very start of a frame still needs its full send-ahead time.
    return { lat, lookahead: Math.min(1500, Math.round(max + FRAME_MS + 10)) };
  }

  private render() {
    const layout = this.layout();
    if (!layout) return this.stop();
    const now = Date.now();
    const { lat, lookahead } = this.timing();
    const D = now + lookahead;
    const prevD = this.prevD || D - FRAME_MS;
    this.prevD = D;

    const sample = this.source.sample(prevD, D);
    this.lastMusic = sample;

    if (this.director) {
      const sel = this.director.fn(D, sample);
      if (!sel) {
        this.history.push({ D, v: blank(layout.rows, layout.cols) });
        this.trimHistory(now);
        this.dispatch(layout, blank(layout.rows, layout.cols), undefined, D, lat);
        return;
      }
      this.select(sel, false);
      if (sel.progress !== undefined) this.selection = { ...this.selection!, progress: sel.progress };
    }
    const pattern = this.selection && patternById(this.selection.pattern);
    if (!pattern) return;

    // Basic patterns step on their timer, or once per beat.
    if (this.options.stepOn === 'beat') {
      if (sample.hits.beat) this.tick++;
    } else if (now - this.lastTickAt >= this.options.tickMs) {
      this.tick += Math.floor((now - this.lastTickAt) / this.options.tickMs);
      this.lastTickAt = now;
    }

    const music: Music = { ...sample, t: (D - this.startMs) / 1000, progress: this.selection?.progress ?? sample.progress ?? 0 };
    const look = splitLook(
      pattern.frame({
        rows: layout.rows, cols: layout.cols, tick: this.tick, seq: sequence(layout),
        params: this.selection!.params ?? {}, state: this.state, canvas: this.canvas, music,
      })
    );
    let v = look.v.map((row) => row.map((x) => Math.max(0, Math.min(1, Number(x) || 0))));
    const w = look.w?.map((row) => row.map((x) => Math.max(0, Math.min(1, Number(x) || 0))));
    // Afterglow: light rises at once but fades with a time constant, like a filament cooling.
    // It also crossfades smoothly when the look changes.
    const o = this.options;
    const dt = this.glowAt ? Math.max(0, (now - this.glowAt) / 1000) : 0;
    this.glowAt = now;
    const prevGlow = this.glowFrame;
    if (o.glow > 0 && prevGlow && prevGlow.length === v.length && prevGlow[0]?.length === v[0]?.length) {
      const k = Math.exp(-dt / o.glow);
      v = v.map((row, r) => row.map((x, c) => Math.max(x, prevGlow[r][c] * k)));
    }
    this.glowFrame = v;
    // Ambient floor: every bulb keeps a soft glow, so the whole wall stays alive.
    if (o.ambient > 0) v = v.map((row) => row.map((x) => o.ambient + (1 - o.ambient) * x));
    // A frame with a hit is shown on the hit's exact time, not at the frame edge (up to 40 ms later).
    const hitFrame = sample.hitAt !== undefined && sample.hitAt > prevD - FRAME_MS && sample.hitAt <= D;
    const showAt = hitFrame ? sample.hitAt! : D;
    this.history.push({ D: showAt, v, w });
    this.trimHistory(now);
    this.dispatch(layout, v, w, showAt, lat, hitFrame);
  }

  private trimHistory(now: number) {
    // Keep the newest frame that's already visible plus everything still in the future.
    let firstVisible = -1;
    for (let i = 0; i < this.history.length; i++) if (this.history[i].D <= now) firstVisible = i;
    if (firstVisible > 0) this.history.splice(0, firstVisible);
  }

  private dispatch(layout: MatrixLayout, v: Frame, w: Frame | undefined, D: number, lat: Latency, urgent = false) {
    if (this.options.preview) return;
    const devices = new Map(this.hub.devices().map((d) => [d.id, d]));
    const now = Date.now();
    layout.cells.forEach((row, r) =>
      row.forEach((id, c) => {
        const device = id && devices.get(id);
        if (!device || device.status !== 'ready') return;
        const command = this.commandFor(device, v[r]?.[c] ?? 0, w?.[r]?.[c], r, c, layout);
        const key = JSON.stringify(command);
        const st = this.sent.get(device.id) ?? { key: '', at: 0 };
        this.sent.set(device.id, st);
        const ideal = D - (lat.perBulb[device.id] ?? lat.baseMs);
        const p = st.pending;
        if (p) {
          // A waiting hit is never overwritten; the newest ordinary frame follows right after it.
          if (p.hit && !urgent) {
            st.next = { key, command, ideal };
            return;
          }
          if (p.key === key) return;
          // Otherwise a newer frame replaces what's waiting but keeps its time slot, so a
          // constantly changing look can never postpone a bulb forever.
          p.key = key;
          p.command = command;
          if (urgent) {
            p.hit = true;
            st.next = undefined;
            if (ideal < p.at - 2) this.schedule(device, st, Math.max(now, ideal, st.at + HARD_GAP_MS));
          }
          return;
        }
        if (st.key === key && now - st.at < RESEND_MS) return;
        // Hits go out at their exact time; smooth changes respect the per-bulb rate limit.
        st.pending = { key, command, at: 0, hit: urgent };
        this.schedule(device, st, Math.max(now, ideal, st.at + (urgent ? HARD_GAP_MS : MIN_GAP_MS)));
      })
    );
  }

  /** (Re)arm the bulb's single pending send for time `at`; it sends whatever is pending then. */
  private schedule(device: Device, st: SentState, at: number) {
    const p = st.pending!;
    if (p.timer) {
      clearTimeout(p.timer);
      this.timers.delete(p.timer);
    }
    p.at = at;
    const fire = () => {
      const cur = st.pending;
      if (!cur) return;
      st.pending = undefined;
      st.key = cur.key;
      st.at = Date.now();
      this.hub.stream(device, cur.command);
      // Whatever arrived while a hit was waiting goes next, at the normal rate.
      const nx = st.next;
      st.next = undefined;
      if (nx && nx.key !== st.key) {
        st.pending = { key: nx.key, command: nx.command, at: 0 };
        this.schedule(device, st, Math.max(Date.now(), nx.ideal, st.at + MIN_GAP_MS));
      }
    };
    const wait = at - Date.now();
    if (wait < 4) return fire();
    const t = setTimeout(() => {
      this.timers.delete(t);
      fire();
    }, wait);
    this.timers.add(t);
    p.timer = t;
  }

  private commandFor(device: Device, v: number, w: number | undefined, r: number, c: number, layout: MatrixLayout): Extract<Command, { type: 'set' }> {
    const o = this.options;
    if (v <= 0.04) return o.background === 'dim' ? { type: 'set', on: true, brightness: 10, kelvin: 2700 } : { type: 'set', on: false };
    // 5 % steps: smooth enough to look continuous, coarse enough to keep traffic down.
    const brightness = Math.max(10, Math.round((v * o.maxBrightness) / 5) * 5);
    if (device.capabilities.includes('color')) {
      const hue = ((r * layout.cols + c) * (360 / (layout.rows * layout.cols)) + (this.lastMusic?.beat ?? 0) * 20) % 360;
      return { type: 'set', on: true, brightness, rgb: hsvToRgb(hue, 1, 1) };
    }
    const [minK, maxK] = device.colorTempRange ?? [2700, 6500];
    let kelvin: number;
    if (o.palette === 'dual') kelvin = minK + (w ?? 1) * (maxK - minK);
    else if (o.palette === 'neutral') kelvin = PALETTE_K.neutral;
    else kelvin = o.palette === 'warm' ? minK : o.palette === 'cool' ? maxK : o.kelvin;
    return { type: 'set', on: true, brightness, kelvin: Math.round(kelvin / 100) * 100 };
  }

  // ---- status / preview ----------------------------------------------------------

  status(): MatrixStatus {
    const now = Date.now();
    let shown = this.history[0];
    for (const h of this.history) if (h.D <= now) shown = h;
    const m = this.lastMusic;
    return {
      running: this.running,
      pattern: this.selection?.pattern,
      params: this.selection?.params,
      options: this.options,
      tick: this.tick,
      frame: shown?.v ?? [],
      warm: shown?.w,
      identifying: this.flasher?.id,
      source: this.source.kind,
      locked: !!m?.locked,
      bpm: Math.round((m?.bpm ?? 0) * 10) / 10,
      bar: m?.bar ?? 0,
      beatInBar: m ? Math.floor(m.beatInBar) : 0,
      section: m?.section,
      lookaheadMs: this.timing().lookahead,
      director: this.director?.name,
    };
  }

  // ---- identify (used to map bulbs to cells) --------------------------------------

  /** Flash one bulb on/off until stopped, so the user can spot it. Stops any running pattern. */
  identify(device: Device) {
    this.stop();
    this.stopIdentify();
    let on = false;
    const flash = () => {
      on = !on;
      this.hub.run(device, on ? { type: 'set', on: true, brightness: 100, kelvin: 6500 } : { type: 'set', on: false }, { fast: true }).catch(() => {});
    };
    flash();
    this.flasher = { id: device.id, timer: setInterval(flash, 600) };
    return this.status();
  }

  /** Stop flashing and leave the bulb in `after` state. */
  async stopIdentify(after?: 'off' | 'dim' | 'on') {
    const f = this.flasher;
    if (!f) return;
    clearInterval(f.timer);
    this.flasher = undefined;
    if (!after) return;
    const device = this.hub.devices().find((d) => d.id === f.id);
    if (!device) return;
    const command: Command =
      after === 'off' ? { type: 'set', on: false } : after === 'dim' ? { type: 'set', on: true, brightness: 20, kelvin: 2700 } : { type: 'set', on: true, brightness: 100, kelvin: 4000 };
    // The last flash frame may still be in flight; give it a moment so this lands last.
    await new Promise((r) => setTimeout(r, 300));
    await this.hub.run(device, command).catch(() => {});
  }

  /** Flash every mapped bulb at exact wall-clock times (for tap calibration). */
  flashAt(times: number[], onMs = 160) {
    const layout = this.layout();
    if (!layout) throw new Error('Set up the matrix layout first');
    this.stop();
    const ids = new Set(layout.cells.flat().filter(Boolean) as string[]);
    const devices = this.hub.devices().filter((d) => ids.has(d.id) && d.status === 'ready');
    const now = Date.now();
    const at = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        fn();
      }, Math.max(0, ms - now));
      this.timers.add(t);
    };
    for (const time of times) {
      at(time, () => devices.forEach((d) => this.hub.stream(d, { type: 'set', on: true, brightness: 100, kelvin: 6500 })));
      at(time + onMs, () => devices.forEach((d) => this.hub.stream(d, { type: 'set', on: false })));
    }
    return { bulbs: devices.length };
  }
}
