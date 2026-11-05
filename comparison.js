import {FeatureExtractor, MotionMapper, validateConfig} from './analysis.js';

export const COMPARISON_VERSION = 1;
export const MAX_AUDIO_SECONDS = 120;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function selectChannel(channels, channel) {
  if (!['left', 'right', 'mix'].includes(channel) || !channels.length || !channels[0].length) throw new Error('解析チャンネルが無効です。');
  const left = channels[0], right = channels[1] || left;
  if (left.length !== right.length) throw new Error('音声チャンネルの長さが一致しません。');
  if (channel !== 'mix') return new Float32Array(channel === 'right' ? right : left);
  return Float32Array.from(left, (value, i) => (value + right[i]) / 2);
}

export function summarize(rows, duration, suffix) {
  let speedArea = 0, turnArea = 0, stoppedSeconds = 0, peakSpeed = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const row = rows[i], dt = rows[i + 1].time_s - row.time_s;
    const speed = row[`speed_${suffix}`], turn = row[`turn_${suffix}`];
    speedArea += speed * dt; turnArea += Math.abs(turn) * dt;
    if (speed === 0 && turn === 0) stoppedSeconds += dt;
    peakSpeed = Math.max(peakSpeed, speed);
  }
  return {meanSpeed: speedArea / duration, meanAbsTurn: turnArea / duration, peakSpeed, stoppedSeconds};
}

// Both mappers receive the SAME causal features on the SAME 50 ms timeline.
// Run in a Worker in the UI; deterministic and independent of browser animation timing.
export function compareAudio({samples, sampleRate, config, source, channel}, progress = () => {}) {
  if (!validateConfig(config)) throw new Error('入力感度・動作設定を修正してください。');
  if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('音声データが無効です。');
  const duration = samples.length / sampleRate;
  if (duration < .2 || duration > MAX_AUDIO_SECONDS) throw new Error('音声は0.2秒以上120秒以内にしてください。');
  if (!samples.every(Number.isFinite)) throw new Error('音声に不正な数値が含まれています。');
  const extractor = new FeatureExtractor(sampleRate), features = [];
  const frameSize = 2048, hopSize = 1024;
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const {wave, ...feature} = extractor.analyze(samples.subarray(start, start + frameSize), (start + frameSize) / sampleRate, config.gateDb, config.attackDb);
    features.push(feature);
    if (start % (hopSize * 64) === 0) progress(Math.floor(90 * start / samples.length));
  }
  const a = new MotionMapper(), b = new MotionMapper();
  const configA = {...config, profile: 'volume'}, configB = {...config, profile: 'expression'};
  const rows = [];
  let index = -1;
  for (let tick = 0; tick <= Math.ceil(duration * 20); tick++) {
    const time = Math.min(tick / 20, duration);
    while (index + 1 < features.length && features[index + 1].time <= time + 1e-9) index++;
    const f = features[index];
    const fresh = !!f && time - f.time < .25;
    const outA = a.step(f, configA, time, fresh), outB = b.step(f, configB, time, fresh);
    rows.push({time_s: time, audio_frame_time_s: f?.time ?? null, db: f?.db ?? null, rms: f?.rms ?? null, peak: f?.peak ?? null, clipped: f?.clipped ? 1 : 0,
      onset_count: f?.onsetCount ?? 0, bpm: f?.bpm ?? null, centroid_hz: f?.centroid ?? null,
      speed_a: outA.speed, turn_a: outA.turn, left_a: outA.left, right_a: outA.right,
      speed_b: outB.speed, turn_b: outB.turn, left_b: outB.left, right_b: outB.right});
  }
  progress(100);
  return {version: COMPARISON_VERSION, appVersion: '0.3.0', kind: 'rule-comparison', source: {...source, durationSeconds: duration, sampleRate}, channel,
    configs: {a: configA, b: configB}, method: {frameSize, hopSize, commandIntervalSeconds: .05, integration: 'left-hold, time weighted', frameTiming: 'frame end; no future samples', units: 'normalized commands, not measured physical motion'},
    summary: {a: summarize(rows, duration, 'a'), b: summarize(rows, duration, 'b'), onsetCount: features.at(-1)?.onsetCount ?? 0, featureFrames: features.length, clippedFrames: features.filter(f => f.clipped).length}, rows};
}

export function comparisonCsv(result) {
  const columns = Object.keys(result.rows[0]);
  // Only numeric data, null and fixed header names are written; filenames/notes stay in JSON.
  return '\uFEFF' + [columns.join(','), ...result.rows.map(row => columns.map(column => row[column] ?? '').join(','))].join('\r\n');
}
