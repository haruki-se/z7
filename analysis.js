// Shared by AudioWorklet and deterministic Node tests. No DOM or network access.
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Radix-2 FFT of a Hann-windowed frame; magnitude-weighted spectral centroid.
export function spectralCentroid(samples, sampleRate) {
  const n = samples.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i] * .5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let size = 2; size <= n; size *= 2) {
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const angle = -2 * Math.PI * k / size, a = start + k, b = a + size / 2;
        const tr = re[b] * Math.cos(angle) - im[b] * Math.sin(angle);
        const ti = re[b] * Math.sin(angle) + im[b] * Math.cos(angle);
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  let weight = 0, total = 0;
  for (let k = 1; k <= n / 2; k++) {
    const magnitude = Math.hypot(re[k], im[k]);
    weight += magnitude; total += magnitude * k * sampleRate / n;
  }
  return weight > 1e-8 ? total / weight : null;
}

export class FeatureExtractor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.baseline = -120;
    this.previousDb = -120;
    this.onsets = [];
    this.onsetCount = 0;
    this.lastOnset = -Infinity;
  }
  analyze(samples, time, gateDb = -55, attackDb = 6) {
    let squares = 0, peak = 0;
    for (const v of samples) { squares += v * v; peak = Math.max(peak, Math.abs(v)); }
    const rms = Math.sqrt(squares / samples.length);
    const db = Math.max(-120, 20 * Math.log10(Math.max(rms, 1e-6)));
    const onset = db > gateDb && db - this.baseline >= attackDb && db - this.previousDb >= 3 && time - this.lastOnset > .18;
    if (onset) {
      if (time - this.lastOnset > 2) this.onsets = [];
      this.lastOnset = time; this.onsets.push(time);
      if (this.onsets.length > 9) this.onsets.shift();
      this.onsetCount++;
    }
    this.baseline += .2 * (db - this.baseline);
    this.previousDb = db;
    let bpm = null, tempoConfidence = 0;
    if (time - this.lastOnset <= 2 && this.onsets.length >= 4) {
      const intervals = this.onsets.slice(1).map((t, i) => t - this.onsets[i]);
      const interval = median(intervals);
      const deviation = median(intervals.map(v => Math.abs(v - interval))) / interval;
      if (interval >= .25 && interval <= 1.5 && deviation < .2) {
        bpm = 60 / interval; tempoConfidence = clamp(1 - deviation * 5, 0, 1);
      }
    }
    return {time, rms, db, peak, clipped: peak >= .98, onset, onsetCount: this.onsetCount, bpm, tempoConfidence,
      centroid: db > gateDb ? spectralCentroid(samples, this.sampleRate) : null,
      wave: Array.from({length: 128}, (_, i) => samples[Math.floor(i * samples.length / 128)])};
  }
}

export const DEFAULT_CONFIG = Object.freeze({gateDb: -55, fullDb: -15, attackDb: 6, maxSpeed: .3, maxTurn: .3, smoothing: .18, profile: 'volume'});
export function validateConfig(c) {
  return ['volume', 'expression'].includes(c.profile) &&
    Number.isFinite(c.gateDb) && c.gateDb >= -90 && c.gateDb <= -10 &&
    Number.isFinite(c.fullDb) && c.fullDb >= c.gateDb + 6 && c.fullDb <= 0 &&
    Number.isFinite(c.attackDb) && c.attackDb >= 3 && c.attackDb <= 20 &&
    Number.isFinite(c.maxSpeed) && c.maxSpeed >= 0 && c.maxSpeed <= .6 &&
    Number.isFinite(c.maxTurn) && c.maxTurn >= 0 && c.maxTurn <= .6 &&
    Number.isFinite(c.smoothing) && c.smoothing >= .05 && c.smoothing <= 1;
}
export class MotionMapper {
  constructor() { this.reset(); }
  reset() { this.speed = 0; this.lastTime = null; this.lastCount = 0; this.turnAt = -Infinity; this.direction = -1; }
  step(feature, config, now, fresh = true) {
    const dt = this.lastTime === null ? .05 : clamp(now - this.lastTime, 0, .1);
    this.lastTime = now;
    if (!validateConfig(config) || !fresh || !feature || !Number.isFinite(feature.db) || feature.db <= config.gateDb) {
      this.speed = 0; this.turnAt = -Infinity;
      if (feature) this.lastCount = feature.onsetCount;
      return {speed: 0, turn: 0, left: 0, right: 0, intensity: 0};
    }
    const intensity = clamp((feature.db - config.gateDb) / (config.fullDb - config.gateDb), 0, 1);
    if (feature.onsetCount > this.lastCount) { this.direction *= -1; this.turnAt = now; this.lastCount = feature.onsetCount; }
    const rhythm = config.profile === 'expression' && feature.bpm ? clamp(feature.bpm / 120, .6, 1.4) : 1;
    const target = Math.min(config.maxSpeed, intensity * config.maxSpeed * rhythm);
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / config.smoothing));
    const turn = config.profile === 'expression' ? this.direction * config.maxTurn * intensity * Math.exp(-(now - this.turnAt) / .25) : 0;
    // Normalize the wheel pair together to retain the intended curvature.
    const scale = Math.max(1, Math.abs(this.speed + turn), Math.abs(this.speed - turn));
    return {speed: this.speed, turn, left: (this.speed + turn) / scale, right: (this.speed - turn) / scale, intensity};
  }
}
export function makeDemo(sampleRate, duration = 8) {
  const data = new Float32Array(sampleRate * duration);
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate, beat = Math.floor(t / .5), phase = t % .5;
    const envelope = phase < .32 ? Math.min(1, phase / .008) * Math.exp(-phase * 12) : 0;
    const frequency = [110, 146.83, 164.81, 220][beat % 4];
    const amplitude = beat % 4 === 0 ? .65 : beat % 2 ? .16 : .35;
    data[i] = amplitude * envelope * (Math.sin(2 * Math.PI * frequency * t) + .25 * Math.sin(4 * Math.PI * frequency * t)) / 1.25;
  }
  return data;
}
