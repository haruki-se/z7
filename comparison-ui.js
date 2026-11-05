import {makeDemo} from './analysis.js';
import {selectChannel, comparisonCsv, MAX_AUDIO_SECONDS, MAX_FILE_BYTES} from './comparison.js';

const $ = id => document.getElementById(id);
const COLORS = {a: '#b5f578', b: '#81cfff'};
const configKey = (config, channel) => JSON.stringify({...config, profile: 'both', channel});

export function initComparison({getConfig, getChannel, onPrepare, onPlay}) {
  let selection = null, result = null, worker = null, generation = 0, loading = false, playing = false;
  let resultKey = '', memo = '';
  const say = text => { $('comparisonStatus').textContent = text; };
  function buttons() {
    $('compareStart').disabled = loading || !!worker || !selection;
    $('compareCancel').disabled = !loading && !worker;
    $('comparePlay').disabled = loading || !!worker || playing || !selection;
    $('compareCsv').disabled = $('compareJson').disabled = !result || !!worker;
  }
  function cancel(showMessage = true) {
    generation++; loading = false; worker?.terminate(); worker = null;
    if (showMessage) say('計算・読み込みを中止しました。');
    buttons();
  }
  function select(next) {
    selection = next; result = null; resultKey = '';
    $('comparisonResults').hidden = true;
    $('comparisonSource').textContent = `${next.name} · ${next.buffer.duration.toFixed(2)}秒 · ${next.buffer.sampleRate} Hz · ${next.buffer.numberOfChannels} ch`;
    $('comparisonProgress').value = 0;
    say('音源を準備しました。「同じ音源でA/B比較」で計算します。'); buttons();
  }
  function useDemo() {
    cancel(false); onPrepare();
    const buffer = new AudioBuffer({numberOfChannels: 1, length: 48000 * 8, sampleRate: 48000});
    buffer.copyToChannel(makeDemo(48000), 0);
    select({buffer, kind: 'demo', name: '合成デモ / 120 BPM', demoVersion: '0.2.0'});
  }
  async function loadBlob(blob, {name = '録音音声', kind = 'file'} = {}) {
    cancel(false); onPrepare();
    const job = generation;
    loading = true; buttons(); say('音声を読み込み中…');
    try {
      if (!blob.size || blob.size > MAX_FILE_BYTES) throw new Error('ファイルは25 MB以内にしてください。');
      const bytes = await blob.arrayBuffer();
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      if (job !== generation) return;
      const decoder = new OfflineAudioContext(2, 1, 48000);
      const buffer = await decoder.decodeAudioData(bytes);
      if (job !== generation) return;
      if (buffer.duration < .2 || buffer.duration > MAX_AUDIO_SECONDS) throw new Error('音声は0.2秒以上120秒以内にしてください。');
      const sha256 = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
      select({buffer, name, kind, encodedSha256: sha256, encodedBytes: blob.size});
    } catch (error) {
      if (job === generation) say(error.name === 'EncodingError' ? 'この音声を読み込めません。WAVなどブラウザが対応する形式を選んでください。' : error.message);
    } finally { if (job === generation) { loading = false; buttons(); } }
  }
  function compare() {
    const config = getConfig(), channel = getChannel();
    if (!config) { say('入力感度・動作設定を修正してから比較してください。'); return; }
    if (!selection || loading || worker) return;
    onPrepare();
    const source = {...selection}; delete source.buffer;
    const samples = selectChannel(Array.from({length: Math.min(selection.buffer.numberOfChannels, 2)}, (_, i) => selection.buffer.getChannelData(i)), channel);
    const job = ++generation;
    memo = $('comparisonNote').value;
    const startedAt = new Date().toISOString();
    $('comparisonProgress').value = 0; say('同じ音源・同じ設定でルールA/Bを計算中…');
    try {
      worker = new Worker(new URL('./comparison-worker.js', import.meta.url), {type: 'module'});
      buttons();
      const fail = text => { if (job !== generation) return; cancel(false); say(text); };
      worker.onerror = error => { error.preventDefault(); fail('比較処理を開始できません。サーバーを再起動してページを再読み込みしてください。'); };
      worker.onmessageerror = () => fail('比較結果を読み取れませんでした。');
      worker.onmessage = ({data}) => {
        if (job !== generation) return;
        if (data.type === 'progress') { $('comparisonProgress').value = data.percent; return; }
        if (data.type === 'error') { fail(data.message); return; }
        if (data.type !== 'result') return;
        worker.terminate(); worker = null;
        result = {...data.result, createdAt: startedAt, note: memo, browser: navigator.userAgent};
        resultKey = configKey(config, channel);
        $('comparisonResults').hidden = false; $('compareCursor').max = result.rows.length - 1; $('compareCursor').value = 0;
        const percent = value => `${(value * 100).toFixed(1)}%`;
        for (const [suffix, stats] of Object.entries({A: result.summary.a, B: result.summary.b})) {
          $(`meanSpeed${suffix}`).textContent = percent(stats.meanSpeed);
          $(`meanTurn${suffix}`).textContent = percent(stats.meanAbsTurn);
          $(`peakSpeed${suffix}`).textContent = percent(stats.peakSpeed);
          $(`stopped${suffix}`).textContent = `${stats.stoppedSeconds.toFixed(2)}秒`;
        }
        $('comparisonFacts').textContent = `${result.source.durationSeconds.toFixed(2)}秒 / アタック ${result.summary.onsetCount}回 / クリップ付近 ${result.summary.clippedFrames}窓 / 解析 ${result.summary.featureFrames}窓`;
        $('comparisonConditions').textContent = `計算時：${source.name} · ${channel === 'left' ? '左' : channel === 'right' ? '右' : '左右平均'} · 無音 ${config.gateDb} dBFS / 強音 ${config.fullDb} dBFS / アタック ${config.attackDb} dB / 速度上限 ${Math.round(config.maxSpeed * 100)}% / 旋回上限 ${Math.round(config.maxTurn * 100)}% / 追従 ${config.smoothing}秒`;
        say('比較が完了しました。グラフの位置を選ぶと、その時点の指令を確認できます。');
        markSettingsChanged(); draw(); buttons();
      };
      worker.postMessage({samples, sampleRate: selection.buffer.sampleRate, config: {...config}, source, channel}, [samples.buffer]);
    } catch (error) { cancel(false); say(`比較を開始できません：${error.message}`); }
  }
  function markSettingsChanged() {
    const config = getConfig();
    $('comparisonChanged').hidden = !result || (!!config && configKey(config, getChannel()) === resultKey);
  }
  function drawChart(canvas, key, min, max, cursor) {
    const pen = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    const left = 55, right = w - 16, top = 18, bottom = h - 32;
    const x = time => left + time / result.source.durationSeconds * (right - left);
    const y = value => bottom - (value - min) / (max - min) * (bottom - top);
    pen.clearRect(0, 0, w, h); pen.font = '12px system-ui';
    for (let i = 0; i <= 4; i++) {
      const v = min + (max - min) * i / 4;
      pen.strokeStyle = '#33434d'; pen.lineWidth = 1; pen.beginPath(); pen.moveTo(left, y(v)); pen.lineTo(right, y(v)); pen.stroke();
      pen.fillStyle = '#bdcbd6'; pen.textAlign = 'right'; pen.fillText(`${Math.round(v * 100)}%`, left - 8, y(v) + 4);
      const t = result.source.durationSeconds * i / 4;
      pen.textAlign = 'center'; pen.fillText(`${t.toFixed(1)}s`, x(t), h - 10);
    }
    for (const suffix of ['a', 'b']) {
      pen.strokeStyle = COLORS[suffix]; pen.lineWidth = 2;
      pen.setLineDash(suffix === 'b' ? [6, 3] : []); pen.beginPath();
      result.rows.forEach((row, i) => {
        // Commands are held until the next 50 ms tick, not linearly interpolated.
        if (i) { pen.lineTo(x(row.time_s), y(result.rows[i - 1][`${key}_${suffix}`])); pen.lineTo(x(row.time_s), y(row[`${key}_${suffix}`])); }
        else pen.moveTo(x(row.time_s), y(row[`${key}_${suffix}`]));
      }); pen.stroke();
    }
    pen.setLineDash([]); pen.strokeStyle = '#ffffffaa'; pen.lineWidth = 1; pen.beginPath(); pen.moveTo(x(cursor.time_s), top); pen.lineTo(x(cursor.time_s), bottom); pen.stroke();
  }
  function draw() {
    if (!result) return;
    const row = result.rows[+$('compareCursor').value];
    drawChart($('compareSpeedChart'), 'speed', 0, .6, row);
    drawChart($('compareTurnChart'), 'turn', -.6, .6, row);
    $('compareCursorValue').textContent = `${row.time_s.toFixed(2)} 秒`;
    $('compareReadout').textContent = `A 前進 ${(row.speed_a * 100).toFixed(1)}% / 旋回 ${(row.turn_a * 100).toFixed(1)}%　B 前進 ${(row.speed_b * 100).toFixed(1)}% / 旋回 ${(row.turn_b * 100).toFixed(1)}%`;
  }
  function download(contents, extension, type) {
    const url = URL.createObjectURL(new Blob([contents], {type})), link = document.createElement('a');
    link.href = url; link.download = `guitar-comparison-${result.createdAt.replace(/[:.]/g, '-')}.${extension}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('comparisonFile').onchange = event => {
    const file = event.target.files[0];
    if (file) loadBlob(file, {name: file.name});
    event.target.value = '';
  };
  $('compareDemo').onclick = useDemo;
  $('compareStart').onclick = compare;
  $('compareCancel').onclick = () => cancel();
  $('comparePlay').onclick = () => { if (selection && !worker && !loading) onPlay(selection); };
  $('compareCursor').oninput = draw;
  for (const id of ['compareSpeedChart', 'compareTurnChart']) $(id).onclick = event => {
    if (!result) return;
    const rect = $(id).getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width * $(id).width;
    const time = Math.max(0, Math.min(1, (x - 55) / ($(id).width - 71))) * result.source.durationSeconds;
    $('compareCursor').value = Math.min(result.rows.length - 1, Math.round(time * 20)); draw();
  };
  $('compareCsv').onclick = () => { if (result) download(comparisonCsv(result), 'csv', 'text/csv;charset=utf-8'); };
  $('compareJson').onclick = () => { if (result) download(JSON.stringify(result, null, 2), 'json', 'application/json'); };
  buttons();
  return {loadBlob, markSettingsChanged, cancel, setPlayback(value) { playing = value; buttons(); }};
}
