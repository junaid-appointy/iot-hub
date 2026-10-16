import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { EffectRunner } from '../core/effects';
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
          const status = effects.start('club', devicesByIds(ids));
          if (!status.running) throw new DeviceError('No controllable lights to run the effect on');
          return json(res, 200, status);
        }
      }

      // Same command to many devices at once (stops any running effect first).
      if (resource === 'group' && method === 'POST') {
        const body = await readBody(req);
        const command = toCommand(body.command);
        const wasRunning = effects.getStatus().running;
        effects.stop();
        if (wasRunning) await effects.drain();
        const targets = devicesByIds(body.ids).filter((d) => d.status === 'ready');
        const results = await Promise.allSettled(targets.map((d) => hub.run(d, command)));
        const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ id: targets[i].id, name: targets[i].name, error: r.reason?.message }] : []));
        return json(res, 200, { ok: targets.length - failed.length, failed });
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
