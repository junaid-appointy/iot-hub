#!/usr/bin/env node
import { Hub } from '../core/hub';
import { Command, Device, DeviceError, DeviceState } from '../core/types';
import { clamp, parseColor, parseKelvin } from '../util/color';
import { settleAll } from '../util/net';
import { startServer } from '../web/server';
import { cliIO, interactive, spinner } from './io';
import { c, describeState, deviceTable, table, unknownTable } from './render';

const HELP = `
${c.bold('iot')} — discover and control smart devices on your local network

${c.bold('Visual interface')}
  iot ui [--port 7070] [--no-open]                   Open the web dashboard in your browser

${c.bold('Discover & set up')}
  iot scan [--timeout <sec>] [--no-setup] [--json]   Find devices, auto-connect, guide setup
  iot setup [device]                                 Finish setup (pairing, keys, passwords)
  iot add <ip> [--driver <id>]                       Add a device by IP when discovery can't see it
  iot guide [brand]                                  Troubleshooting tips per brand

${c.bold('Control')}               ${c.dim('<device> = name, part of a name, # from `iot list`, "all", or "lights"')}
  iot on|off|toggle <device...>
  iot brightness <device...> <0-100>
  iot color <device...> <#hex | r,g,b | name>
  iot temp <device...> <kelvin | warm | neutral | cool | daylight>
  iot scene <device> [scene]                         Without a scene: list available scenes

${c.bold('Manage')}
  iot list [--json]          iot status <device>       iot rename <device> <new name>
  iot remove <device>        iot drivers

Run ${c.cyan('iot')} with no arguments for an interactive menu.
`;

const hub = new Hub();

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--no-')) flags[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['timeout', 'driver', 'port'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else args.push(a);
  }
  return { args, flags };
}

function fail(message: string, hint?: string): never {
  throw new DeviceError(message, hint);
}

function resolve(selectors: string[]): Device[] {
  if (!selectors.length) fail('Which device?', 'Run `iot list` to see names and numbers');
  const out = new Map<string, Device>();
  for (const s of selectors) {
    const found = hub.find(s);
    if (!found.length) fail(`No device matches "${s}"`, hub.devices().length ? 'Run `iot list` to see names' : 'Run `iot scan` first');
    found.forEach((d) => out.set(d.id, d));
  }
  return [...out.values()];
}

const indexOf = (d: Device) => hub.devices().findIndex((x) => x.id === d.id) + 1;

async function statesFor(devices: Device[]): Promise<Map<string, DeviceState>> {
  const entries = await settleAll(devices.map(async (d) => [d.id, await hub.state(d)] as const));
  return new Map(entries);
}

async function control(devices: Device[], command: Command) {
  const results = await Promise.allSettled(devices.map((d) => hub.run(d, command)));
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') console.log(`${c.green('✓')} ${devices[i].name}`);
    else {
      failed++;
      const e = r.reason;
      console.log(`${c.red('✗')} ${e.message}${e.hint ? c.dim(`\n  → ${e.hint}`) : ''}`);
    }
  });
  if (failed) process.exitCode = 1;
}

// ---- commands -------------------------------------------------------------

async function scan(flags: Record<string, string | boolean>) {
  const timeoutMs = clamp(Number(flags.timeout ?? 6), 2, 60) * 1000;
  const done: string[] = [];
  const result = await spinner(`Scanning your network (${timeoutMs / 1000}s)…`, (update) =>
    hub.scan({
      timeoutMs,
      onDriverDone: (driver, found) => {
        if (found) done.push(`${driver.name} ${found}`);
        update(`Scanning your network… ${done.length ? c.dim(done.join(' · ')) : ''}`);
      },
    })
  );

  if (flags.json) {
    console.log(JSON.stringify({ devices: result.devices, unknown: result.unknown, errors: result.errors }, null, 2));
    return;
  }

  const fresh = new Set(result.added.map((d) => d.id));
  if (!result.devices.length) {
    console.log(c.yellow('No supported devices found.'));
  } else {
    console.log(c.bold(`\nDevices (${result.devices.length})`) + (fresh.size ? c.green(`  ${fresh.size} new`) : ''));
    deviceTable(result.devices, result.states, indexOf);
  }

  if (result.unknown.length) {
    console.log(c.bold(`\nOther devices on your network`) + c.dim(' (no driver yet)'));
    unknownTable(result.unknown);
  }
  for (const e of result.errors) console.log(c.dim(`  ${e.driver}: ${e.message}`));

  console.log(c.dim(`\nDon't see a device? Try ${c.cyan('iot scan --timeout 15')}, ${c.cyan('iot add <ip>')}, or ${c.cyan('iot guide <brand>')}.`));

  const pending = result.devices.filter((d) => d.status === 'needs_setup');
  if (pending.length && flags.setup !== false && interactive()) {
    console.log();
    if (await cliIO.confirm(`${pending.length} device(s) need a one-time setup. Do it now?`)) await setupAll(pending);
  } else if (pending.length) {
    console.log(c.yellow(`\n${pending.length} device(s) need setup → run ${c.cyan('iot setup')}`));
  }
}

