import dgram from 'dgram';
import net from 'net';
import os from 'os';
import http from 'http';
import crypto from 'crypto';

/** Broadcast addresses of every active IPv4 interface, plus the global one. */
export function broadcastAddresses(): string[] {
  const out = new Set<string>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const ip = ipToInt(i.address);
      const mask = ipToInt(i.netmask);
      out.add(intToIp((ip | ~mask) >>> 0));
    }
  }
  out.add('255.255.255.255');
  return [...out];
}

export function localIPv4(): string | undefined {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return undefined;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export const isIPv4 = (s: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a datagram to several targets (broadcast/multicast) and collect every
 * reply until the timeout. Sends twice because UDP on Wi-Fi drops packets.
 */
export function udpCollect(opts: {
  port: number;
  targets: string[];
  payload: Buffer;
  timeoutMs: number;
  bindPort?: number;
  onMessage: (msg: Buffer, rinfo: dgram.RemoteInfo) => void;
}): Promise<void> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve();
    };
    const timer = setTimeout(finish, opts.timeoutMs);
    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      try {
        opts.onMessage(msg, rinfo);
      } catch {
        // malformed packet from some random device — ignore
      }
    });
    socket.bind(opts.bindPort ?? 0, () => {
      try {
        socket.setBroadcast(true);
      } catch {}
      const send = () => {
        if (done) return;
        for (const t of opts.targets) socket.send(opts.payload, opts.port, t, () => {});
      };
      send();
      setTimeout(send, Math.min(1000, opts.timeoutMs / 3));
    });
  });
}

/** Listen on a port without sending anything (for devices that announce themselves). */
export function udpListen(port: number, timeoutMs: number, onMessage: (msg: Buffer, rinfo: dgram.RemoteInfo) => void): Promise<void> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      try {
        socket.close();
      } catch {}
      resolve();
    };
    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      try {
        onMessage(msg, rinfo);
      } catch {}
    });
    socket.bind(port, () => setTimeout(finish, timeoutMs));
  });
}

/** Unicast request/response over UDP with retries. `accept` filters unrelated packets. */
export function udpRequest(
  ip: string,
  port: number,
  payload: Buffer,
  opts: { timeoutMs?: number; retries?: number; accept?: (msg: Buffer) => boolean } = {}
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const retries = opts.retries ?? 2;
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let attempt = 0;
    let timer: NodeJS.Timeout;
    const finish = (err: Error | null, msg?: Buffer) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      err ? reject(err) : resolve(msg!);
    };
    const send = () => {
      attempt++;
      socket.send(payload, port, ip, (err) => err && finish(err));
      timer = setTimeout(() => {
        if (attempt > retries) finish(new Error(`No response from ${ip}:${port}`));
        else send();
      }, timeoutMs);
    };
    socket.on('error', (err) => finish(err));
    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== ip) return;
      if (opts.accept && !opts.accept(msg)) return;
      finish(null, msg);
    });
    socket.bind(0, send);
  });
}

/**
 * Open a TCP connection, write `payload`, and read until `complete(buffer)`
 * says the response is whole (or the timeout fires).
 */
export function tcpRequest(
  ip: string,
  port: number,
  payload: Buffer,
  complete: (buf: Buffer) => boolean,
  timeoutMs = 3000
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve(buf);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`Timed out talking to ${ip}:${port}`)));
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (complete(buf)) finish(null);
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') finish(new Error(`Connection refused by ${ip}:${port}`));
      else if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') finish(new Error(`${ip} is unreachable`));
      else finish(err);
    });
    socket.on('end', () => finish(complete(buf) || buf.length ? null : new Error(`${ip}:${port} closed the connection`)));
  });
}

/** True if a TCP port accepts connections. */
export function tcpPortOpen(ip: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ip, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

export interface HttpResult<T = any> {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: T;
  text: string;
}

/**
 * Minimal HTTP client for LAN devices. Uses `http` rather than fetch so we can
 * do digest auth (Shelly) and talk to devices with non-standard ports/paths.
 */
export function httpRequest<T = any>(
  url: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; auth?: { user: string; pass: string } } = {}
): Promise<HttpResult<T>> {
  const doRequest = (authHeader?: string): Promise<HttpResult<T>> =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      const req = http.request(
        {
          host: u.hostname,
          port: u.port || 80,
          path: u.pathname + u.search,
          method: opts.method ?? 'GET',
          headers: {
            ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
            ...(authHeader ? { Authorization: authHeader } : {}),
            ...opts.headers,
          },
          timeout: opts.timeoutMs ?? 3000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: any = text;
            try {
              parsed = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, text });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`HTTP request to ${u.host} timed out`)));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') reject(new Error(`Connection refused by ${u.host}`));
        else reject(err);
      });
      if (body) req.write(body);
      req.end();
    });

  return doRequest(opts.auth ? basicAuth(opts.auth) : undefined).then((res) => {
    const challenge = res.headers['www-authenticate'];
    if (res.status === 401 && opts.auth && typeof challenge === 'string' && /^Digest/i.test(challenge)) {
      const u = new URL(url);
      return doRequest(digestAuth(challenge, opts.method ?? 'GET', u.pathname + u.search, opts.auth));
    }
    return res;
  });
}

function basicAuth({ user, pass }: { user: string; pass: string }) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function digestAuth(challenge: string, method: string, uri: string, { user, pass }: { user: string; pass: string }) {
  const params: Record<string, string> = {};
  for (const m of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) params[m[1]] = m[2] ?? m[3];
  const algo = (params.algorithm ?? 'MD5').toUpperCase() === 'SHA-256' ? 'sha256' : 'md5';
  const h = (s: string) => crypto.createHash(algo).update(s).digest('hex');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = h(`${user}:${params.realm}:${pass}`);
  const ha2 = h(`${method}:${uri}`);
  const response = params.qop ? h(`${ha1}:${params.nonce}:${nc}:${cnonce}:auth:${ha2}`) : h(`${ha1}:${params.nonce}:${ha2}`);
  return (
    `Digest username="${user}", realm="${params.realm}", nonce="${params.nonce}", uri="${uri}", ` +
    `algorithm=${params.algorithm ?? 'MD5'}, response="${response}"` +
    (params.qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : '') +
    (params.opaque ? `, opaque="${params.opaque}"` : '')
  );
}

/** Run promise-returning tasks, never letting one failure sink the others. */
export async function settleAll<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

export function withTimeout<T>(p: Promise<T>, ms: number, message = 'Timed out'): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}
