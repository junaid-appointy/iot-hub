/* iot-hub audio engine (browser side), v2.
 *
 * LiveAnalyzer    mic / system sound / <audio> → bands, loudness, kick/snare/hat onsets,
 *                 plus a BeatTracker that locks tempo + bar phase and predicts beats and
 *                 the repeating drum groove ahead of time (so lights can land on time).
 * analyzeSong     whole file → beats (DP tracker), downbeats, drum hit maps, loudness and
 *                 band envelopes, sections (intro/verse/build/drop/breakdown/outro).
 * autoChoreograph song map → section-aware cue list.
 * tapTest helpers for sync calibration.
 *
 * All timestamps are wall-clock ms (Date.now() domain), shared with the server.
 * Exposed as window.IotAudio.
 */
(() => {
  const BAND_EDGES = [40, 120, 300, 800, 2000, 5000, 12000];
  const DRUMS = { kick: [40, 130], snare: [1500, 4500], hat: [7000, 14000] };
  const DYNAMIC_RANGE_DB = 36;
  const SILENCE_DB = -82;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const wallNow = () => performance.timeOrigin + performance.now();
  const median = (xs) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  // ---------------------------------------------------------------------------
  // Onset detector: positive log-energy flux with an adaptive threshold.
  // ---------------------------------------------------------------------------
  class OnsetDetector {
    constructor(minGapMs, k = 1.6) {
      this.minGapMs = minGapMs;
      this.k = k;
      this.prevLog = null;
      this.mean = 0;
      this.var = 0.0001;
      this.last = -1e9;
      this.prevFlux = 0;
    }
    /** Returns strength 0..1 when an onset is detected, else 0. */
    push(energy, t, sensitivity = 1) {
      const lg = Math.log(energy + 1e-9);
      const flux = this.prevLog === null ? 0 : Math.max(0, lg - this.prevLog);
      this.prevLog = 0.6 * lg + 0.4 * (this.prevLog ?? lg); // light smoothing of the reference
      const thr = this.mean + (this.k / sensitivity) * Math.sqrt(this.var) + 0.02;
      // Running stats over ~0.6 s at 60 fps.
      const a = 0.03;
      const d = flux - this.mean;
      this.mean += a * d;
      this.var = (1 - a) * (this.var + a * d * d);
      let hit = 0;
      if (flux > thr && flux >= this.prevFlux && t - this.last > this.minGapMs) {
        hit = clamp01((flux - thr) / (thr + 0.05) + 0.45);
        this.last = t;
      }
      this.prevFlux = flux;
      return hit;
    }
  }

  // ---------------------------------------------------------------------------
  // Beat tracker: tempo from inter-onset intervals, phase-locked loop on kicks,
  // downbeat from where kicks fall in the bar, and a 16-step groove model per drum.
  // ---------------------------------------------------------------------------
  class BeatTracker {
    constructor() {
      this.onsets = []; // {t, s} kick-ish onsets, last 12 s
      this.period = 0; // ms
      this.candidate = 0;
      this.candidateSince = 0;
      this.stableSince = 0;
      this.nextBeat = 0; // wall ms of the next beat
      this.beatIndex = 0; // index of nextBeat
      this.matches = []; // last beats: did an onset land near them?
      this.matchedThisBeat = false;
      this.slotWeight = [1, 0, 0, 0]; // kick strength per beat-in-bar slot
      this.groove = { kick: new Float32Array(16), snare: new Float32Array(16), hat: new Float32Array(16) };
      this.barSeen = { kick: new Float32Array(16), snare: new Float32Array(16), hat: new Float32Array(16) };
      this.barIndex = -1;
      this.sentPredictions = new Set();
      this.lastTempoAt = 0;
      this.clock = wallNow; // replaceable for testing
    }

    get locked() {
      const recent = this.matches.slice(-8);
      const conf = recent.length ? recent.filter(Boolean).length / recent.length : 0;
      return this.period > 0 && recent.length >= 6 && conf >= 0.5 && this.clock() - this.stableSince > 2500;
    }
    get confidence() {
      const recent = this.matches.slice(-8);
      return recent.length ? recent.filter(Boolean).length / recent.length : 0;
    }
    get bpm() {
      return this.period ? Math.round(60000 / this.period) : 0;
    }
    /** Beat index (mod 4) that starts a bar. */
    get downSlot() {
      let best = 0;
      for (let i = 1; i < 4; i++) if (this.slotWeight[i] > this.slotWeight[best]) best = i;
      return best;
    }

    estimateTempo(now) {
      const os = this.onsets.filter((o) => now - o.t < 10000);
      if (os.length < 6) return;
      // Histogram of intervals between onsets, folded into 75–180 BPM, with a soft prior at ~120.
      const bins = new Float32Array(140); // 330..1030 ms in 5 ms bins
      for (let i = 0; i < os.length; i++) {
        for (let j = i + 1; j < os.length && os[j].t - os[i].t < 2100; j++) {
          let iv = os[j].t - os[i].t;
          while (iv > 800) iv /= 2;
          while (iv < 333) iv *= 2;
          // Nearby pairs are the strongest evidence; long intervals (3, 5, 6 beats…) fold into
          // misleading tempos, so they count for less.
          const w = Math.min(os[i].s, os[j].s) * Math.exp(-(os[j].t - os[i].t) / 700);
          const c = (iv - 330) / 5;
          for (let b = Math.max(0, Math.floor(c) - 2); b <= Math.min(139, Math.ceil(c) + 2); b++) bins[b] += w * Math.exp(-((b - c) ** 2) / 2);
        }
      }
      let best = 0, bestV = -1;
      for (let b = 0; b < bins.length; b++) {
        const iv = 330 + b * 5;
        const prior = Math.exp(-0.5 * (Math.log2(iv / 500) / 0.8) ** 2);
        const v = bins[b] * prior;
        if (v > bestV) (bestV = v), (best = iv);
      }
      if (!best) return;
      if (!this.period) {
        this.period = best;
        this.stableSince = now;
        this.nextBeat = os[os.length - 1].t + best;
        return;
      }
      const rel = Math.abs(best - this.period) / this.period;
      if (rel < 0.04) {
        this.period = 0.85 * this.period + 0.15 * best;
        this.candidate = 0;
      } else if (Math.abs(best - this.candidate) / best < 0.04) {
        if (now - this.candidateSince > 3000) {
          // A new tempo held for 3 s: switch.
          this.period = best;
          this.stableSince = now;
          this.matches = [];
          this.candidate = 0;
        }
      } else {
        this.candidate = best;
        this.candidateSince = now;
      }
    }

    onOnset(drum, t, s) {
      if (drum === 'kick') {
        this.onsets.push({ t, s });
        if (this.onsets.length > 120) this.onsets.shift();
      }
      if (!this.period) return;
      // Phase-locked loop: nudge the grid towards kicks that land near a beat.
      if (drum === 'kick') {
        const prev = this.nextBeat - this.period;
        const near = Math.abs(t - prev) < Math.abs(t - this.nextBeat) ? prev : this.nextBeat;
        const err = t - near;
        if (Math.abs(err) < 0.18 * this.period) {
          this.nextBeat += 0.3 * err;
          this.period += 0.05 * err;
          // Credit the beat this kick belongs to: the upcoming one, or the one that just passed.
          let beatIdx;
          if (near === prev) {
            if (this.matches.length) this.matches[this.matches.length - 1] = true;
            beatIdx = this.beatIndex - 1;
          } else {
            this.matchedThisBeat = true;
            beatIdx = this.beatIndex;
          }
          const slot = ((beatIdx % 4) + 4) % 4;
          this.slotWeight = this.slotWeight.map((w, i) => w * 0.97 + (i === slot ? s : 0));
        }
      }
      // Groove model: which 16th of the bar did this land on?
      const step = this.stepAt(t);
      if (step) {
        const err = Math.abs(t - step.time);
        if (err < this.period / 8) this.barSeen[drum][step.slot] = Math.max(this.barSeen[drum][step.slot], s);
      }
    }

    /** The 16th-note slot (within a 4/4 bar) nearest to time t. */
    stepAt(t) {
      if (!this.period) return null;
      const sixteenth = this.period / 4;
      const k = Math.round((t - this.nextBeat) / sixteenth); // relative 16ths from nextBeat
      const time = this.nextBeat + k * sixteenth;
      const beat = this.beatIndex + Math.floor(k / 4);
      const sub = ((k % 4) + 4) % 4;
      const beatInBar = (((beat - this.downSlot) % 4) + 4) % 4;
      const bar = Math.floor((beat - this.downSlot) / 4);
      return { slot: beatInBar * 4 + sub, time, bar };
    }

    /** Advance the flywheel; called every frame. */
    tick(now) {
      if (now - this.lastTempoAt > 500) {
        this.lastTempoAt = now;
        this.estimateTempo(now);
      }
      if (!this.period) return;
      while (now > this.nextBeat + this.period * 0.5) {
        this.matches.push(this.matchedThisBeat);
        if (this.matches.length > 16) this.matches.shift();
        this.matchedThisBeat = false;
        this.nextBeat += this.period;
        this.beatIndex++;
        const beatInBar = (((this.beatIndex - this.downSlot) % 4) + 4) % 4;
        if (beatInBar === 0) this.closeBar();
      }
    }

    closeBar() {
      // Learn the groove: exponential average of which 16ths had each drum in the last bar.
      for (const d of Object.keys(this.groove)) {
        for (let i = 0; i < 16; i++) this.groove[d][i] = 0.75 * this.groove[d][i] + 0.25 * this.barSeen[d][i];
        this.barSeen[d].fill(0);
      }
    }

    grid() {
      if (!this.period) return null;
      const downbeat = this.beatIndex - ((((this.beatIndex - this.downSlot) % 4) + 4) % 4);
      return { anchorMs: Math.round(this.nextBeat), anchorBeat: this.beatIndex, periodMs: this.period, downbeat, locked: this.locked };
    }

    /** Groove hits expected within the next `horizonMs` that haven't been sent yet. */
    predictions(now, horizonMs) {
      if (!this.locked) return [];
      const out = [];
      const sixteenth = this.period / 4;
      const first = Math.ceil((now - this.nextBeat) / sixteenth);
      const last = Math.floor((now + horizonMs - this.nextBeat) / sixteenth);
      for (let k = first; k <= last; k++) {
        const time = this.nextBeat + k * sixteenth;
        const step = this.stepAt(time);
        for (const d of ['kick', 'snare', 'hat']) {
          const w = this.groove[d][step.slot];
          if (w < 0.5) continue;
          const id = `${d}:${Math.round(time / 10)}`;
          if (this.sentPredictions.has(id)) continue;
          this.sentPredictions.add(id);
          out.push({ at: Math.round(time), type: d, strength: Math.min(1, w) });
        }
      }
      if (this.sentPredictions.size > 400) this.sentPredictions = new Set([...this.sentPredictions].slice(-200));
      return out;
    }

    /** Was a hit of this drum near t already predicted (so we don't send it twice)? */
    wasPredicted(drum, t) {
      if (!this.locked) return false;
      const step = this.stepAt(t);
      return !!step && this.groove[drum][step.slot] >= 0.5 && Math.abs(t - step.time) < 80;
    }
  }

  // ---------------------------------------------------------------------------
  // Live analyser
  // ---------------------------------------------------------------------------
  class LiveAnalyzer {
    constructor() {
      this.ctx = null;
      this.analyser = null;
      this.input = null;
      this.stream = null;
      this.sensitivity = 1;
      this.listeners = new Set();
      this.running = false;
      this.source = null;
      this.reset();
    }

    reset() {
      this.peaks = BAND_EDGES.slice(1).map(() => -60);
      this.levelPeak = -40;
      this.detectors = { kick: new OnsetDetector(140), snare: new OnsetDetector(110, 1.8), hat: new OnsetDetector(65, 1.9) };
      this.tracker = new BeatTracker();
    }

    async ensureContext() {
      if (!this.ctx) {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0;
        this.freq = new Float32Array(this.analyser.frequencyBinCount);
        this.time = new Float32Array(this.analyser.fftSize);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    }

    /** Output delay of this context's sound (ms), as reported by the browser. */
    get outputLatencyMs() {
      if (!this.ctx) return 0;
      return Math.round(((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000);
    }

    async useMicrophone(deviceId) {
      await this.ensureContext();
      this.disconnect();
      const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (deviceId) constraints.deviceId = { exact: deviceId };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      this.connectStream('mic');
    }

    async useSystemAudio() {
      await this.ensureContext();
      this.disconnect();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
      stream.getVideoTracks().forEach((t) => t.stop());
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('No sound was shared. Pick a Chrome tab and keep "Share tab audio" on, or share your entire screen with "Share system audio" ticked.');
      }
      this.stream = stream;
      this.connectStream('system');
    }

    connectStream(kind) {
      this.source = kind;
      this.input = this.ctx.createMediaStreamSource(this.stream);
      this.input.connect(this.analyser);
      this.stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        this.stop();
        this.onEnded?.(kind);
      });
      this.reset();
      this.start();
    }

    async useElement(el) {
      await this.ensureContext();
      this.disconnect();
      this.source = 'file';
      el._iotSource ??= this.ctx.createMediaElementSource(el);
      this.input = el._iotSource;
      this.input.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.reset();
      this.start();
    }

    disconnect() {
      try { this.input?.disconnect(); } catch {}
      try { this.analyser?.disconnect(); } catch {}
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.input = null;
    }

    stop() {
      this.disconnect();
      this.running = false;
      this.source = null;
    }

    start() {
      if (this.running) return;
      this.running = true;
      const loop = () => {
        if (!this.running) return;
        const f = this.measure();
        this.listeners.forEach((fn) => fn(f));
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    onFeatures(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    /**
     * When was what we're analysing actually *heard*? The FFT window makes us ~25 ms
     * late; system/tab capture is ahead of the speakers by the output delay.
     */
    heardTime(now) {
      if (this.source === 'system') return now + this.outputLatencyMs - 25;
      if (this.source === 'file') return now + this.outputLatencyMs - 25;
      return now - 25;
    }

    measure() {
      const a = this.analyser;
      a.getFloatFrequencyData(this.freq);
      a.getFloatTimeDomainData(this.time);
      const binHz = this.ctx.sampleRate / a.fftSize;
      const lin = (lo, hi) => {
        const i0 = Math.max(1, Math.floor(lo / binHz)), i1 = Math.min(this.freq.length - 1, Math.ceil(hi / binHz));
        let s = 0;
        for (let i = i0; i <= i1; i++) s += Math.pow(10, this.freq[i] / 20);
        return s / (i1 - i0 + 1);
      };
      const bands = [];
      for (let b = 0; b < BAND_EDGES.length - 1; b++) {
        const db = 20 * Math.log10(lin(BAND_EDGES[b], BAND_EDGES[b + 1]) + 1e-9);
        this.peaks[b] = Math.max(db, this.peaks[b] - 0.05);
        bands.push(db < SILENCE_DB ? 0 : clamp01((db - (this.peaks[b] - DYNAMIC_RANGE_DB)) / DYNAMIC_RANGE_DB));
      }
      let rms = 0;
      for (const v of this.time) rms += v * v;
      const levelDb = 20 * Math.log10(Math.sqrt(rms / this.time.length) + 1e-9);
      this.levelPeak = Math.max(levelDb, this.levelPeak - 0.05);
      const level = levelDb < SILENCE_DB ? 0 : clamp01((levelDb - (this.levelPeak - DYNAMIC_RANGE_DB)) / DYNAMIC_RANGE_DB);

      const now = wallNow();
      const heard = this.heardTime(now);
      const onsets = [];
      if (level > 0.05) {
        for (const [drum, [lo, hi]] of Object.entries(DRUMS)) {
          const s = this.detectors[drum].push(lin(lo, hi), heard, this.sensitivity);
          if (s) {
            onsets.push({ type: drum, at: Math.round(heard), strength: s });
            this.tracker.onOnset(drum, heard, s);
          }
        }
      }
      this.tracker.tick(heard);
      return { level, bands, onsets, beat: onsets.some((o) => o.type === 'kick'), bpm: this.tracker.bpm, locked: this.tracker.locked, confidence: this.tracker.confidence, now };
    }
  }

  // ---------------------------------------------------------------------------
  // Offline song analysis
  // ---------------------------------------------------------------------------
  /** Renders the song through 9 filters at once: kick, snare, hat, and the 6 display bands. */
  async function filterBank(buffer) {
    const sr = buffer.sampleRate;
    const off = new OfflineAudioContext(9, buffer.length, sr);
    const src = off.createBufferSource();
    src.buffer = buffer;
    const merger = off.createChannelMerger(9);
    const chain = (out, ...filters) => {
      let node = src;
      for (const [type, f, q] of filters) {
        const b = off.createBiquadFilter();
        b.type = type;
        b.frequency.value = f;
        if (q) b.Q.value = q;
        node.connect(b);
        node = b;
      }
      node.connect(merger, 0, out);
    };
    chain(0, ['lowpass', 120], ['lowpass', 120]); // kick (steeper with two stages)
    chain(1, ['bandpass', 2600, 0.9]); // snare crack
    chain(2, ['highpass', 7500], ['highpass', 7500]); // hi-hats
    for (let b = 0; b < 6; b++) {
      const lo = BAND_EDGES[b], hi = BAND_EDGES[b + 1];
      const centre = Math.sqrt(lo * hi);
      chain(3 + b, ['bandpass', centre, centre / (hi - lo) * 1.4]);
    }
    merger.connect(off.destination);
    src.start();
    return off.startRendering();
  }

  /** RMS per hop (10 ms) of a channel. */
  function envelope(data, hop) {
    const n = Math.floor(data.length / hop);
    const out = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let e = 0;
      for (let i = f * hop, end = i + hop; i < end; i++) e += data[i] * data[i];
      out[f] = Math.sqrt(e / hop);
    }
    return out;
  }

  /** Onset strength (positive log-flux), normalised to unit std. */
  function onsetStrength(env) {
    const n = env.length;
    const out = new Float32Array(n);
    let prev = Math.log(env[0] + 1e-6);
    for (let f = 1; f < n; f++) {
      const lg = Math.log(env[f] + 1e-6);
      out[f] = Math.max(0, lg - prev);
      prev = 0.5 * lg + 0.5 * prev;
    }
    let mean = 0;
    for (const v of out) mean += v;
    mean /= n;
    let sd = 0;
    for (const v of out) sd += (v - mean) ** 2;
    sd = Math.sqrt(sd / n) || 1;
    for (let f = 0; f < n; f++) out[f] /= sd;
    return out;
  }

  /** Peak-picked onsets: local max above a moving threshold, with a minimum gap. */
  function pickOnsets(odf, minGapFrames, k = 1.2) {
    const n = odf.length, w = 25;
    const picks = [];
    let sum = 0, sumSq = 0;
    for (let i = 0; i < Math.min(n, 2 * w + 1); i++) (sum += odf[i]), (sumSq += odf[i] * odf[i]);
    let last = -1e9;
    for (let f = 0; f < n; f++) {
      const lo = f - w - 1, hi = f + w;
      if (lo >= 0) (sum -= odf[lo]), (sumSq -= odf[lo] * odf[lo]);
      if (hi < n && f > w) (sum += odf[hi]), (sumSq += odf[hi] * odf[hi]);
      const cnt = Math.min(n, f + w + 1) - Math.max(0, f - w);
      const mean = sum / cnt;
      const sd = Math.sqrt(Math.max(0, sumSq / cnt - mean * mean));
      const thr = mean + k * sd + 0.3;
      if (odf[f] > thr && odf[f] >= (odf[f - 1] ?? 0) && odf[f] >= (odf[f + 1] ?? 0) && f - last >= minGapFrames) {
        picks.push([f, odf[f]]);
        last = f;
      }
    }
    // Strength relative to the strong hits of this drum.
    const strong = median(picks.map((p) => p[1]).sort((a, b) => b - a).slice(0, Math.max(1, Math.floor(picks.length / 5)))) || 1;
    return picks.map(([f, v]) => [Math.round(f * 10) / 1000, Math.round(clamp01(v / strong) * 100) / 100]);
  }

  /** Tempo by autocorrelation with a prior around 120 BPM (avoids half/double-time). */
  function tempoOf(odf) {
    let bestLag = 50, best = -1;
    for (let lag = 33; lag <= 86; lag++) {
      let s = 0;
      for (let f = lag; f < odf.length; f++) s += odf[f] * odf[f - lag];
      // Also reward the double period (bar-level structure) a little.
      let s2 = 0;
      for (let f = 2 * lag; f < odf.length; f += 1) s2 += odf[f] * odf[f - 2 * lag];
      const bpm = 6000 / lag;
      const v = (s + 0.5 * s2) * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.8) ** 2);
      if (v > best) (best = v), (bestLag = lag);
    }
    // Refine to sub-frame precision with a parabola around the peak.
    const at = (lag) => { let s = 0; for (let f = lag; f < odf.length; f++) s += odf[f] * odf[f - lag]; return s; };
    const y0 = at(bestLag - 1), y1 = at(bestLag), y2 = at(bestLag + 1);
    const denom = y0 - 2 * y1 + y2;
    return bestLag + (denom ? 0.5 * (y0 - y2) / denom : 0);
  }

  /** Dynamic-programming beat tracker (Ellis 2007): best path of onsets ~one period apart. */
  function trackBeats(odf, period, tightness = 120) {
    const n = odf.length;
    const score = new Float32Array(n), back = new Int32Array(n).fill(-1);
    const lo = Math.round(period / 2), hi = Math.round(period * 2);
    for (let t = 0; t < n; t++) {
      let best = 0, arg = -1;
      for (let p = t - hi; p <= t - lo; p++) {
        if (p < 0) continue;
        const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
        if (arg < 0 || v > best) (best = v), (arg = p);
      }
      score[t] = odf[t] + (arg >= 0 ? Math.max(0, best) : 0);
      back[t] = arg >= 0 && best > 0 ? arg : -1;
    }
    // Best end point within the last period.
    let end = n - 1;
    for (let t = n - 1; t >= Math.max(0, n - Math.round(period)); t--) if (score[t] > score[end]) end = t;
    const beats = [];
    for (let t = end; t >= 0; t = back[t]) {
      beats.push(t);
      if (back[t] < 0) break;
    }
    beats.reverse();
    // Extend the grid back to the start of the song if the path started late.
    while (beats[0] - period > 0) beats.unshift(Math.round(beats[0] - period));
    return beats;
  }

  /**
   * Make the beat path continuous: fill gaps (e.g. a drum-less breakdown where the
   * tracker skipped a beat) and drop doubles, so counting bars can't slip.
   */
  function regularise(frames, period, n) {
    const out = [frames[0]];
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i] - out[out.length - 1];
      if (gap < period * 0.5) continue;
      const missing = Math.round(gap / period) - 1;
      for (let k = 1; k <= missing; k++) out.push(Math.round(out[out.length - 1] + gap / (missing + 1)));
      out.push(frames[i]);
    }
    while (out[out.length - 1] + period < n) out.push(Math.round(out[out.length - 1] + period));
    return out;
  }

  /**
   * Most dance/pop music has one steady tempo. If the tracked beats agree with a
   * single straight grid, use that grid (fitted on beats that coincide with kicks),
   * gently snapped to nearby kicks. This stops quiet, drum-less passages from
   * pulling the beat onto the off-beat. Returns null for songs with real tempo drift.
   */
  function steadyGrid(frames, kickFrames, n) {
    const kickSet = kickFrames;
    const nearKick = (f) => kickSet.some((k) => Math.abs(k - f) <= 3);
    const pts = frames.map((f, i) => [i, f]).filter(([, f]) => nearKick(f));
    if (pts.length < 16) return null;
    // Least-squares line frame = a + i * P over beats that sit on kicks.
    const fit = (ps) => {
      const m = ps.length, sx = ps.reduce((a, p) => a + p[0], 0), sy = ps.reduce((a, p) => a + p[1], 0);
      const sxx = ps.reduce((a, p) => a + p[0] * p[0], 0), sxy = ps.reduce((a, p) => a + p[0] * p[1], 0);
      const P = (m * sxy - sx * sy) / (m * sxx - sx * sx);
      return { P, a: (sy - P * sx) / m };
    };
    let { P, a } = fit(pts);
    // Refit without outliers (kicks that are off the main grid, e.g. syncopation).
    const inliers = pts.filter(([i, f]) => Math.abs(f - (a + i * P)) < P * 0.12);
    if (inliers.length >= 16) ({ P, a } = fit(inliers));
    const agree = frames.filter((f, i) => Math.abs(f - (a + i * P)) < P * 0.1).length / frames.length;
    const kickAgree = pts.filter(([i, f]) => Math.abs(f - (a + i * P)) < P * 0.1).length / pts.length;
    if (kickAgree < 0.8 || agree < 0.6) return null;
    const out = [];
    // Start from the earliest grid beat in the song (a beat right at 0:00 may fit at a tiny negative frame).
    let i0 = 0;
    while (a + (i0 - 1) * P > -P * 0.25) i0--;
    for (let i = i0, f = a + i0 * P; f < n; i++, f = a + i * P) {
      const k = kickSet.find((x) => Math.abs(x - f) <= 2);
      out.push(Math.max(0, Math.round(k ?? f)));
    }
    return out;
  }

  async function analyzeSong(arrayBuffer, onProgress = () => {}) {
    onProgress('Decoding audio…');
    const decoder = new OfflineAudioContext(1, 1, 44100);
    const buffer = await decoder.decodeAudioData(arrayBuffer);
    const sr = buffer.sampleRate;
    const hop = Math.round(sr * 0.01);

    onProgress('Separating kick, snare and hi-hats…');
    const bank = await filterBank(buffer);
    const ch = (i) => bank.getChannelData(i);

    onProgress('Measuring loudness…');
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const mono = new Float32Array(buffer.length);
    for (const c of channels) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / channels.length;
    const full = envelope(mono, hop);
    const kickEnv = envelope(ch(0), hop), snareEnv = envelope(ch(1), hop), hatEnv = envelope(ch(2), hop);
    const n = full.length;

    onProgress('Finding the beat…');
    const kickOdf = onsetStrength(kickEnv), snareOdf = onsetStrength(snareEnv), hatOdf = onsetStrength(hatEnv), fullOdf = onsetStrength(full);
    const beatOdf = new Float32Array(n);
    for (let f = 0; f < n; f++) beatOdf[f] = kickOdf[f] + 0.5 * snareOdf[f] + 0.4 * fullOdf[f];
    const period = tempoOf(beatOdf);
    const tracked = regularise(trackBeats(beatOdf, period), period, n);
    const kickPeaks = pickOnsets(kickOdf, 12, 1.2).map((h) => Math.round(h[0] * 100));
    const beatFrames = steadyGrid(tracked, kickPeaks, n) ?? tracked;
    const beats = beatFrames.map((f) => Math.round(f * 10) / 1000);

    onProgress('Finding bars and drum hits…');
    // Downbeat: the beat offset (0..3) where kicks are strongest.
    const nearMax = (odf, f) => Math.max(odf[f - 1] ?? 0, odf[f] ?? 0, odf[f + 1] ?? 0, odf[f + 2] ?? 0);
    const offsetScore = [0, 0, 0, 0];
    beatFrames.forEach((f, i) => (offsetScore[i % 4] += nearMax(kickOdf, f) + 0.3 * nearMax(fullOdf, f)));
    const downOffset = offsetScore.indexOf(Math.max(...offsetScore));
    const downbeats = beatFrames.map((_, i) => i).filter((i) => i % 4 === downOffset);
    const kicks = pickOnsets(kickOdf, 12, 1.2);
    // A "snare" whose hi-hat band jumps harder at the same moment is just a hi-hat leaking into the snare band.
    const snareOnly = new Float32Array(n);
    for (let f = 0; f < n; f++) snareOnly[f] = Math.max(0, snareOdf[f] - 0.6 * Math.max(hatOdf[f], hatOdf[f - 1] ?? 0));
    const snares = pickOnsets(snareOnly, 12, 2.4);
    const hats = pickOnsets(hatOdf, 8, 2.4);

    onProgress('Finding the song sections…');
    // Loudness (10/s) and band envelopes (20/s), scaled 0..99 against the loud parts of the song.
    const scaleTo99 = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const ref = s[Math.floor(s.length * 0.97)] || 1;
      return Array.from(arr, (v) => Math.round(clamp01(v / ref) * 99));
    };
    const pool = (env, per) => {
      const out = new Float32Array(Math.ceil(env.length / per));
      for (let i = 0; i < out.length; i++) {
        let s = 0, c = 0;
        for (let f = i * per; f < Math.min(env.length, (i + 1) * per); f++) (s += env[f]), c++;
        out[i] = c ? s / c : 0;
      }
      return out;
    };
    const env = scaleTo99(pool(full, 10));
    const bands = Array.from({ length: 6 }, (_, b) => scaleTo99(pool(envelope(ch(3 + b), hop), 5)));
    const sections = findSections({ duration: buffer.duration, beats, downbeats, env, kicks, snares, hats });

    return { duration: buffer.duration, bpm: Math.round((6000 / period) * 10) / 10, beats, downbeats, kicks, snares, hats, env, bands, sections };
  }

  /**
   * Sections from per-bar features (loudness, kicks, snares, hi-hat level):
   * boundaries where the 4 bars after differ most from the 4 bars before
   * (snapped to 4-bar phrases), then labelled by level and context —
   * build = rising into something clearly louder, drop = loud right after a build
   * or a big jump, breakdown = kick-less or quiet after loud, intro/outro at the ends.
   */
  function findSections({ duration, beats, downbeats, env, kicks, snares, hats }) {
    const barTimes = downbeats.map((i) => beats[i]);
    if (barTimes.length < 8) return [{ start: 0, end: duration, type: 'verse' }];
    const energyOver = (a, b) => {
      let s = 0, c = 0;
      for (let t = a; t < b; t += 0.1) (s += env[Math.min(env.length - 1, Math.floor(t * 10))] / 99), c++;
      return c ? s / c : 0;
    };
    const inBar = (hits, a, b) => hits.filter((h) => h[0] >= a && h[0] < b);
    const raw = barTimes.map((t, i) => {
      const end = barTimes[i + 1] ?? Math.min(duration, t + (t - (barTimes[i - 1] ?? t - 2)));
      const k = inBar(kicks, t, end), sn = inBar(snares, t, end), h = inBar(hats, t, end);
      return { start: t, end, e: energyOver(t, end), kick: k.reduce((a, x) => a + x[1], 0), snare: sn.length, hat: h.reduce((a, x) => a + x[1], 0) };
    });
    // Normalise each feature to 0..1 over the song (robust to outliers).
    const norm01 = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      const lo = s[Math.floor(s.length * 0.05)], hi = s[Math.floor(s.length * 0.95)];
      return xs.map((x) => clamp01((x - lo) / Math.max(1e-6, hi - lo)));
    };
    const E = norm01(raw.map((b) => b.e)), K = norm01(raw.map((b) => b.kick)), S = norm01(raw.map((b) => b.snare)), H = norm01(raw.map((b) => b.hat));
    const B = raw.length;
    const mean = (xs, a, b) => { const v = xs.slice(Math.max(0, a), Math.min(B, b)); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; };
    const novelty = (i) => {
      const d = [E, K, S, H].map((X, j) => (mean(X, i, i + 4) - mean(X, i - 4, i)) * [1.4, 1.2, 0.6, 0.6][j]);
      return Math.hypot(...d);
    };
    const nov = Array.from({ length: B }, (_, i) => (i < 2 || i > B - 2 ? 0 : novelty(i)));
    const avgNov = nov.reduce((a, b) => a + b, 0) / B;
    // Peaks, strongest first, at least 4 bars apart; snap to the 4-bar phrase grid when close.
    const candidates = nov.map((v, i) => [v, i]).filter(([v, i]) => v > Math.max(0.2, avgNov * 1.6) && v >= nov[i - 1] && v >= (nov[i + 1] ?? 0)).sort((a, b) => b[0] - a[0]);
    const cuts = [0];
    for (const [, i] of candidates) {
      const snapped = Math.abs(i - Math.round(i / 4) * 4) <= 1 ? Math.round(i / 4) * 4 : i;
      if (snapped <= 0 || snapped >= B) continue;
      if (cuts.every((c) => Math.abs(c - snapped) >= 4)) cuts.push(snapped);
    }
    cuts.sort((a, b) => a - b);
    // Very long sections get split into 16-bar phrases so looks still change.
    const bounds = [];
    for (let k = 0; k < cuts.length; k++) {
      const a = cuts[k], b = cuts[k + 1] ?? B;
      for (let x = a; x < b; x += 32) bounds.push([x, Math.min(b, x + 32)]);
    }
    const segs = bounds.map(([a, b]) => ({
      a, b, start: raw[a].start, end: b < B ? raw[b].start : duration,
      e: mean(E, a, b), k: mean(K, a, b), slope: mean(E, b - 2, b) - mean(E, a, a + 2),
      snareRise: mean(S, b - 2, b) - mean(S, a, a + 2), type: '',
    }));
    segs.forEach((s, i) => {
      const prev = segs[i - 1], next = segs[i + 1];
      const level = s.e < 0.35 ? 'low' : s.e > 0.66 ? 'high' : 'mid';
      // A build rises *within itself* (louder or busier snares towards its end) and leads into something bigger.
      const risesWithin = s.slope > 0.08 || s.snareRise > 0.25;
      const biggerNext = next && (next.e > s.e + 0.1 || next.k > s.k + 0.25);
      if (i > 0 && next && risesWithin && biggerNext && s.b - s.a <= 16) s.type = 'build';
      else if (level === 'high' && prev && (prev.type === 'build' || s.e - prev.e > 0.25)) s.type = 'drop';
      else if (level === 'high') s.type = 'chorus';
      else if (i === 0) s.type = 'intro';
      else if (!next) s.type = 'outro';
      else if ((level === 'low' || s.k < 0.2) && prev && prev.e > s.e) s.type = 'breakdown';
      else s.type = 'verse';
    });
    // Merge neighbours with the same label.
    const out = [];
    for (const s of segs) {
      const last = out[out.length - 1];
      if (last && last.type === s.type && s.type !== 'verse' && s.type !== 'chorus') last.end = s.end;
      else out.push({ start: s.start, end: s.end, type: s.type });
    }
    if (out.length) out[0].start = 0; // the first section covers any pickup before the first bar
    return out.map(({ start, end, type }) => ({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, type }));
  }

  /** Energy (0..1) of the song around time t (env is 0..99 at 10/s). */
  const energyAt = (env, t) => (env[Math.max(0, Math.min(env.length - 1, Math.floor(t * 10)))] ?? 0) / 99;

  // ---------------------------------------------------------------------------
  // Choreographer
  // ---------------------------------------------------------------------------
  const LOOKS = {
    intro: [{ pattern: 'breathe', palette: 'dual', intensity: 0.6 }, { pattern: 'wave', palette: 'dual', intensity: 0.65 }],
    verse: [
      { pattern: 'kick-snare', palette: 'dual', intensity: 0.85 },
      { pattern: 'scanner', palette: 'dual', intensity: 0.85 },
      { pattern: 'quadrants', palette: 'dual', intensity: 0.85 },
      { pattern: 'chase', palette: 'cool', stepOn: 'beat', intensity: 0.8 },
      { pattern: 'diagonal', palette: 'dual', intensity: 0.85 },
      { pattern: 'beat-climb', palette: 'dual', intensity: 0.85 },
    ],
    build: [{ pattern: 'riser', palette: 'dual', intensity: 1 }],
    drop: [
      { pattern: 'burst', palette: 'dual', intensity: 1 },
      { pattern: 'kick-snare', palette: 'dual', intensity: 1 },
      { pattern: 'mirror-spectrum', palette: 'dual', intensity: 1 },
      { pattern: 'beat-sparkle', palette: 'cool', intensity: 1 },
      { pattern: 'checker', palette: 'cool', stepOn: 'beat', intensity: 1 },
    ],
    chorus: [
      { pattern: 'mirror-spectrum', palette: 'dual', intensity: 0.95 },
      { pattern: 'scanner', palette: 'dual', params: { axis: 'rows' }, intensity: 0.95 },
      { pattern: 'burst', palette: 'dual', intensity: 0.95 },
      { pattern: 'kick-snare', palette: 'dual', intensity: 0.95 },
    ],
    breakdown: [{ pattern: 'wave', palette: 'dual', intensity: 0.6 }, { pattern: 'hat-rain', palette: 'dual', intensity: 0.6 }],
    outro: [{ pattern: 'breathe', palette: 'warm', intensity: 0.5 }],
  };
  const PRETTY = { intro: 'Intro', verse: 'Verse', build: 'Build-up', drop: 'Drop', chorus: 'Chorus', breakdown: 'Breakdown', outro: 'Outro' };

  /**
   * Cues per section, changing look every 8 bars (4 in short sections), with
   * a blinder on the first bar of every drop and a single riser across builds.
   */
  function autoChoreograph(song) {
    const { beats, downbeats = [], sections = [], duration } = song;
    if (!sections.length || !downbeats.length) return legacyChoreograph(song);
    const barTimes = downbeats.map((i) => beats[i]);
    const cues = [];
    const used = {};
    const round = (t) => Math.round(t * 100) / 100;
    for (const sec of sections) {
      const looks = LOOKS[sec.type] ?? LOOKS.verse;
      const startBar = barTimes.findIndex((t) => t >= sec.start - 0.05);
      const bars = barTimes.filter((t) => t >= sec.start - 0.05 && t < sec.end - 0.05);
      const label = PRETTY[sec.type] ?? sec.type;
      if (sec.type === 'build') {
        cues.push({ t: round(sec.start), ...looks[0], label });
        continue;
      }
      let from = 0;
      if (sec.type === 'drop' && bars.length > 1) {
        cues.push({ t: round(sec.start), pattern: 'blinder', palette: 'dual', intensity: 1, label: 'Drop hit' });
        from = 1;
      }
      const phrase = bars.length <= 8 ? 4 : 8;
      for (let b = from; b < Math.max(bars.length, 1); b += phrase) {
        used[sec.type] = (used[sec.type] ?? -1) + 1;
        let look = looks[used[sec.type] % looks.length];
        if (cues.length && cues[cues.length - 1].pattern === look.pattern && looks.length > 1) {
          used[sec.type]++;
          look = looks[used[sec.type] % looks.length];
        }
        const t = b === 0 ? sec.start : bars[b] ?? sec.start;
        cues.push({ t: round(t), stepOn: 'timer', ...look, label });
      }
      void startBar;
    }
    // Gentle fade on the very last cue.
    if (cues.length) cues[cues.length - 1].intensity = Math.min(cues[cues.length - 1].intensity ?? 1, 0.55);
    return cues.filter((c, i) => i === 0 || c.t > cues[i - 1].t || c.pattern !== cues[i - 1].pattern);
  }

  /** Fallback when sections couldn't be found: 16-beat phrases by energy rank. */
  function legacyChoreograph({ duration, beats, env }) {
    const starts = [];
    if (beats.length > 32) for (let i = 0; i < beats.length; i += 16) starts.push(beats[i]);
    else for (let t = 0; t < duration; t += 8) starts.push(t);
    starts[0] = 0;
    const es = starts.map((t, i) => { let s = 0, c = 0; for (let x = t; x < (starts[i + 1] ?? duration); x += 0.1) (s += energyAt(env, x)), c++; return c ? s / c : 0; });
    const ranked = [...es].sort((a, b) => a - b);
    const count = { verse: 0, drop: 0, intro: 0 };
    return starts.map((t, i) => {
      const r = ranked.indexOf(es[i]) / Math.max(1, ranked.length - 1);
      const kind = r < 0.3 ? 'intro' : r < 0.72 ? 'verse' : 'drop';
      const looks = LOOKS[kind];
      return { t: Math.round(t * 100) / 100, stepOn: 'timer', ...looks[count[kind]++ % looks.length], label: PRETTY[kind] };
    });
  }

  // ---------------------------------------------------------------------------
  // Tap calibration helpers
  // ---------------------------------------------------------------------------
  /** Schedule audible clicks; returns their wall-clock send times (ms). */
  async function playClicks(ctx, count, intervalMs, startInMs = 1200) {
    if (ctx.state === 'suspended') await ctx.resume();
    const times = [];
    const t0 = ctx.currentTime + startInMs / 1000;
    const wall0 = wallNow() + startInMs;
    for (let i = 0; i < count; i++) {
      const at = t0 + (i * intervalMs) / 1000;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = i % 4 === 0 ? 1500 : 1000;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.6, at + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.06);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.08);
      times.push(wall0 + i * intervalMs);
    }
    return times;
  }

  /** Median offset of taps from their nearest event, ignoring the first few and stray taps. */
  function tapOffset(events, taps, skip = 3) {
    const offsets = [];
    for (const tap of taps) {
      let best = null;
      for (const e of events) if (best === null || Math.abs(tap - e) < Math.abs(tap - best)) best = e;
      if (best === null) continue;
      const idx = events.indexOf(best);
      const d = tap - best;
      if (idx >= skip && Math.abs(d) < 450) offsets.push(d);
    }
    if (offsets.length < 6) return null;
    const m = median(offsets);
    const spread = median(offsets.map((x) => Math.abs(x - m)));
    return { offsetMs: Math.round(m), spreadMs: Math.round(spread), used: offsets.length };
  }

  window.IotAudio = { LiveAnalyzer, BeatTracker, analyzeSong, autoChoreograph, energyAt, playClicks, tapOffset, wallNow, PRETTY };
})();
