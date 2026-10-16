# Feature checklist

Use this to compare against an existing light-control dashboard. Each row says what the feature does, where it lives, and the non-obvious part, which is usually what a dashboard misses even when the basic feature works.

**Status key:** ✅ tested on real hardware · 🧪 tested against a protocol simulator · ⬜ written from the protocol docs, not yet run against a real device

---

## 1. Finding devices

| ✔ | Feature | Where | The non-obvious part |
|---|---|---|---|
| ☐ | Network scan, all brands in parallel | `core/hub.ts` → `scan()` | One shared mDNS + SSDP scan that every driver reuses, instead of one per brand. |
| ☐ | WiZ discovery | `drivers/wiz.ts` | Broadcast the `registration` message to UDP 38899, and send it to **every interface's subnet broadcast** (e.g. `10.0.255.255`), not just `255.255.255.255`. Send it twice: Wi-Fi drops packets. |
| ☐ | Identify each bulb's real abilities | `drivers/wiz.ts` → `describeModule()` | Read `getSystemConfig.moduleName`: `RGB` = colour, `TW` = tunable white only, `DW` = dimmable only, `SOCKET` = plug. Don't show colour controls on TW bulbs. |
| ☐ | Bulb's real white range | `drivers/wiz.ts` | `getModelConfig.cctRange` (e.g. `[2700, 2700, 6500, 6500]`). Don't assume 2200–6500. |
| ☐ | Add a device by IP | `hub.probe()`, **Add by IP** button | For when the router blocks broadcasts. If no driver recognises the device, check its open ports to hint what it is (6668 = Tuya, 9999 = Kasa, 55443 = Yeelight…). |
| ☐ | Background rescan | `web/server.ts` (every 2 min) | Bulbs switched on at the wall reappear without pressing Scan. Share one scan between the button and the timer so two never run at once. |
| ☐ | Remember devices across restarts | `core/store.ts` → `~/.iot-hub/state.json` | Keyed by MAC, not IP: DHCP moves IPs, and a rescan updates the address. File is `chmod 600` because it holds pairing tokens and keys. |
| ☐ | User renames survive rescans | `hub.upsert()` (`nameSource: 'user'`) | Otherwise every scan resets names to "WiZ Light 2BEA". |
| ☐ | List devices it can't control | `discovery/identify.ts` | Cameras, Chromecasts, HomeKit and Matter devices are shown as "no driver yet", so users know the scan saw them. |

## 2. Controlling lights

| ✔ | Feature | Where | The non-obvious part |
|---|---|---|---|
| ☐ | On / off / toggle | every driver's `execute()` | Several brands have no native toggle (Hue, Kasa, LIFX); read the state first. |
| ☐ | Brightness | | WiZ minimum is **10%**; clamp, and treat 0 as "off". |
| ☐ | White temperature | | Clamp to each bulb's own range. |
| ☐ | Colour | | **Pure white from RGB LEDs looks blue/purple** on WiZ; send `temp` instead of `r,g,b` for white. Hue needs CIE xy conversion (`util/color.ts`). |
| ☐ | Scenes, **only the ones the bulb supports** | `drivers/wiz.ts` (`TW_SCENES`, `DW_SCENES`) | A tunable-white WiZ bulb answers colour scenes (Ocean, Party…) with **`Internal error` (-32603)**. TW supports 14 scenes and DW 7; only RGB supports all 32. |
| ☐ | Several settings in one packet | `Command { type: 'set' }`, WiZ `nativeSet` | One `setPilot` with state + dimming + temp, instead of three round trips. Matters for groups and effects. |
| ☐ | Group actions with one summary | `POST /api/group` | "All on/off", **All white** (100%, 6500K) and **All warm white** (100%, 2700K). Skip bulbs already known to be offline; show one summary, not one error popup per bulb. |
| ☐ | Club mode (synchronised effect) | `core/effects.ts` | Run it **from the server**, not the browser, so bulbs stay in sync. Colour bulbs get random colours; white-only bulbs get a chase plus a beat flash in cool/warm white. Effect frames are **fire-and-forget** (no retries, 0.7 s timeout), and a bulb whose last frame is still in flight **skips the frame**, so slow bulbs can't build a queue. Auto-stops after 30 min. "All white" stops it and waits for in-flight frames, so a late frame can't overwrite the reset. |

## 3. Reliability (the part most dashboards get wrong)