async function setupAll(devices: Device[], force = false) {
  for (const d of devices) {
    // An earlier setup (e.g. Tuya cloud login) may already have fixed this one.
    const current = hub.devices().find((x) => x.id === d.id);
    if (!current || (!force && current.status !== 'needs_setup')) continue;
    console.log(c.bold(`\n━━ ${current.name} ${c.dim(`(${current.driver}, ${current.address})`)}`));
    try {
      const result = await hub.setup(current, cliIO);
      const ready = result.filter((x) => x.status === 'ready');
      if (ready.length) deviceTable(ready, await statesFor(ready), indexOf);
    } catch (e: any) {
      if (e.message === 'Cancelled') return;
      cliIO.warn(e.message + (e.hint ? c.dim(`\n  → ${e.hint}`) : ''));
    }
  }
}

async function list(flags: Record<string, string | boolean>) {
  const devices = hub.devices();
  if (!devices.length) return console.log(`No devices yet — run ${c.cyan('iot scan')}.`);
  const states = flags.state === false ? new Map() : await spinner('Reading device states…', () => statesFor(devices));
  if (flags.json) {
    console.log(JSON.stringify(devices.map((d) => ({ ...d, config: undefined, state: states.get(d.id) })), null, 2));
    return;
  }
  deviceTable(devices, states, indexOf);
}

async function status(selectors: string[]) {
  for (const d of resolve(selectors)) {
    const s = await hub.state(d);
    console.log(c.bold(d.name) + c.dim(`  ${d.id}`));
    table([
      ['State', describeState(d, s)],
      ['Type', `${d.kind}${d.model ? c.dim(` (${d.model})`) : ''}`],
      ['Address', d.address + (d.mac ? c.dim(`  mac ${d.mac}`) : '')],
      ['Can do', d.capabilities.join(', ') || '—'],
      ...(d.colorTempRange ? [['Temp range', `${d.colorTempRange[0]}–${d.colorTempRange[1]}K`]] : []),
      ...(d.lastSeen ? [['Last seen', new Date(d.lastSeen).toLocaleString()]] : []),
    ]);
  }
}

async function setup(selectors: string[]) {
  const targets = selectors.length ? resolve(selectors) : hub.devices().filter((d) => d.status === 'needs_setup');
  if (!targets.length) return console.log(c.green('Everything is set up.') + c.dim(' (Run `iot scan` to look for new devices.)'));
  // Naming a device explicitly re-runs setup even if it's ready (re-pair, refresh keys).
  await setupAll(targets, selectors.length > 0);
}

async function add(ip: string | undefined, flags: Record<string, string | boolean>) {
  if (!ip) fail('Usage: iot add <ip> [--driver <id>]');
  const { devices, hints } = await spinner(`Probing ${ip}…`, () => hub.probe(ip, typeof flags.driver === 'string' ? flags.driver : undefined));
  if (!devices.length) {
    console.log(c.yellow(`Couldn't identify a supported device at ${ip}.`));
    hints.forEach((h) => console.log(c.dim(`  ${h}`)));
    if (!hints.length) console.log(c.dim('  No known ports are open. Is the IP right, and is the device on the same network?'));
    process.exitCode = 1;
    return;
  }
  console.log(c.green(`Added ${devices.length} device(s):`));
  deviceTable(devices, await statesFor(devices), indexOf);
  const pending = devices.filter((d) => d.status === 'needs_setup');
  if (pending.length && interactive() && (await cliIO.confirm('Set it up now?'))) await setupAll(pending);
}

