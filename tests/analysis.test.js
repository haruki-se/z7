import test from 'node:test';
import assert from 'node:assert/strict';
import {FeatureExtractor, MotionMapper, DEFAULT_CONFIG, makeDemo, spectralCentroid, validateConfig} from '../analysis.js';
const rate = 48000, size = 2048;
const sine = (frequency, amplitude = .5) => Float32Array.from({length: size}, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate));

test('known sine: RMS, peak, and FFT centroid represent the input', () => {
  const f = new FeatureExtractor(rate).analyze(sine(750), .05);
  assert(Math.abs(f.db - -9.03) < .1);
  assert(Math.abs(f.peak - .5) < .001);
  assert(Math.abs(f.centroid - 750) < 5);
  assert.equal(f.clipped, false);
  assert(Math.abs(spectralCentroid(sine(3000), rate) - 3000) < 5);
});
test('silence has no tempo, onset, or spectral centroid', () => {
  const extractor = new FeatureExtractor(rate);
  for (let t = 0; t < 5; t += .025) {
    const f = extractor.analyze(new Float32Array(size), t);
    assert.equal(f.bpm, null); assert.equal(f.onset, false); assert.equal(f.centroid, null);
  }
});
test('120 BPM demo yields repeated attacks and stable tempo', () => {
  const extractor = new FeatureExtractor(rate), demo = makeDemo(rate);
  let f, maxBpm = 0;
  for (let start = 0; start + size <= demo.length; start += 1024) {
    f = extractor.analyze(demo.subarray(start, start + size), (start + size) / rate);
    if (f.bpm) maxBpm = f.bpm;
  }
  assert(f.onsetCount >= 14 && f.onsetCount <= 17, `attack count: ${f.onsetCount}`);
  assert(Math.abs(maxBpm - 120) < 5, `BPM: ${maxBpm}`);
  for (let t = 8; t < 11; t += .025) f = extractor.analyze(new Float32Array(size), t);
  assert.equal(f.bpm, null, 'old tempo must expire');
});
test('sustained tone does not invent repeated attacks or tempo', () => {
  const extractor = new FeatureExtractor(rate); let f;
  for (let t = .05; t < 5; t += .025) f = extractor.analyze(sine(750), t);
  assert.equal(f.onsetCount, 1); assert.equal(f.bpm, null);
});
test('clipping and sensitivity limits are explicit', () => {
  assert(new FeatureExtractor(rate).analyze(sine(750, 1), .05).clipped);
  assert(!validateConfig({...DEFAULT_CONFIG, fullDb: -54}));
  assert(!validateConfig({...DEFAULT_CONFIG, maxSpeed: Infinity}));
});
test('mapping A rises with loudness, bounds output, stops immediately on silence or stale data', () => {
  const mapper = new MotionMapper(); let output;
  for (let i = 0; i < 100; i++) output = mapper.step({db: -5, onsetCount: 1}, DEFAULT_CONFIG, i * .05);
  assert(output.speed > .29 && output.speed <= .3); assert.equal(output.turn, 0);
  assert.equal(mapper.step({db: -80, onsetCount: 1}, DEFAULT_CONFIG, 5).speed, 0);
  assert.equal(mapper.step({db: -5, onsetCount: 1}, DEFAULT_CONFIG, 5.05, false).speed, 0);
  assert.equal(mapper.step({db: NaN}, DEFAULT_CONFIG, 6).speed, 0);
});
test('mapping B alternates turns on new attacks and stays within wheel limits', () => {
  const mapper = new MotionMapper(), config = {...DEFAULT_CONFIG, profile: 'expression', maxSpeed: .6, maxTurn: .6};
  const a = mapper.step({db: -5, onsetCount: 1, bpm: 120}, config, 1);
  const b = mapper.step({db: -5, onsetCount: 2, bpm: 200}, config, 2);
  assert(a.turn > 0); assert(b.turn < 0);
  for (const o of [a, b]) { assert(Math.abs(o.left) <= 1); assert(Math.abs(o.right) <= 1); assert(o.speed <= .6); }
});