Measured on an office network with 28 WiZ bulbs: most had 0% loss, but bulbs at **-80 to -84 dBm lost 53–70% of packets**, even to plain `ping`.

| ✔ | Feature | Where | The non-obvious part |
|---|---|---|---|
| ☐ | Retries for commands | `drivers/wiz.ts` → `call()` | Up to 6 attempts, 1 s each. `setPilot` is idempotent, so retrying is safe. |
| ☐ | Don't flicker offline | `hub.state()` (`OFFLINE_AFTER_MISSES = 3`) | One missed UDP reply must **not** mark a bulb offline. Keep showing the last good state until 3 polls in a row fail. This was the main cause of "constantly connecting and disconnecting". |
| ☐ | Show Wi-Fi signal strength | WiZ `getPilot.rssi` → **Weak Wi-Fi** badge | At or below -78 dBm, warn the user. It explains the drop-outs, and the fix is physical (move the router or add an extender). |
| ☐ | Errors in plain English | `hub.run()` | Not `send EHOSTUNREACH 10.0.0.96:38899`. Say "isn't responding" plus why, and say "weak Wi-Fi" when the last known signal was weak. |
| ☐ | Don't overwrite what the user is doing | `ui.html` (`busyUntil`) | Pause polling updates for a device while its slider is being dragged or a command is in flight; otherwise the slider jumps back. |
| ☐ | Throttle sliders | `ui.html` → `throttle()` | About 1 command per 350 ms while dragging, so the bulb isn't flooded. |
| ☐ | Tell the user when the server is gone | `ui.html` red banner | Otherwise every control just silently fails. |

## 4. Brands

| ✔ | Brand | Protocol | Pairing / setup | Status |
|---|---|---|---|---|
| ☐ | WiZ (also Havells and other white-label) | JSON over UDP 38899 | None. "Allow local communication" must be on in the WiZ app. | ✅ |
| ☐ | TP-Link Kasa | XOR-obfuscated JSON, TCP 9999 with 4-byte length prefix | None | 🧪 · newer KLAP firmware and Tapo not supported |
| ☐ | Yeelight | JSON-RPC over TCP 55443 | User must turn on **LAN Control** in the Yeelight app; a refused connection is reported as exactly that. | 🧪 |
| ☐ | LIFX | Binary LAN protocol, UDP 56700 | None | 🧪 |
| ☐ | Tuya / Smart Life (and many white-label brands) | AES-128 over TCP 6668 (protocol 3.3); devices announce themselves on UDP 6666/6667 | Needs each device's **local key**, which only Tuya's cloud has. Guided one-time cloud login fetches every key at once; after that, control is local. Protocol 3.4/3.5 devices fall back to cloud control. | 🧪 local · ⬜ cloud |
| ☐ | Philips Hue | Bridge REST API (v1) | Guided **link-button** pairing with a 45 s countdown; each bridge expands into its lights. | ⬜ |
| ☐ | Shelly Gen1 / Gen2+ | HTTP REST / JSON-RPC | Asks for a password only if one is set (SHA-256 digest auth for Gen2). | ⬜ (digest auth 🧪) |
| ☐ | WLED | HTTP JSON API | None | ⬜ |
| ☐ | Nanoleaf | REST, port 16021 | Guided pairing: hold the power button 5–7 s. | ⬜ |

## 5. Guided setup and troubleshooting

| ✔ | Feature | Where | The non-obvious part |
|---|---|---|---|
| ☐ | Step-by-step pairing in the browser | `SetupIO` interface, `web/server.ts` (SSE) | Drivers write setup once against an interface (steps, questions, secret input, countdowns), and both the CLI and the web UI render it. |
| ☐ | Per-brand troubleshooting tips | each driver's `troubleshooting`, **Troubleshooting** section | E.g. guest Wi-Fi and "AP isolation" block discovery; WiZ "Allow local communication"; close the Smart Life app for Tuya. |

## 6. Architecture choices worth comparing

- **Generic device model** (`core/types.ts`): every device has a `kind` and a list of `capabilities`. The UI only shows controls a device supports, and the hub refuses commands it can't do. Adding a brand means adding one driver file; adding locks or sensors means adding capabilities.
- **The browser can't talk to bulbs directly** (no UDP), so a small local server does it. It binds to `127.0.0.1` only, and device keys and tokens are stripped from API responses.

## Running it

```bash
npm install
npm run ui        # dashboard at http://localhost:7070
npm run iot       # terminal menu; `npm run iot -- help` for all commands
```
