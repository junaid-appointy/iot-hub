# Shows

Choreographed light shows, one JSON file per show, made in the dashboard (**Matrix → Show**). Commit them alongside `layouts/`.

The song itself is **not** stored (size, copyright). The file holds the cues plus the analysed *song map*, so the server can play the show with exact timing; the dashboard asks for the song file only to play the sound.

```jsonc
{
  "version": 2,
  "id": "my-song", "name": "My song", "layout": "auditorium",
  "audio": { "fileName": "my-song.mp3", "duration": 214.3 },
  "bpm": 124,
  "offsetMs": 0,                    // manual fine-tune on top of calibration (+ = lights later)

  // Song map (from analysis)
  "beats": [0.42, 0.904, ...],      // beat times, s
  "downbeats": [0, 4, 8, ...],      // indices into beats that start a bar
  "kicks":  [[0.42, 1.0], ...],     // [time s, strength 0..1]
  "snares": [[0.904, 0.8], ...],
  "hats":   [[0.663, 0.5], ...],
  "env":   [12, 15, ...],           // loudness 0..99, 10 per second
  "bands": [[...], ...],            // 6 band envelopes 0..99, 20 per second (bass → treble)
  "sections": [{ "start": 0, "end": 15, "type": "intro" }, ...],   // intro/verse/build/drop/chorus/breakdown/outro

  "cues": [
    { "t": 0,  "pattern": "breathe", "palette": "dual", "intensity": 0.6, "label": "Intro" },
    { "t": 45, "pattern": "riser",   "palette": "dual", "intensity": 1,   "label": "Build-up" },
    { "t": 60, "pattern": "blinder", "palette": "dual", "intensity": 1,   "label": "Drop hit" },
    { "t": 64, "pattern": "chase",   "stepOn": "beat", "palette": "cool" }
  ]
}
```

- `pattern`: an id from `src/core/patterns.ts`. Music looks read beats, bars and drum hits from the song map.
- `palette`: `dual` (the look's own warm/cool layer), `cool`, `warm` or `neutral` white.
- `stepOn: "beat"` advances a basic pattern once per beat. `intensity` (0–1) scales brightness.
- Set `IOT_HUB_SHOWS=/path/to/folder` to keep shows elsewhere.
