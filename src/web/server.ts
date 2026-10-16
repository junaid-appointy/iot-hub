import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { EffectRunner } from '../core/effects';
import { assign, assignedIds, createLayout, numberGrid, validateLayout } from '../core/matrix';
import { latencyFor, lightLatencyFromTaps, measureNetwork } from '../core/calibration';
import { Autopilot, showDirector } from '../core/directors';
import { MatrixRunner, normaliseOptions } from '../core/matrix-runner';
import { LiveClock, Metronome, ShowClock } from '../core/music';
import { PATTERNS } from '../core/patterns';
import { deleteShow, getShow, listShows, saveShow, Show, songMapOf, validateShow } from '../core/shows';
import { Hub } from '../core/hub';
import { Command, Device, DeviceError, SetupIO } from '../core/types';
import { parseColor } from '../util/color';
import { settleAll } from '../util/net';

/**
 * Local web UI: a JSON API over the Hub plus a single static page.
 * Guided setup runs as a "session": the driver's SetupIO calls become events
 * streamed to the browser (SSE), and the browser posts answers back.
 */

type SetupEvent = Record<string, unknown> & { kind: string };

class SetupSession {
  readonly id = crypto.randomUUID();
  events: SetupEvent[] = [];
  private listeners = new Set<(e: SetupEvent) => void>();
  private pending?: { resolve: (v: unknown) => void; reject: (e: Error) => void };
  finished = false;

  emit(e: SetupEvent) {
    this.events.push(e);
    this.listeners.forEach((l) => l(e));
  }

