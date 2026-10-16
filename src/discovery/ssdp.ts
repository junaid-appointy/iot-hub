import { SsdpHost } from '../core/types';
import { udpCollect } from '../util/net';

/** Parse the header block of an SSDP / HTTP-over-UDP response. Keys are lower-cased. */
export function parseHttpHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/** UPnP / SSDP M-SEARCH for everything (TVs, routers, Hue bridges, Sonos, …). */
export async function scanSsdp(timeoutMs: number): Promise<SsdpHost[]> {
  const hosts = new Map<string, SsdpHost>();
  const msg = Buffer.from(
    ['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2', 'ST: ssdp:all', '', ''].join('\r\n')
  );
  await udpCollect({
    port: 1900,
    targets: ['239.255.255.250'],
    payload: msg,
    timeoutMs,
    onMessage: (buf, rinfo) => {
      const headers = parseHttpHeaders(buf.toString());
      const h = hosts.get(rinfo.address) ?? { address: rinfo.address, headers: [] };
      if (!h.headers.some((x) => x.usn === headers.usn && x.st === headers.st)) h.headers.push(headers);
      hosts.set(rinfo.address, h);
    },
  });
  return [...hosts.values()];
}
