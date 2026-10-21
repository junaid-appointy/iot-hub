/**
 * Fast regression tests (no bulbs, no network): run with `npm test`.
 * Each test uses a temporary sandbox store, so the repo's layouts/ is never touched.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { latencyFor } from '../src/core/calibration';
import { Autopilot, showDirector } from '../src/core/directors';
import { Hub } from '../src/core/hub';
import { createLayout, numberGrid, sequence } from '../src/core/matrix';
import { MatrixRunner } from '../src/core/matrix-runner';
import { LiveClock, Metronome, ShowClock } from '../src/core/music';
import { blank, PATTERNS, patternById } from '../src/core/patterns';
import { Store } from '../src/core/store';

const results: Array<[string, boolean, string]> = [];
async function test(name: string, fn: () => Promise<string | void> | string | void) {
  try {
    const note = (await fn()) || '';
    results.push([name, true, note]);
  } catch (e: any) {
    results.push([name, false, e.message]);
  }
}
const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iot-hub-test-'));

(async () => {
  const repoLayout = path.resolve(__dirname, '..', 'layouts', 'auditorium.json');
  const before = fs.existsSync(repoLayout) ? fs.readFileSync(repoLayout, 'utf8') : null;

  await test('numbering: every corner/direction/zigzag/reverse uses 1..N once', () => {
    const l = createLayout(9, 6);
    for (const start of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const)
      for (const direction of ['rows', 'columns'] as const)
        for (const serpentine of [false, true])
          for (const reverse of [false, true]) {
            l.numbering = { start, direction, serpentine, reverse };
            const nums = numberGrid(l).flat().sort((a, b) => a - b);
            assert.deepStrictEqual(nums, Array.from({ length: 54 }, (_, i) => i + 1));
          }
    return '32 combinations';
  });

  await test('patterns: all produce valid frames for 3 s on a 9x6 grid', () => {
    const met = new Metronome(120, 0);
    for (const p of PATTERNS) {
      const state: any = {};
      for (let D = 0; D < 3000; D += 40) {
        const m = met.sample(D - 40, D);
        const look: any = p.frame({ rows: 9, cols: 6, tick: Math.floor(D / 500), seq: sequence(createLayout(9, 6)), params: { text: 'HI' }, state, canvas: blank(9, 6), music: { ...m, t: D / 1000, progress: 0.5 } });
        const v = Array.isArray(look) ? look : look.v;
        assert.strictEqual(v.length, 9, p.id);
        assert.ok(v.every((r: number[]) => r.length === 6 && r.every((x) => Number.isFinite(x))), p.id);
      }
    }
    return `${PATTERNS.length} patterns`;
  });

  await test('Full mix: kick lights the floor, snare the ceiling, melody visits every column, bass solo stays central', () => {
    const p = patternById('mix')!;
    const met = new Metronome(120, 0);
    const state: any = {};
    let kicks = 0, snares = 0;
    const cols = new Set<number>();
    for (let D = 0; D < 8000; D += 40) {
      const m = met.sample(D - 40, D);
      const v = (p.frame({ rows: 9, cols: 6, tick: 0, seq: [], params: {}, state, canvas: blank(9, 6), music: { ...m, t: D / 1000, progress: 0 } }) as any).v as number[][];
      if (m.hits.kick && v[8].every((x) => x > 0.6)) kicks++;
      if (m.hits.snare && v[0].every((x) => x > 0.6)) snares++;
      for (let r = 0; r < 7; r++) for (let c = 0; c < 6; c++) if (v[r][c] > 0.9 && !v[r].every((x) => x > 0.6)) cols.add(c);
    }
    assert.strictEqual(kicks, 16);
    assert.strictEqual(snares, 8);
    assert.strictEqual(cols.size, 6);
    const solo = (p.frame({ rows: 9, cols: 6, tick: 0, seq: [], params: { wash: false, kick: false, snare: false, hats: false, melody: false, drops: false }, state: {}, canvas: blank(9, 6), music: { ...met.sample(0, 40), t: 0.04, progress: 0 } }) as any).v as number[][];
    assert.ok(solo.every((row) => row.every((x, c) => x === 0 || c === 2 || c === 3)));
    return '16 kicks, 8 snares, 6 columns';
  });

  await test('sync: bulbs with 20/60/220 ms links all become visible on the downbeat (±5 ms)', async () => {
    const dir = sandbox();
    const store = new Store(dir);
    const mk = (n: number) => ({ id: `wiz:b${n}`, driver: 'wiz', name: `B${n}`, kind: 'light' as const, address: '127.0.0.1', capabilities: ['power', 'brightness', 'color_temp'] as any, colorTempRange: [2700, 6500] as [number, number], status: 'ready' as const, config: {} });
    store.devices = [mk(1), mk(2), mk(3)];
    const layout = createLayout(1, 3);
    layout.cells = [['wiz:b1', 'wiz:b2', 'wiz:b3']];
    layout.calibration = { lightLatencyMs: 150, bulbs: { 'wiz:b1': { rttMs: 20 }, 'wiz:b2': { rttMs: 60 }, 'wiz:b3': { rttMs: 220 } } };
    store.saveLayout(layout);
    const hub = new Hub(store);
    const log: Array<{ id: string; at: number; b?: number }> = [];
    (hub as any).stream = (d: any, c: any) => log.push({ id: d.id, at: Date.now(), b: c.brightness });
    const lat = latencyFor(store.layout());
    const runner = new MatrixRunner(hub, () => store.layout(), () => latencyFor(store.layout()));
    const beats = Array.from({ length: 40 }, (_, i) => i * 0.5);
    const clock = new ShowClock({ duration: 20, beats, downbeats: beats.map((_, i) => i).filter((i) => i % 4 === 0), kicks: [], snares: [], hats: [], env: Array(200).fill(80), bands: [], sections: [] });
    const start = Date.now() + 600;
    clock.anchorMs = start;
    clock.playing = true;
    runner.setSource(clock);
    runner.direct('show', showDirector(clock, () => [{ t: 0, pattern: 'blinder', palette: 'cool' }], () => ({ tickMs: 500, maxBrightness: 100, kelvin: 6500, palette: 'cool', background: 'off', preview: false, stepOn: 'timer' })), {});
    await new Promise((r) => setTimeout(r, 4600));
    runner.stop();
    const errs: number[] = [];
    for (const s of [2, 4]) {
      const T = start + s * 1000;
      for (const id of ['wiz:b1', 'wiz:b2', 'wiz:b3']) {
        const send = log.find((e) => e.id === id && (e.b ?? 0) >= 80 && Math.abs(e.at + lat.perBulb[id] - T) < 120);
        assert.ok(send, `${id} missing at ${s}s`);
        errs.push(send!.at + lat.perBulb[id] - T);
      }
    }
    assert.ok(errs.every((e) => Math.abs(e) <= 5), `visible offsets ${errs.join(', ')} ms`);
    return `visible offsets ${errs.map((e) => (e >= 0 ? '+' : '') + e).join(' ')} ms`;
  });

  await test('live clock: a predicted beat lands in the right 40 ms frame; extra features flow through', () => {
    const live = new LiveClock();
    const now = Date.now();
    live.setGrid({ anchorMs: now + 300, anchorBeat: 0, periodMs: 500, downbeat: 0, locked: true });
    live.setFeatures(0.6, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], { stereo: { balance: 0, width: 0.5, pan: [0, -0.9, 0] }, pitch: { midi: 72, confidence: 0.9 } });
    const a = live.sample(now + 250, now + 290), b = live.sample(now + 290, now + 330);
    assert.strictEqual(a.hits.beat, 0);
    assert.ok(b.hits.beat > 0 && b.hits.downbeat > 0);
    assert.strictEqual(b.stereo.pan[1], -0.9);
    assert.strictEqual(b.pitch?.midi, 72);
  });

  await test('autopilot: calm intro → build-up → one drop → peak → calm', () => {
    const ap = new Autopilot();
    const energies = [...Array(16).fill(0.15), 0.2, 0.3, 0.38, 0.45, 0.52, 0.58, 0.9, 0.92, ...Array(12).fill(0.85), ...Array(8).fill(0.2)];
    const labels: string[] = [];
    energies.forEach((e, bar) => {
      ap.director(0, { ...new Metronome().sample(0, 40), bar, locked: true, energy: e, hits: { beat: 1, downbeat: 1, kick: 1, snare: 0, hat: 0 } } as any);
      const l = ap.snapshot().label;
      if (labels[labels.length - 1] !== l) labels.push(l);
    });
    assert.deepStrictEqual(labels, ['Calm', 'Build-up', 'Drop!', 'Peak', 'Calm']);
    return labels.join(' → ');
  });

  await test('physics looks: every bulb always lit, whole wall used, stable for 60 s', () => {
    const notes: string[] = [];
    for (const id of ['ripple-tank', 'chladni', 'harp', 'aurora', 'embers', 'mix']) {
      const p = patternById(id)!;
      const met = new Metronome(124, 0);
      const state: any = {};
      let min = 1, max = 0;
      const used = new Set<number>();
      for (let D = 0; D < 60000; D += 40) {
        const look: any = p.frame({ rows: 9, cols: 6, tick: 0, seq: [], params: {}, state, canvas: blank(9, 6), music: { ...met.sample(D - 40, D), t: D / 1000, progress: 0 } });
        (look.v as number[][]).forEach((row, r) => row.forEach((x, c) => { assert.ok(Number.isFinite(x), `${id} NaN`); min = Math.min(min, x); max = Math.max(max, x); if (x > 0.3) used.add(r * 6 + c); }));
      }
      assert.ok(min >= 0.07, `${id}: a bulb went dark (${min.toFixed(2)})`);
      assert.ok(max <= 1, `${id}: overflow`);
      assert.ok(used.size >= 40, `${id}: only ${used.size}/54 bulbs ever reach 30 %`);
      notes.push(`${id} ${used.size}/54`);
    }
    return notes.join(', ');
  });

  await test('ripple tank: a single kick travels from the floor to the ceiling', () => {
    const p = patternById('ripple-tank')!;
    const met = new Metronome(124, 0);
    const state: any = {};
    const peaks = { floor: [0, 0], ceiling: [0, 0] };
    for (let D = 0; D < 3000; D += 40) {
      const t = D / 1000;
      const m = { ...met.sample(D - 40, D), t, progress: 0, bands: [0, 0, 0, 0, 0, 0], energy: 0, pitch: null, hits: { beat: 0, downbeat: 0, kick: Math.abs(t - 0.2) < 0.02 ? 1 : 0, snare: 0, hat: 0 } };
      const v = (p.frame({ rows: 9, cols: 6, tick: 0, seq: [], params: {}, state, canvas: blank(9, 6), music: m as any }) as any).v as number[][];
      const f = v[8].reduce((a, b) => a + b, 0), c = v[0].reduce((a, b) => a + b, 0);
      if (f > peaks.floor[0]) peaks.floor = [f, t];
      if (c > peaks.ceiling[0]) peaks.ceiling = [c, t];
    }
    assert.ok(peaks.floor[1] < peaks.ceiling[1], `floor ${peaks.floor[1]} s, ceiling ${peaks.ceiling[1]} s`);
    assert.ok(peaks.floor[1] < 0.6, 'floor reacted late');
    return `floor at ${peaks.floor[1].toFixed(2)} s, ceiling at ${peaks.ceiling[1].toFixed(2)} s`;
  });

  await test('delivery: a constantly changing look sends each bulb at most ~16 commands/s, with no backlog', async () => {
    const dir = sandbox();
    const store = new Store(dir);
    store.devices = [{ id: 'wiz:x', driver: 'wiz', name: 'X', kind: 'light', address: '127.0.0.1', capabilities: ['power', 'brightness', 'color_temp'] as any, colorTempRange: [2700, 6500], status: 'ready', config: {} }];
    const layout = createLayout(1, 1);
    layout.cells = [['wiz:x']];
    store.saveLayout(layout);
    const hub = new Hub(store);
    const sends: number[] = [];
    (hub as any).stream = () => sends.push(Date.now());
    const runner = new MatrixRunner(hub, () => store.layout(), () => latencyFor(store.layout()));
    runner.start('aurora', {}, { preview: false });
    await new Promise((r) => setTimeout(r, 3000));
    runner.stop();
    const gaps = sends.slice(1).map((t, i) => t - sends[i]);
    const rate = sends.length / 3;
    assert.ok(rate <= 17, `${rate.toFixed(1)} commands/s`);
    // Smooth changes are ≥60 ms apart; beat hits may come sooner but never under 30 ms.
    assert.ok(Math.min(...gaps) >= 28, `gap ${Math.min(...gaps)} ms`);
    return `${rate.toFixed(1)} commands/s, smallest gap ${Math.min(...gaps)} ms`;
  });

  await test("tests never touch the repo's real layout", () => {
    const after = fs.existsSync(repoLayout) ? fs.readFileSync(repoLayout, 'utf8') : null;
    assert.strictEqual(after, before);
  });

  for (const [name, ok, note] of results) console.log(`${ok ? '✓' : '✗'} ${name}${note ? ` — ${note}` : ''}`);
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
