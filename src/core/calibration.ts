import { Hub } from './hub';
import { assignedIds, Calibration, MatrixLayout } from './matrix';
import { Latency } from './matrix-runner';

/**
 * Sync calibration for a bulb installation.
 *
 * 1. Network (automatic): ping every mapped bulb a few times; the spread of
 *    round-trip times tells us which bulbs need their commands sent earlier.
 * 2. Tap test (once per venue, ~30 s): the user taps along to clicks they hear,
 *    then to flashes they see. Their personal tap habit cancels out, leaving
 *    lightLatency − audioLatency, which is exactly what sync needs.
 */

/** Assumed bulb processing + LED ramp on top of half the network round trip, when not tap-calibrated. */
const BULB_PROCESSING_MS = 70;
const DEFAULT_LATENCY_MS = 150;

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export async function measureNetwork(hub: Hub, layout: MatrixLayout, pingsPerBulb = 6) {
  const ids = assignedIds(layout);
  const devices = hub.devices().filter((d) => ids.has(d.id) && d.status === 'ready');
  const results = await Promise.all(
    devices.map(async (d, i) => {
      await new Promise((r) => setTimeout(r, (i % 10) * 15)); // stagger so pings don't collide on the air
      const rtts: number[] = [];
      for (let k = 0; k < pingsPerBulb; k++) {
        const rtt = await hub.ping(d);
        if (rtt !== null) rtts.push(rtt);
        await new Promise((r) => setTimeout(r, 60));
      }
      return { id: d.id, name: d.name, rttMs: rtts.length >= 2 ? Math.round(median(rtts)) : null, answered: rtts.length, sent: pingsPerBulb };
    })
  );
  const bulbs: Calibration['bulbs'] = Object.fromEntries(results.map((r) => [r.id, { rttMs: r.rttMs }]));
  const ok = results.filter((r) => r.rttMs !== null).map((r) => r.rttMs!) as number[];
  return {
    bulbs,
    medianMs: ok.length ? Math.round(median(ok)) : null,
    slowest: [...results].filter((r) => r.rttMs !== null).sort((a, b) => b.rttMs! - a.rttMs!).slice(0, 5),
    unreachable: results.filter((r) => r.rttMs === null).map((r) => r.name),
    lossy: results.filter((r) => r.rttMs !== null && r.answered < r.sent).map((r) => ({ name: r.name, lostPct: Math.round(100 * (1 - r.answered / r.sent)) })),
  };
}

/** Light latency from the tap test: (tap-to-light − tap-to-sound) + the sound's own output delay. */
export function lightLatencyFromTaps(audioTapMs: number, lightTapMs: number, outputLatencyMs: number) {
  return Math.round(Math.max(20, Math.min(1500, lightTapMs - audioTapMs + outputLatencyMs)));
}

/** Per-bulb send-ahead times for the runner. */
export function latencyFor(layout: MatrixLayout | undefined): Latency {
  const cal = layout?.calibration;
  const rtts = Object.values(cal?.bulbs ?? {})
    .map((b) => b.rttMs)
    .filter((x): x is number => typeof x === 'number');
  const med = median(rtts);
  const baseMs = cal?.lightLatencyMs ?? (Number.isFinite(med) ? Math.round(med / 2 + BULB_PROCESSING_MS) : DEFAULT_LATENCY_MS);
  const perBulb: Record<string, number> = {};
  if (Number.isFinite(med)) {
    for (const [id, b] of Object.entries(cal?.bulbs ?? {})) {
      // Slower link → send earlier, by half the extra round trip (the outbound half).
      if (typeof b.rttMs === 'number') perBulb[id] = Math.round(Math.max(baseMs * 0.5, Math.min(baseMs + 600, baseMs + (b.rttMs - med) / 2)));
    }
  }
  return { baseMs, perBulb };
}