  subscribe(l: (e: SetupEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private request<T>(e: SetupEvent): Promise<T> {
    this.emit(e);
    return new Promise<T>((resolve, reject) => (this.pending = { resolve: resolve as (v: unknown) => void, reject }));
  }

  answer(value: unknown) {
    const p = this.pending;
    this.pending = undefined;
    p?.resolve(value);
  }

  cancel() {
    const p = this.pending;
    this.pending = undefined;
    p?.reject(new Error('Cancelled'));
  }

  io(): SetupIO {
    return {
      info: (message) => this.emit({ kind: 'info', message }),
      warn: (message) => this.emit({ kind: 'warn', message }),
      success: (message) => this.emit({ kind: 'success', message }),
      steps: (title, steps) => this.emit({ kind: 'steps', title, steps }),
      ask: async (question, opts = {}) => {
        for (;;) {
          const v = String((await this.request<string>({ kind: 'ask', question, secret: !!opts.secret, default: opts.default })) ?? '').trim() || opts.default || '';
          const error = !v ? 'A value is required' : opts.validate?.(v);
          if (!error) return v;
          this.emit({ kind: 'warn', message: error });
        }
      },
      confirm: async (question, def = true) => Boolean(await this.request<boolean>({ kind: 'confirm', question, default: def })),
      choose: async (question, options) => {
        const i = Number(await this.request<number>({ kind: 'choose', question, options: options.map((o) => ({ label: o.label, hint: o.hint })) }));
        return options[Math.max(0, Math.min(options.length - 1, i))].value;
      },
      wait: async (message, task) => {
        this.emit({ kind: 'wait', message });
        try {
          return await task((m) => this.emit({ kind: 'wait', message: m }));
        } finally {
          this.emit({ kind: 'wait-done' });
        }
      },
    };
  }
}

/** Devices without driver config — that's where keys and tokens live. */
const publicDevice = ({ config, ...d }: Device) => d;

function errorBody(e: any) {
  return { error: e?.message ?? String(e), hint: e instanceof DeviceError ? e.hint : undefined };
}

function toCommand(body: any): Command {
  switch (body?.type) {
    case 'power':
      return { type: 'power', on: !!body.on };
    case 'toggle':
      return { type: 'toggle' };
    case 'brightness':
      return { type: 'brightness', value: Number(body.value) };
    case 'color':
      return { type: 'color', rgb: parseColor(String(body.color)) };
    case 'color_temp':
      return { type: 'color_temp', kelvin: Number(body.kelvin) };
    case 'scene':
      return { type: 'scene', scene: String(body.scene) };
    case 'set':
      return {
        type: 'set',
        on: body.on === undefined ? undefined : !!body.on,
        brightness: body.brightness === undefined ? undefined : Number(body.brightness),
        kelvin: body.kelvin === undefined ? undefined : Number(body.kelvin),
        rgb: body.color ? parseColor(String(body.color)) : undefined,
      };
    default:
      throw new DeviceError(`Unknown command "${body?.type}"`);
  }
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export function startServer(opts: { port: number; open: boolean; hub?: Hub }) {
  const hub = opts.hub ?? new Hub();
  const sessions = new Map<string, SetupSession>();
  const effects = new EffectRunner(hub);
  const matrix = new MatrixRunner(hub, () => hub.store.layout(), () => latencyFor(hub.store.layout()));
  // Music sources: live sound from the browser, or a show being played.
  const live = new LiveClock();
  let autopilot: Autopilot | undefined;
  let show: { data: Show; clock: ShowClock; options: ReturnType<typeof normaliseOptions> } | undefined;
  const useMetronome = () => {
    show = undefined;
    autopilot = undefined;
    matrix.setSource(new Metronome());
  };
  /** Only one thing drives the lights at a time. */
  const stopAllEffects = async () => {
    const wasRunning = effects.getStatus().running;
    effects.stop();
    matrix.stop();
    useMetronome();
    await matrix.stopIdentify();
    if (wasRunning) await effects.drain();
  };
  const matrixStatus = () => ({
    ...matrix.status(),
    autopilot: autopilot?.snapshot(),
    show: show ? { id: show.data.id, playing: show.clock.playing, songTime: Math.max(0, show.clock.songTime(Date.now())) } : undefined,
    liveLocked: live.isLocked,
  });
  const matrixInfo = () => {
    const layout = hub.store.layout();
    const used = layout ? assignedIds(layout) : new Set<string>();
    return {
      layout: layout ?? null,
      numbers: layout ? numberGrid(layout) : [],
      lights: hub
        .devices()
        .filter((d) => d.status === 'ready' && d.kind === 'light')
        .map((d) => ({ id: d.id, name: d.name, address: d.address, assigned: used.has(d.id), capabilities: d.capabilities })),
      patterns: PATTERNS.map(({ id, name, description, params, category }) => ({ id, name, description, params: params ?? [], category: category ?? 'basic' })),
      status: matrixStatus(),
      calibration: layout?.calibration ?? null,
      latency: latencyFor(layout),
    };
  };
  const devicesByIds = (ids: unknown) =>
    Array.isArray(ids) ? hub.devices().filter((d) => ids.includes(d.id)) : hub.devices();

  // One scan at a time, shared by the Scan button and the background rescan.
  let scanning: ReturnType<Hub['scan']> | undefined;
  const scan = (timeoutMs: number) => {
    scanning ??= hub.scan({ timeoutMs }).finally(() => (scanning = undefined));
    return scanning;
  };
  // Devices switched on later (e.g. at the wall) show up without a manual rescan.
  const BACKGROUND_SCAN_MS = 2 * 60_000;
  setInterval(() => scan(5000).catch(() => {}), BACKGROUND_SCAN_MS).unref();
  const page = path.join(__dirname, 'ui.html');

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const device = (id: string) => {
    const d = hub.devices().find((x) => x.id === id);
    if (!d) throw new DeviceError('Device not found — it may have been removed. Rescan.');
    return d;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && url.pathname === '/audio.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(__dirname, 'audio.js')));
      }
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(page));
      }
      if (parts[0] !== 'api') return json(res, 404, { error: 'Not found' });
      const [, resource, id, action] = parts;

      if (resource === 'devices' && !id && method === 'GET') {
        return json(res, 200, { devices: hub.devices().map(publicDevice) });
      }

      if (resource === 'states' && method === 'GET') {
        const ids = url.searchParams.get('ids')?.split(',');
        const targets = hub.devices().filter((d) => d.status === 'ready' && (!ids || ids.includes(d.id)));
        const entries = await settleAll(targets.map(async (d) => [d.id, await hub.state(d)] as const));
        return json(res, 200, { states: Object.fromEntries(entries) });
      }

      if (resource === 'scan' && method === 'POST') {
        const body = await readBody(req);
        const result = await scan(Math.min(60, Math.max(2, Number(body.timeout) || 8)) * 1000);
        return json(res, 200, {
          devices: result.devices.map(publicDevice),
          added: result.added.map((d) => d.id),
          states: Object.fromEntries(result.states),
          unknown: result.unknown,
          errors: result.errors,
        });
      }

      if (resource === 'add' && method === 'POST') {
        const { ip, driver } = await readBody(req);
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(String(ip ?? ''))) throw new DeviceError('Enter an IPv4 address like 192.168.1.40');
        const { devices, hints } = await hub.probe(ip, driver || undefined);
        return json(res, 200, { devices: devices.map(publicDevice), hints });
      }