async function scenes(selector: string, scene?: string) {
  const [d] = resolve([selector]);
  if (!scene) {
    if (!d.scenes?.length) return console.log(`${d.name} has no scenes.`);
    console.log(c.bold(`Scenes for ${d.name}:`));
    console.log('  ' + d.scenes.join(c.dim(' · ')));
    return;
  }
  await control([d], { type: 'scene', scene });
}

function guide(brand?: string) {
  const drivers = brand ? [hub.driver(brand.toLowerCase())] : hub.drivers;
  for (const d of drivers) {
    console.log(c.bold(`\n${d.name}`) + c.dim(` (${d.id})`));
    d.troubleshooting.forEach((t) => console.log(`  • ${t}`));
  }
  if (!brand) {
    console.log(c.bold('\nGeneral'));
    console.log('  • This computer and the devices must be on the same network — guest Wi-Fi and "AP isolation" block discovery.');
    console.log('  • VPNs can capture broadcast traffic; disconnect them while scanning.');
    console.log('  • Set IOT_DEBUG=1 to see per-driver diagnostics.');
  }
}

/** Split "<selectors...> <value>" commands. */
function valueCommand(args: string[], usage: string): [Device[], string] {
  if (args.length < 2) fail(`Usage: ${usage}`);
  return [resolve(args.slice(0, -1)), args[args.length - 1]];
}

// ---- interactive menu -----------------------------------------------------

