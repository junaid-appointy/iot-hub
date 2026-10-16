# Layouts

Physical light installations, one JSON file per layout. `auditorium.json` is created from the dashboard (**Matrix** tab → Create grid) and updated every time a bulb is placed or the numbering changes. Commit it: it is the record of which bulb hangs where.

## Format

```jsonc
{
  "id": "auditorium",
  "name": "Auditorium",
  "rows": 9,                 // top to bottom
  "cols": 6,                 // left to right
  "cells": [["wiz:cc4085ba2bea", null, ...], ...],  // cells[row][col] = device id (row 0 = top, col 0 = left)
  "numbering": {
    "start": "top-left",     // top-left | top-right | bottom-left | bottom-right: where #1 is
    "direction": "rows",     // rows: count along a row first; columns: down a column first
    "serpentine": false,     // zigzag: every other row/column runs back the other way
    "reverse": false         // count from the end (last cell becomes #1)
  },
  "calibration": {           // sync timing for this installation (Matrix → Sync card)
    "lightLatencyMs": 182,   // command → visible change; from the tap test (or estimated)
    "lightSource": "tap",
    "bulbs": { "wiz:cc4085ba2bea": { "rttMs": 34 }, ... }   // network round trip per bulb; null = no answer
  },
  "updatedAt": "…",
  "bulbs": [                 // derived from cells + numbering on every save; handy for other tools
    { "number": 1, "row": 1, "col": 1, "id": "wiz:cc4085ba2bea", "mac": "cc4085ba2bea",
      "name": "WiZ Light 2BEA", "model": "ESP25_SHTW_01", "brand": "wiz", "lastKnownIp": "10.0.0.86" }
  ]
}
```

- `cells` and `numbering` are the source of truth; `bulbs` uses **1-based** row/col for readability.
- Identify bulbs by **MAC**. IPs come from DHCP and can change; `lastKnownIp` is only a hint (run a scan to refresh it).
- Device credentials are never stored here; they stay in `~/.iot-hub/state.json` on each machine.
- To keep layouts elsewhere, set `IOT_HUB_LAYOUTS=/path/to/folder`.
