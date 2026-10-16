import { MdnsHost, SsdpHost, UnknownHost } from '../core/types';
import { httpRequest, settleAll, withTimeout } from '../util/net';

/** What a service type usually means, plus whether a driver is planned. */
const SERVICE_HINTS: Record<string, string> = {
  '_hap._tcp.local': 'HomeKit accessory',
  '_matter._tcp.local': 'Matter device',
  '_matterc._udp.local': 'Matter device (commissionable)',
  '_googlecast._tcp.local': 'Google Cast (Chromecast / Nest / TV)',
  '_airplay._tcp.local': 'AirPlay device',
  '_raop._tcp.local': 'AirPlay speaker',
  '_esphomelib._tcp.local': 'ESPHome device',
  '_miio._udp.local': 'Xiaomi Mi Home device',
  '_elg._tcp.local': 'Elgato light',
  '_sonos._tcp.local': 'Sonos speaker',
  '_spotify-connect._tcp.local': 'Spotify Connect speaker',
  '_ipp._tcp.local': 'Printer',
  '_printer._tcp.local': 'Printer',
  '_companion-link._tcp.local': 'Apple device',
  '_smb._tcp.local': 'File share / computer',
};

/**
 * Describe hosts that answered mDNS/SSDP but that no driver claimed, so the
 * user can see *everything* on the network and we know which driver to add next.
 */
export async function describeUnknownHosts(mdns: MdnsHost[], ssdp: SsdpHost[], claimed: Set<string>): Promise<UnknownHost[]> {
  const out = new Map<string, UnknownHost>();
  const get = (address: string) => {
    let h = out.get(address);
    if (!h) out.set(address, (h = { address, hints: [], services: [] }));
    return h;
  };

  for (const m of mdns) {
    if (claimed.has(m.address)) continue;
    const h = get(m.address);
    h.services.push(...m.services.map((s) => s.replace(/\.local$/, '')));
    for (const s of m.services) {
      const hint = SERVICE_HINTS[s];
      if (hint && !h.hints.includes(hint)) h.hints.push(hint);
    }
    const instance = Object.keys(m.instances)[0];
    h.name ??= instance?.split('._')[0] ?? m.hostnames[0]?.replace(/\.local$/, '');
    const model = Object.values(m.instances).map((i) => i.txt.md ?? i.txt.model ?? i.txt.fn).find(Boolean);
    if (model && !h.hints.includes(model)) h.hints.push(model);
  }

  await settleAll(
    ssdp
      .filter((s) => !claimed.has(s.address))
      .map(async (s) => {
        const h = get(s.address);
        const server = s.headers.find((x) => x.server)?.server;
        const location = s.headers.find((x) => x.location?.startsWith('http'))?.location;
        if (location) {
          try {
            const res = await withTimeout(httpRequest<string>(location, { timeoutMs: 1500 }), 2000);
            const tag = (t: string) => res.text.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]?.trim();
            h.name ??= tag('friendlyName');
            const desc = [tag('manufacturer'), tag('modelName')].filter(Boolean).join(' ');
            if (desc && !h.hints.includes(desc)) h.hints.push(desc);
          } catch {}
        }
        if (!h.hints.length && server) h.hints.push(server);
      })
  );

  return [...out.values()].sort((a, b) => ipSortKey(a.address) - ipSortKey(b.address));
}

function ipSortKey(ip: string) {
  return ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
}
