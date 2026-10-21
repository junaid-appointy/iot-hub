# iot-hub

Discover and control smart devices on your local network, regardless of brand or protocol.

Learning how sound maps to light? Open **[docs/seeing-sound.html](docs/seeing-sound.html)** in a browser: an interactive lab for every property of sound and how it can play on the 9×6 bulb wall.

Comparing against your own dashboard? See **[FEATURES.md](FEATURES.md)**: a checklist of every feature, where it lives, and the gotchas behind it.

```bash
git clone <this repo> iot-hub && cd iot-hub && npm install
npm run ui                   # web dashboard at http://localhost:7070 (opens your browser)
npm run iot -- scan          # find everything, auto-connect, guided setup for the rest
npm run iot                  # interactive menu
npm test                     # fast regression tests (no bulbs needed)
# or install the `iot` command globally:
npm run build && npm link
```

## Commands

```
iot scan [--timeout 15] [--no-setup] [--json]
iot setup [device]                     pairing / keys / passwords (guided)
iot add <ip> [--driver wiz]            when broadcasts are blocked
iot guide [brand]                      troubleshooting per brand

iot on|off|toggle <device...>          device = name, name fragment, # from `iot list`, "all", "lights"
iot brightness <device...> 40
iot color <device...> purple | #ff8800 | 255,136,0
iot temp <device...> warm | 4000
iot scene <device> [Fireplace]

iot list | status <d> | rename <d> <name> | remove <d> | drivers
```

State (devices + credentials) lives in `~/.iot-hub/state.json` (chmod 600). Override the directory with `IOT_HUB_HOME`; `IOT_DEBUG=1` prints per-driver diagnostics.

## Supported brands

| Driver | Protocol | Setup |
|---|---|---|
| WiZ (Philips WiZ, Havells…) | JSON over UDP 38899 | none |
| TP-Link Kasa | XOR-obfuscated JSON, UDP/TCP 9999 | none |
| Yeelight | JSON-RPC over TCP 55443 | turn on "LAN Control" in the app |
| LIFX | binary LAN protocol, UDP 56700 | none |
| WLED | HTTP JSON API | none |
| Philips Hue | bridge REST API (v1) | press the bridge link button once |
| Nanoleaf | REST on port 16021 | hold power 5–7 s once |
| Shelly Gen1 / Gen2+ | HTTP REST / JSON-RPC | password only if you set one |
| Tuya / Smart Life (+ white-label) | AES-encrypted TCP 6668 (v3.3) | one-time Tuya IoT cloud login to fetch local keys |

Hosts that answer mDNS/SSDP but have no driver (cameras, Chromecasts, HomeKit, Matter…) are still listed under "Other devices on your network".

## How it works

```
CLI / backend ──► Hub ──► Driver (one per brand) ──► wire protocol
                   │
                   ├─ shared mDNS + SSDP scans (each driver awaits what it needs)
                   ├─ Store (devices, credentials)
                   └─ generic Commands: power · toggle · brightness · color · color_temp · scene
```

- **Generic device model** (`src/core/types.ts`): every device has a `kind` and a list of `capabilities`; callers send generic `Command`s and the hub refuses ones the device can't do.
- **Drivers** implement `discover`, optional `probe(ip)` and `setup(device, io)`, plus `getState` and `execute`.
- **Guided setup** goes through the `SetupIO` interface (steps, questions, secret input, waits with countdown). The CLI implements it in the terminal; a web UI can implement the same interface.

### Adding a brand or device category

1. Create `src/drivers/<brand>.ts` exporting a `Driver`, and add it to `src/drivers/index.ts`.
2. For a new category (locks, sensors, thermostats…), add capabilities and commands to `src/core/types.ts` and its `REQUIRED` entry in `src/core/hub.ts`.

### Using it as a library

```ts
import { Hub } from 'iot-hub'; // or a relative path to this repo's src/
const hub = new Hub();
await hub.scan();
for (const d of hub.find('lights')) await hub.run(d, { type: 'power', on: true });
```

## Known limitations

- Kasa devices with 2023+ firmware (KLAP) and all **Tapo** devices: not supported yet.
- Tuya protocol 3.4/3.5: local control not implemented, so these devices are controlled through the Tuya cloud once cloud credentials are set up.
- Matter / Thread / Zigbee devices without a LAN bridge: detected only, not controllable yet.
- Testing so far: WiZ against real bulbs; WiZ, Kasa, Yeelight, LIFX and Tuya-local wire formats against protocol simulators. Hue, Shelly, WLED, Nanoleaf and the Tuya cloud have not been run against real hardware yet.
