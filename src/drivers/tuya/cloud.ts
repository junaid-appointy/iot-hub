import crypto from 'crypto';
import { DeviceError } from '../../core/types';

/**
 * Tuya IoT Platform OpenAPI client (HMAC-SHA256 "new" signature scheme).
 * Used once to fetch local keys, and as a fallback transport for devices
 * whose local protocol we don't speak (3.4 / 3.5).
 */
export interface TuyaCloudCreds {
  accessId: string;
  accessSecret: string;
  region: string;
}

export const REGIONS: Array<{ label: string; value: string; url: string }> = [
  { label: 'India', value: 'in', url: 'https://openapi.tuyain.com' },
  { label: 'Western America', value: 'us', url: 'https://openapi.tuyaus.com' },
  { label: 'Eastern America', value: 'us-e', url: 'https://openapi-ueaz.tuyaus.com' },
  { label: 'Central Europe', value: 'eu', url: 'https://openapi.tuyaeu.com' },
  { label: 'Western Europe', value: 'eu-w', url: 'https://openapi-weaz.tuyaeu.com' },
  { label: 'China', value: 'cn', url: 'https://openapi.tuyacn.com' },
];

const HINTS: Record<number, string> = {
  1004: 'Access ID / Secret is wrong.',
  1010: 'Token expired — try again.',
  1106: 'No permission: link your Smart Life / Tuya app account to the cloud project (Devices → Link App Account).',
  2009: 'Wrong data center — pick the region your app account lives in.',
  28841105: 'Your cloud project is not subscribed to the "IoT Core" API (Cloud → Cloud Services → IoT Core → free trial).',
  28841002: 'Your cloud project\'s API subscription has expired — renew "IoT Core" (free) in the Tuya console.',
};

export class TuyaCloud {
  private token?: { value: string; expires: number };
  private base: string;

  constructor(private creds: TuyaCloudCreds) {
    this.base = REGIONS.find((r) => r.value === creds.region)?.url ?? REGIONS[0].url;
  }

  private sign(str: string) {
    return crypto.createHmac('sha256', this.creds.accessSecret).update(str, 'utf8').digest('hex').toUpperCase();
  }

  private async raw(method: string, path: string, body?: unknown, auth = true): Promise<any> {
    const [p, q] = path.split('?');
    const sortedQuery = q ? '?' + q.split('&').sort().join('&') : '';
    const url = p + sortedQuery;
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const t = Date.now().toString();
    const stringToSign = [method, crypto.createHash('sha256').update(bodyStr).digest('hex'), '', url].join('\n');
    const token = auth ? await this.accessToken() : '';
    const headers: Record<string, string> = {
      client_id: this.creds.accessId,
      sign: this.sign(this.creds.accessId + token + t + stringToSign),
      t,
      sign_method: 'HMAC-SHA256',
      nonce: '',
      'Content-Type': 'application/json',
    };
    if (auth) headers.access_token = token;
    const res = await fetch(this.base + url, { method, headers, body: bodyStr || undefined, signal: AbortSignal.timeout(8000) });
    const json: any = await res.json();
    if (!json.success) throw new DeviceError(`Tuya cloud: ${json.msg ?? 'request failed'} (code ${json.code})`, HINTS[json.code]);
    return json.result;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    const r = await this.raw('GET', '/v1.0/token?grant_type=1', undefined, false);
    this.token = { value: r.access_token, expires: Date.now() + (r.expire_time - 60) * 1000 };
    return this.token.value;
  }

  /** Throws with a helpful hint if the credentials/project are not usable. */
  verify() {
    return this.accessToken();
  }

  device(id: string): Promise<{ id: string; name: string; local_key: string; category: string; product_name?: string; online: boolean }> {
    return this.raw('GET', `/v1.0/devices/${id}`);
  }

  async functions(id: string): Promise<Array<{ code: string; type: string; values: any }>> {
    const r = await this.raw('GET', `/v1.0/devices/${id}/functions`);
    return (r.functions ?? []).map((f: any) => ({ ...f, values: safeJson(f.values) }));
  }

  async status(id: string): Promise<Record<string, any>> {
    const list: Array<{ code: string; value: any }> = await this.raw('GET', `/v1.0/devices/${id}/status`);
    return Object.fromEntries(list.map((s) => [s.code, typeof s.value === 'string' ? safeJson(s.value) : s.value]));
  }

  command(id: string, commands: Array<{ code: string; value: unknown }>) {
    return this.raw('POST', `/v1.0/devices/${id}/commands`, { commands });
  }
}

function safeJson(v: any) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
