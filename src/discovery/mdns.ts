import makeMdns from 'multicast-dns';
import { MdnsHost } from '../core/types';

/** Service types we always ask for, even if a device doesn't answer the enumeration query. */
const WELL_KNOWN = [
  '_hue._tcp.local',
  '_shelly._tcp.local',
  '_http._tcp.local',
  '_wled._tcp.local',
  '_nanoleafapi._tcp.local',
  '_nanoleafms._tcp.local',
  '_elg._tcp.local',
  '_hap._tcp.local',
  '_matter._tcp.local',
  '_matterc._udp.local',
  '_googlecast._tcp.local',
  '_airplay._tcp.local',
  '_esphomelib._tcp.local',
  '_miio._udp.local',
  '_sonos._tcp.local',
  '_spotify-connect._tcp.local',
  '_ipp._tcp.local',
];

/**
 * Browse mDNS / Bonjour: enumerate every advertised service type, query each
 * one, and group what comes back by the responding host's IP.
 */
export function scanMdns(timeoutMs: number): Promise<MdnsHost[]> {
  return new Promise((resolve) => {
    let mdns: ReturnType<typeof makeMdns>;
    try {
      mdns = makeMdns();
    } catch {
      return resolve([]);
    }
    const hosts = new Map<string, MdnsHost>();
    const queried = new Set<string>();

    const host = (address: string) => {
      let h = hosts.get(address);
      if (!h) {
        h = { address, hostnames: [], services: [], instances: {} };
        hosts.set(address, h);
      }
      return h;
    };

    const query = (types: string[]) => {
      const fresh = types.filter((t) => !queried.has(t));
      fresh.forEach((t) => queried.add(t));
      if (fresh.length) mdns.query({ questions: fresh.map((name) => ({ name, type: 'PTR' as const })) });
    };

    mdns.on('error', () => {});
    mdns.on('response', (res, rinfo) => {
      if (rinfo.family !== 'IPv4') return;
      const h = host(rinfo.address);
      for (const rec of [...res.answers, ...(res.additionals ?? [])]) {
        const name = rec.name;
        if (rec.type === 'PTR') {
          const data = String(rec.data);
          if (name === '_services._dns-sd._udp.local') {
            query([data]);
            continue;
          }
          if (!h.services.includes(name)) h.services.push(name);
          h.instances[data] ??= { service: name, txt: {} };
        } else if (rec.type === 'SRV') {
          const data = rec.data as { port: number; target: string };
          h.instances[name] ??= { service: name.split('.').slice(1).join('.'), txt: {} };
          h.instances[name].port = data.port;
          if (!h.hostnames.includes(data.target)) h.hostnames.push(data.target);
        } else if (rec.type === 'TXT') {
          h.instances[name] ??= { service: name.split('.').slice(1).join('.'), txt: {} };
          const entries = Array.isArray(rec.data) ? rec.data : [rec.data];
          for (const e of entries) {
            const s = Buffer.isBuffer(e) ? e.toString('utf8') : String(e);
            const i = s.indexOf('=');
            if (i > 0) h.instances[name].txt[s.slice(0, i).toLowerCase()] = s.slice(i + 1);
          }
        } else if (rec.type === 'A') {
          if (!h.hostnames.includes(name)) h.hostnames.push(name);
        }
      }
    });

    query(['_services._dns-sd._udp.local', ...WELL_KNOWN]);
    // Re-ask once: lots of devices miss the first multicast on busy Wi-Fi.
    setTimeout(() => {
      queried.clear();
      query(['_services._dns-sd._udp.local', ...WELL_KNOWN]);
    }, Math.min(1500, timeoutMs / 2));

    setTimeout(() => {
      mdns.destroy();
      resolve([...hosts.values()].filter((h) => h.services.length || h.hostnames.length));
    }, timeoutMs);
  });
}

/** First TXT record value for `key` across a host's instances of `service`. */
export function txtValue(host: MdnsHost, service: string, key: string): string | undefined {
  for (const inst of Object.values(host.instances)) {
    if (inst.service === service && inst.txt[key] !== undefined) return inst.txt[key];
  }
  return undefined;
}

export function instancePort(host: MdnsHost, service: string): number | undefined {
  return Object.values(host.instances).find((i) => i.service === service && i.port)?.port;
}
