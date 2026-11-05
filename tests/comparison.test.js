import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG, makeDemo} from '../analysis.js';
import {compareAudio, selectChannel, comparisonCsv, summarize} from '../comparison.js';
const options = samples => ({samples, sampleRate: 48000, config: DEFAULT_CONFIG, source: {name: 'test', kind: 'demo'}, channel: 'left'});

test('same PCM yields repeatable A/B results and causal timestamps', () => {
  const args = options(makeDemo(48000, 3));
  const first = compareAudio(args), second = compareAudio(args);
  assert.deepEqual(first, second);
  assert(first.rows.every(row => row.audio_frame_time_s === null || row.audio_frame_time_s <= row.time_s + 1e-9));
  assert(first.rows.every(row => row.turn_a === 0));
  assert(first.rows.some(row => row.turn_b !== 0));
  assert(first.summary.a.meanSpeed > 0);
  assert(first.summary.b.meanAbsTurn > 0);
  assert.equal(first.rows.at(-1).time_s, 3);
  assert(comparisonCsv(first).includes('speed_a,turn_a'));
});
test('silence produces stopped time over the complete duration, including partial tick', () => {
  const result = compareAudio(options(new Float32Array(48000 * 1.023)));
  assert.equal(result.summary.a.meanSpeed, 0);
  assert(Math.abs(result.summary.b.stoppedSeconds - result.source.durationSeconds) < 1e-9);
});
test('statistics use elapsed time and channel selection preserves source data', () => {
  const stats = summarize([{time_s: 0, speed_a: .2, turn_a: -.1}, {time_s: .05, speed_a: 0, turn_a: 0}, {time_s: .08, speed_a: 0, turn_a: 0}], .08, 'a');
  assert(Math.abs(stats.meanSpeed - .125) < 1e-9);
  assert(Math.abs(stats.stoppedSeconds - .03) < 1e-9);
  const left = Float32Array.of(.5, -.5), right = Float32Array.of(-.5, .5);
  assert.deepEqual(selectChannel([left, right], 'mix'), Float32Array.of(0, 0));
  assert.deepEqual(selectChannel([left, right], 'right'), right);
  selectChannel([left], 'left')[0] = 0;
  assert.equal(left[0], .5);
});
test('invalid input and settings are rejected', () => {
  assert.throws(() => compareAudio(options(Float32Array.of(NaN))));
  assert.throws(() => compareAudio({...options(makeDemo(48000, 1)), config: {...DEFAULT_CONFIG, fullDb: -54}}));
  assert.throws(() => compareAudio({...options(makeDemo(48000, 1)), sampleRate: NaN}));
});