      if (resource === 'effect') {
        if (method === 'GET') return json(res, 200, effects.getStatus());
        if (method === 'DELETE') return json(res, 200, effects.stop());
        if (method === 'POST') {
          const { effect, ids } = await readBody(req);
          if (effect !== 'club') throw new DeviceError(`Unknown effect "${effect}"`);
          matrix.stop();
          await matrix.stopIdentify();
          const status = effects.start('club', devicesByIds(ids));
          if (!status.running) throw new DeviceError('No controllable lights to run the effect on');
          return json(res, 200, status);
        }
      }

      // Same command to many devices at once (stops any running effect first).
      if (resource === 'group' && method === 'POST') {
        const body = await readBody(req);
        const command = toCommand(body.command);
        await stopAllEffects();
        const targets = devicesByIds(body.ids).filter((d) => d.status === 'ready');
        const results = await Promise.allSettled(targets.map((d) => hub.run(d, command)));
        const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ id: targets[i].id, name: targets[i].name, error: r.reason?.message }] : []));
        return json(res, 200, { ok: targets.length - failed.length, failed });
      }

      if (resource === 'matrix') {
        const body = method === 'GET' ? {} : await readBody(req);
        const layout = hub.store.layout();
        const need = () => {
          if (!layout) throw new DeviceError('Create the matrix first');
          return layout;
        };
        switch (`${method} ${id ?? ''}`) {
          case 'GET ':
            return json(res, 200, matrixInfo());
          case 'GET status':
            return json(res, 200, matrixStatus());
          case 'POST source':
            // 'live' while the Audio tab listens; 'metronome' otherwise (keeps music patterns moving at 120 BPM).
            if (body.kind === 'live') {
              show = undefined;
              matrix.setSource(live);
            } else useMetronome();
            return json(res, 200, matrixStatus());
          case 'POST autopilot': {
            need();
            effects.stop();
            if (!body.on) {
              autopilot = undefined;
              matrix.stop();
              return json(res, 200, matrixStatus());
            }
            show = undefined;
            matrix.setSource(live);
            autopilot = new Autopilot();
            matrix.direct('autopilot', autopilot.director, body.options ?? {});
            return json(res, 200, matrixStatus());
          }
          case 'GET calibration':
            return json(res, 200, { calibration: layout?.calibration ?? null, latency: latencyFor(layout) });
          case 'POST calibrate-network': {
            const l = need();
            await stopAllEffects();
            const result = await measureNetwork(hub, l);
            const fresh = hub.store.layout()!;
            hub.store.saveLayout({ ...fresh, calibration: { ...fresh.calibration, bulbs: result.bulbs, networkMeasuredAt: new Date().toISOString() } });
            return json(res, 200, { ...result, latency: latencyFor(hub.store.layout()) });
          }
          case 'POST calibrate-flash':
            need();
            effects.stop();
            useMetronome();
            return json(res, 200, matrix.flashAt((Array.isArray(body.times) ? body.times : []).map(Number).filter((t: number) => t > Date.now() - 1000).slice(0, 40), Number(body.onMs) || 160));
          case 'POST calibrate-taps': {
            const l = need();
            const audioTapMs = Number(body.audioTapMs), lightTapMs = Number(body.lightTapMs), outputLatencyMs = Math.max(0, Number(body.outputLatencyMs) || 0);
            if (!Number.isFinite(audioTapMs) || !Number.isFinite(lightTapMs)) throw new DeviceError('Tap results are missing');
            const lightLatencyMs = lightLatencyFromTaps(audioTapMs, lightTapMs, outputLatencyMs);
            hub.store.saveLayout({
              ...l,
              calibration: {
                ...l.calibration,
                lightLatencyMs,
                lightSource: 'tap',
                lightMeasuredAt: new Date().toISOString(),
                tap: { audioTapMs: Math.round(audioTapMs), lightTapMs: Math.round(lightTapMs), outputLatencyMs: Math.round(outputLatencyMs), taps: Number(body.taps) || 0 },
              },
            });
            return json(res, 200, { lightLatencyMs, latency: latencyFor(hub.store.layout()) });
          }
          case 'POST create': {
            const rows = Number(body.rows) || 9, cols = Number(body.cols) || 6;
            hub.store.saveLayout(validateLayout({ ...createLayout(rows, cols), cells: layout?.cells, numbering: layout?.numbering }));
            return json(res, 200, matrixInfo());
          }
          case 'PUT ':
            hub.store.saveLayout(validateLayout({ ...need(), ...body, cells: body.cells ?? need().cells }));
            return json(res, 200, matrixInfo());
          case 'POST assign': {
            const l = need();
            const row = Number(body.row), col = Number(body.col);
            if (!(row >= 0 && row < l.rows && col >= 0 && col < l.cols)) throw new DeviceError('That cell is outside the grid');
            if (body.id && !hub.devices().some((d) => d.id === body.id)) throw new DeviceError('Unknown bulb');
            hub.store.saveLayout(assign(l, row, col, body.id || null));
            return json(res, 200, matrixInfo());
          }
          case 'POST clear-map':
            hub.store.saveLayout({ ...need(), cells: need().cells.map((r) => r.map(() => null)) });
            return json(res, 200, matrixInfo());
          case 'POST identify': {
            const d = hub.devices().find((x) => x.id === body.id);
            if (!d) throw new DeviceError('Unknown bulb');
            effects.stop();
            return json(res, 200, matrix.identify(d));
          }
          case 'POST identify-stop':
            await matrix.stopIdentify(['off', 'dim', 'on'].includes(body.after) ? body.after : undefined);
            return json(res, 200, matrix.status());
          case 'POST prepare-mapping': {
            // Mapped bulbs dim warm, unmapped off: the room shows progress and the flashing bulb stands out.
            await stopAllEffects();
            const used = assignedIds(need());
            const lights = hub.devices().filter((d) => d.status === 'ready' && d.kind === 'light');
            const results = await Promise.allSettled(
              lights.map((d) => hub.run(d, used.has(d.id) ? { type: 'set', on: true, brightness: 20, kelvin: 2700 } : { type: 'set', on: false }))
            );
            return json(res, 200, { ok: results.filter((r) => r.status === 'fulfilled').length, failed: results.filter((r) => r.status === 'rejected').length });
          }
          case 'POST play':
            need();
            effects.stop();
            autopilot = undefined;
            await matrix.stopIdentify();
            return json(res, 200, { ...matrix.start(String(body.pattern), body.params ?? {}, body.options ?? {}), autopilot: undefined });
          case 'POST update':
            if (show && body.options) show.options = normaliseOptions(body.options, show.options);
            matrix.update(body.params, body.options);
            return json(res, 200, matrixStatus());
          case 'POST stop':
            matrix.stop();
            autopilot = undefined;
            if (show) show.clock.playing = false;
            return json(res, 200, matrixStatus());
          case 'POST pixel':
            matrix.setPixel(Number(body.row), Number(body.col), Number(body.value));
            return json(res, 200, matrix.status());
          case 'POST clear-canvas':
            matrix.clearCanvas();
            return json(res, 200, matrix.status());
        }
      }

      // Live sound features from the browser (mic or a playing file). Sent ~10x/s; beats immediately.
      // Live sound from the browser: levels/bands ~10x/s, plus the beat tracker's
      // tempo grid when locked and drum hits (kick/snare/hat) as they're heard.
      if (resource === 'audio' && method === 'POST') {
        const body = await readBody(req);
        if (Array.isArray(body.bands)) live.setFeatures(Math.max(0, Math.min(1, Number(body.level) || 0)), body.bands.slice(0, 6).map((v: unknown) => Math.max(0, Math.min(1, Number(v) || 0))));
        if (body.grid !== undefined) live.setGrid(body.grid);
        if (Array.isArray(body.hits)) live.push(body.hits.filter((h: any) => ['beat', 'downbeat', 'kick', 'snare', 'hat'].includes(h?.type)).map((h: any) => ({ at: Number(h.at), type: h.type, strength: Number(h.strength) || 0.7 })));
        res.writeHead(204).end();
        return;
      }

      // Show playback runs here, on the server clock: the browser only reports
      // where the song is (anchorMs = wall time at which song time 0 is heard).
      if (resource === 'show') {
        const body = method === 'POST' ? await readBody(req) : {};
        if (method === 'POST' && id === 'play') {
          const data = validateShow(body.show);
          effects.stop();
          autopilot = undefined;
          await matrix.stopIdentify();
          const clock = new ShowClock(songMapOf(data));
          clock.anchorMs = Number(body.anchorMs) + data.offsetMs;
          clock.playing = true;
          const options = normaliseOptions(body.options ?? {});
          show = { data, clock, options };
          matrix.setSource(clock);
          matrix.direct('show', showDirector(clock, () => show?.data.cues ?? [], () => show?.options ?? options), options);
          return json(res, 200, matrixStatus());
        }
        if (method === 'POST' && id === 'sync') {
          if (show) {
            if (body.anchorMs !== undefined) show.clock.anchorMs = Number(body.anchorMs) + show.data.offsetMs;
            if (body.playing !== undefined) show.clock.playing = !!body.playing;
          }
          return json(res, 200, matrixStatus());
        }
        if (method === 'POST' && id === 'edit') {
          // Live edits while playing: new cues / offset take effect on the next frame.
          if (show) {
            const merged = validateShow({ ...show.data, ...body, id: show.data.id });
            const anchorBase = show.clock.anchorMs - show.data.offsetMs;
            show.data = merged;
            show.clock.anchorMs = anchorBase + merged.offsetMs;
          }
          return json(res, 200, matrixStatus());
        }
        if (method === 'POST' && id === 'stop') {
          matrix.stop();
          useMetronome();
          return json(res, 200, matrixStatus());
        }
      }

      if (resource === 'shows') {
        if (method === 'GET' && !id) return json(res, 200, { shows: listShows() });
        if (method === 'GET' && id) {
          const show = getShow(id);
          return show ? json(res, 200, show) : json(res, 404, { error: 'Show not found' });
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          const show = validateShow({ ...body, id: id ?? body.id });
          return json(res, 200, saveShow(show));
        }
        if (method === 'DELETE' && id) {
          deleteShow(id);
          return json(res, 200, { ok: true });
        }
      }

      if (resource === 'drivers' && method === 'GET') {
        return json(res, 200, {
          drivers: hub.drivers.map((d) => ({ id: d.id, name: d.name, kinds: d.kinds, troubleshooting: d.troubleshooting, needsSetup: !!d.setup })),
        });
      }

      if (resource === 'devices' && id) {
        const d = device(id);
        if (action === 'command' && method === 'POST') {
          await hub.run(d, toCommand(await readBody(req)));
          return json(res, 200, { ok: true, state: await hub.state(d) });
        }
        if (action === 'state' && method === 'GET') return json(res, 200, { state: await hub.state(d) });
        if (action === 'rename' && method === 'POST') {
          const { name } = await readBody(req);
          if (!String(name ?? '').trim()) throw new DeviceError('Name cannot be empty');
          hub.rename(d, String(name).trim());
          return json(res, 200, { device: publicDevice(device(id)) });
        }
        if (!action && method === 'DELETE') {
          hub.remove(d);
          return json(res, 200, { ok: true });
        }
        if (action === 'setup' && method === 'POST') {
          const session = new SetupSession();
          sessions.set(session.id, session);
          hub
            .setup(d, session.io())
            .then((result) => session.emit({ kind: 'done', devices: result.map(publicDevice) }))
            .catch((e) => session.emit({ kind: e.message === 'Cancelled' ? 'cancelled' : 'error', ...errorBody(e) }))
            .finally(() => {
              session.finished = true;
              setTimeout(() => sessions.delete(session.id), 5 * 60_000);
            });
          return json(res, 200, { session: session.id });
        }
      }

      if (resource === 'setup' && id) {
        const session = sessions.get(id);
        if (!session) return json(res, 404, { error: 'Setup session expired' });
        if (action === 'events' && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          const send = (e: SetupEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
          session.events.forEach(send);
          const unsubscribe = session.subscribe(send);
          const ping = setInterval(() => res.write(': ping\n\n'), 15000);
          req.on('close', () => {
            unsubscribe();
            clearInterval(ping);
          });
          return;
        }
        if (action === 'answer' && method === 'POST') {
          session.answer((await readBody(req)).value);
          return json(res, 200, { ok: true });
        }
        if (action === 'cancel' && method === 'POST') {
          session.cancel();
          return json(res, 200, { ok: true });
        }
      }

      json(res, 404, { error: 'Not found' });
    } catch (e: any) {
      json(res, e instanceof DeviceError ? 400 : 500, errorBody(e));
    }
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${opts.port} is busy — another iot-hub UI may already be running at http://localhost:${opts.port}. Or use another port: npm run ui -- --port ${opts.port + 1}`);
    else console.error(e.message);
    process.exit(1);
  });

  server.listen(opts.port, '127.0.0.1', () => {
    const url = `http://localhost:${opts.port}`;
    console.log(`iot-hub UI running at ${url}  (Ctrl+C to stop)`);
    if (opts.open) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
      exec(`${cmd} ${url}`);
    }
  });
  return server;
}