async function menu() {
  if (!hub.devices().length) {
    console.log(c.bold('Welcome! ') + "Let's find the devices on your network.\n");
    await scan({});
  }
  for (;;) {
    const devices = hub.devices();
    const states = await spinner('Reading device states…', () => statesFor(devices));
    console.log();
    const choice = await cliIO.choose<Device | string>('What do you want to control?', [
      ...devices.map((d) => ({ label: `${d.name} ${c.dim(`(${d.kind})`)}`, value: d, hint: strip(describeState(d, states.get(d.id))) })),
      { label: c.cyan('All lights on'), value: 'all-on' },
      { label: c.cyan('All lights off'), value: 'all-off' },
      { label: c.cyan('Scan for new devices'), value: 'scan' },
      { label: c.dim('Quit'), value: 'quit' },
    ]);
    if (choice === 'quit') return;
    if (choice === 'scan') await scan({});
    else if (choice === 'all-on' || choice === 'all-off') await control(hub.find('lights'), { type: 'power', on: choice === 'all-on' });
    else await deviceMenu(choice as Device);
  }
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function deviceMenu(d: Device) {
  if (d.status === 'needs_setup') return setupAll([d]);
  const has = (cap: string) => d.capabilities.includes(cap as any);
  const action = await cliIO.choose(`${d.name}:`, [
    { label: 'Turn on', value: 'on' },
    { label: 'Turn off', value: 'off' },
    { label: 'Toggle', value: 'toggle' },
    ...(has('brightness') ? [{ label: 'Brightness', value: 'brightness' }] : []),
    ...(has('color') ? [{ label: 'Color', value: 'color' }] : []),
    ...(has('color_temp') ? [{ label: 'White temperature', value: 'temp' }] : []),
    ...(has('scene') && d.scenes?.length ? [{ label: 'Scene', value: 'scene' }] : []),
    { label: 'Rename', value: 'rename' },
    { label: 'Details', value: 'status' },
    { label: c.dim('Back'), value: 'back' },
  ]);
  const ask = (q: string, validate?: (v: string) => string | undefined) => cliIO.ask(q, { validate });
  const check = (fn: (v: string) => unknown) => (v: string) => {
    try {
      fn(v);
      return undefined;
    } catch (e: any) {
      return e.message;
    }
  };
  switch (action) {
    case 'on':
    case 'off':
      return control([d], { type: 'power', on: action === 'on' });
    case 'toggle':
      return control([d], { type: 'toggle' });
    case 'brightness': {
      const v = await ask('Brightness 0-100', (v) => (/^\d+$/.test(v) && +v <= 100 ? undefined : 'Enter a number 0-100'));
      return control([d], { type: 'brightness', value: Number(v) });
    }
    case 'color': {
      const v = await ask('Color (#ff8800, 255,136,0, or red/blue/purple…)', check(parseColor));
      return control([d], { type: 'color', rgb: parseColor(v) });
    }
    case 'temp': {
      const v = await ask('White temperature (2700, warm, neutral, cool, daylight)', check(parseKelvin));
      return control([d], { type: 'color_temp', kelvin: parseKelvin(v) });
    }
    case 'scene': {
      const scene = await cliIO.choose('Scene', d.scenes!.map((s) => ({ label: s, value: s })));
      return control([d], { type: 'scene', scene });
    }
    case 'rename':
      hub.rename(d, await ask('New name'));
      return cliIO.success('Renamed');
    case 'status':
      return status([d.id]);
  }
}

// ---- entry ----------------------------------------------------------------

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args;

  switch (cmd) {
    case undefined:
      if (flags.help || !interactive()) return console.log(HELP);
      return menu();
    case 'help':
      return console.log(HELP);
    case 'ui':
      startServer({ hub, port: Number(flags.port) || 7070, open: flags.open !== false });
      return;
    case 'scan':
      return scan(flags);
    case 'list':
    case 'ls':
      return list(flags);
    case 'status':
      return status(rest);
    case 'setup':
      return setup(rest);
    case 'add':
      return add(rest[0], flags);
    case 'guide':
      return guide(rest[0]);
    case 'on':
    case 'off':
      return control(resolve(rest), { type: 'power', on: cmd === 'on' });
    case 'toggle':
      return control(resolve(rest), { type: 'toggle' });
    case 'brightness':
    case 'dim': {
      const [devices, v] = valueCommand(rest, 'iot brightness <device...> <0-100>');
      const value = Number(v.replace('%', ''));
      if (!Number.isFinite(value) || value < 0 || value > 100) fail(`Brightness must be 0-100, got "${v}"`);
      return control(devices, { type: 'brightness', value });
    }
    case 'color':
    case 'colour': {
      const [devices, v] = valueCommand(rest, 'iot color <device...> <#hex | r,g,b | name>');
      return control(devices, { type: 'color', rgb: parseColor(v) });
    }
    case 'temp':
    case 'white': {
      const [devices, v] = valueCommand(rest, 'iot temp <device...> <kelvin | warm | cool>');
      return control(devices, { type: 'color_temp', kelvin: parseKelvin(v) });
    }
    case 'scene':
      return scenes(rest[0], rest.slice(1).join(' ') || undefined);
    case 'rename': {
      if (rest.length < 2) fail('Usage: iot rename <device> <new name>');
      const devices = resolve([rest[0]]);
      if (devices.length > 1) fail(`"${rest[0]}" matches ${devices.length} devices — be more specific`);
      hub.rename(devices[0], rest.slice(1).join(' '));
      return cliIO.success(`Renamed to "${rest.slice(1).join(' ')}"`);
    }
    case 'remove':
    case 'rm': {
      const devices = resolve(rest);
      if (interactive() && !(await cliIO.confirm(`Remove ${devices.map((d) => d.name).join(', ')}?`, false))) return;
      devices.forEach((d) => hub.remove(d));
      return cliIO.success(`Removed ${devices.length} device(s). They'll come back on the next scan unless unplugged.`);
    }
    case 'drivers':
      return table(hub.drivers.map((d) => [c.bold(d.id), d.name, c.dim(d.kinds.join(', ')), d.setup ? c.yellow('may need setup') : c.green('zero-config')]));
    default:
      fail(`Unknown command "${cmd}"`, 'Run `iot help`');
  }
}

main().catch((e) => {
  console.error(`${c.red('✗')} ${e.message}${e.hint ? c.dim(`\n  → ${e.hint}`) : ''}`);
  process.exitCode = 1;
});
