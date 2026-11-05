import {initComparison} from './comparison-ui.js';
import {DEFAULT_CONFIG, MotionMapper, clamp, makeDemo, validateConfig} from './analysis.js';
const $ = id => document.getElementById(id);
let config = {...DEFAULT_CONFIG}, session = null, feature = null, receivedAt = 0;
let monitoring = false, paused = false, calibration = null, configValid = true;
let recorder = null, recordingTimer, recordingUrl, recordingBlob, recordingPending = false;
let comparisonUi;
let log = null, logging = false, logStarted = 0;
let bridge = null, armed = null, sending = false, arming = false, armGeneration = 0, txStatus = null;
const mapper = new MotionMapper();
const zero = () => ({speed: 0, turn: 0, left: 0, right: 0, intensity: 0});
let command = zero();
let position = {x: 450, y: 260, heading: -Math.PI / 2}, path = [];
const secureAudio = !!navigator.mediaDevices?.getUserMedia && !!window.AudioWorkletNode;
$('start').disabled = !secureAudio;
$('demo').disabled = !window.AudioWorkletNode;
if (!secureAudio) $('status').textContent = 'Chrome / Edgeで localhost または HTTPS のページを開いてください。';

function event(type, detail = {}) {
  if (logging) log.events.push({elapsed_ms: Math.round(performance.now() - logStarted), type, ...detail});
}
function message(id, text) { if ($(id).textContent !== text) $(id).textContent = text; }
async function devices() {
  if (!navigator.mediaDevices) return;
  const selected = $('device').value;
  const list = await navigator.mediaDevices.enumerateDevices();
  $('device').replaceChildren(new Option('既定の入力', ''));
  list.filter(d => d.kind === 'audioinput').forEach((d, i) => $('device').add(new Option(d.label || `入力 ${i + 1}`, d.deviceId)));
  if ([...$('device').options].some(o => o.value === selected)) $('device').value = selected;
}
function updateMonitor() {
  if (session?.gain) session.gain.gain.setTargetAtTime(monitoring ? +$('volume').value / 100 : 0, session.context.currentTime, .015);
  $('monitor').setAttribute('aria-pressed', String(monitoring));
  $('monitor').textContent = monitoring ? 'スピーカー出力をオフ' : 'スピーカー出力をオン';
  message('outputStatus', monitoring ? '出力オン · OSの既定の出力へ再生中' : '出力オフ');
}
$('monitor').onclick = async () => {
  const s = session;
  if (!s?.ready) return;
  try {
    await s.context.resume(); if (session !== s) return;
    monitoring = !monitoring; if (monitoring) $('playback').pause(); updateMonitor();
  } catch { message('outputStatus', '出力を開始できません。入力を再接続してください。'); }
};
$('volume').oninput = () => { $('volumeValue').value = `${$('volume').value}%`; updateMonitor(); };
$('playback').onplay = () => { monitoring = false; updateMonitor(); };
function updateSettings() {
  session?.worklet?.port.postMessage({...config, channel: $('channel').value});
}
function finishRecording() {
  clearTimeout(recordingTimer);
  if (recorder?.state === 'recording') recorder.stop();
  $('recordStop').disabled = true;
}
function stopLog(reason = '記録を終了しました。CSV / JSONを保存できます。') {
  if (!logging) return;
  event('log_stop'); logging = false;
  log.endedAt = new Date().toISOString();
  $('logStart').disabled = !session?.ready; $('logStop').disabled = true; $('experimentNote').disabled = false;
  $('exportCsv').disabled = $('exportJson').disabled = !log.rows.length;
  message('logStatus', reason);
}
function stopAudio(reason = '入力は停止中です。') {
  disarm('入力停止'); finishRecording();
  monitoring = false; updateMonitor();
  const old = session; session = null;
  if (old) {
    old.input?.getTracks().forEach(track => track.stop());
    old.recordStream?.getTracks().forEach(track => track.stop());
    if (old.mode !== 'live') { try { old.source?.stop(); } catch {} }
    old.worklet?.disconnect(); old.context.close().catch(() => {});
  }
  comparisonUi?.setPlayback(false);
  feature = null; calibration = null; mapper.reset(); command = zero();
  stopLog('入力停止に合わせて実験記録を終了しました。');
  $('start').disabled = !secureAudio; $('demo').disabled = !window.AudioWorkletNode;
  $('device').disabled = false;
  for (const id of ['stop', 'monitor', 'record', 'calibrate', 'logStart']) $(id).disabled = true;
  $('connection').textContent = '停止中'; $('connection').classList.remove('active');
  message('detail', '入力デバイスは接続していません。'); message('status', reason);
  renderFeatures();
}
async function startAudio(mode, selection = null) {
  stopAudio(); paused = false; $('resumeMotion').hidden = true;
  const s = {mode, context: new AudioContext({latencyHint: 'interactive', ...(mode === 'file' ? {sampleRate: selection.buffer.sampleRate} : {})}), ready: false};
  if (mode === 'file') comparisonUi?.setPlayback(true);
  session = s;
  $('start').disabled = $('demo').disabled = $('device').disabled = true; $('stop').disabled = false;
  message('status', mode === 'live' ? '入力の許可・接続を待っています…' : mode === 'file' ? 'ファイル再生を準備しています…' : 'デモ音源を準備しています…');
  try {
    await s.context.resume();
    if (mode === 'live') {
      const deviceId = $('device').value;
      const input = await navigator.mediaDevices.getUserMedia({audio: {deviceId: deviceId ? {exact: deviceId} : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
      if (session !== s) { input.getTracks().forEach(track => track.stop()); return; }
      s.input = input; s.source = s.context.createMediaStreamSource(input);
      const track = input.getAudioTracks()[0]; s.device = track.label;
      track.onended = () => { if (session === s) stopAudio('入力が切断されました。動作と送信を停止しました。'); };
      await devices().catch(() => {});
      if (track.getSettings().deviceId) $('device').value = track.getSettings().deviceId;
    } else if (mode === 'file') {
      s.source = s.context.createBufferSource(); s.source.buffer = selection.buffer;
      s.device = selection.name; s.fileSource = {kind: selection.kind, name: selection.name, encodedSha256: selection.encodedSha256 ?? null};
      s.source.onended = () => { if (session === s) stopAudio('ファイルの再生が終了しました。動作・送信を停止しました。'); };
    } else {
      const buffer = s.context.createBuffer(1, s.context.sampleRate * 8, s.context.sampleRate);
      buffer.copyToChannel(makeDemo(s.context.sampleRate), 0);
      s.source = s.context.createBufferSource(); s.source.buffer = buffer; s.source.loop = true;
      s.device = '合成デモ音源 / 120 BPM';
    }
    if (session !== s) return;
    await s.context.audioWorklet.addModule('./feature-worklet.js');
    if (session !== s) return;
    s.worklet = new AudioWorkletNode(s.context, 'guitar-features');
    s.worklet.port.onmessage = ({data}) => {
      if (session !== s) return;
      feature = data; receivedAt = performance.now();
      if (calibration) calibration.values.push(data.db);
    };
    s.worklet.onprocessorerror = () => { if (session === s) stopAudio('音声解析が停止しました。入力を再接続してください。'); };
    updateSettings(); s.source.connect(s.worklet); s.worklet.connect(s.context.destination);
    s.gain = s.context.createGain(); s.gain.gain.value = 0;
    s.source.connect(s.gain); s.gain.connect(s.context.destination);
    const destination = s.context.createMediaStreamDestination();
    s.source.connect(destination); s.recordStream = destination.stream;
    if (mode !== 'live') s.source.start();
    s.context.onstatechange = () => {
      if (session === s && s.ready && s.context.state !== 'running') halt('音声処理が一時停止したため、動作を停止しました。');
    };
    s.ready = true;
    $('monitor').disabled = false; $('calibrate').disabled = mode !== 'live';
    $('record').disabled = !window.MediaRecorder || recordingPending;
    $('logStart').disabled = false;
    $('connection').textContent = mode === 'live' ? 'LIVE INPUT' : mode === 'file' ? 'AUDIO FILE' : 'DEMO / 120 BPM';
    $('connection').classList.add('active');
    message('detail', `${s.device} · ${s.context.sampleRate} Hz · 解析：${$('channel').selectedOptions[0].textContent}`);
    if (!window.MediaRecorder) message('recordStatus', 'このブラウザは録音に対応していません。');
    resetPath();
  } catch (error) {
    if (session !== s) return;
    const messages = {NotAllowedError: '入力の使用を許可してください。', NotFoundError: '入力が見つかりません。G3のUSB接続を確認してください。', NotReadableError: '入力を開けません。ドライバーや他のアプリの使用状況を確認してください。', OverconstrainedError: '入力を選び直してください。'};
    stopAudio(messages[error.name] || `入力を開始できませんでした：${error.message}`);
  }
}
$('start').onclick = () => startAudio('live'); $('demo').onclick = () => startAudio('demo'); $('stop').onclick = () => stopAudio();
function isFresh(now = performance.now()) {
  return !!session?.ready && session.context.state === 'running' && !!feature && now - receivedAt < 250 && session.context.currentTime - feature.time < .25 && !document.hidden;
}
function halt(reason = '全停止しました。再開には「動作を再開」を押してください。') {
  paused = true; command = zero(); mapper.reset(); monitoring = false; updateMonitor();
  disarm(reason); $('resumeMotion').hidden = false; event('halt', {reason}); message('motionStatus', reason);
}
$('emergency').onclick = () => { comparisonUi?.cancel(false); halt(); finishRecording(); $('playback').pause(); };
window.addEventListener('keydown', e => { if (e.key === 'Escape') $('emergency').click(); });
$('resumeMotion').onclick = async () => {
  if (!configValid) { message('motionStatus', '無効な設定を修正してから再開してください。'); return; }
  if (!session?.ready) { message('motionStatus', '先に入力を開始してください。'); return; }
  const current = session;
  try {
    await current.context.resume();
    if (session !== current) return;
    paused = false; mapper.reset(); $('resumeMotion').hidden = true; event('resume');
  } catch { message('motionStatus', '音声処理を再開できません。入力を再接続してください。'); }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) halt('画面が非表示になったため停止しました。動作を再開できます。'); });
window.addEventListener('pagehide', () => { stopAudio(); });
$('channel').onchange = () => {
  disarm('解析チャンネル変更'); mapper.reset(); feature = null; updateSettings();
  event('channel_change', {channel: $('channel').value}); comparisonUi?.markSettingsChanged();
  if (session) message('detail', `${session.device} · ${session.context.sampleRate} Hz · 解析：${$('channel').selectedOptions[0].textContent}`);
};
function readConfig() {
  const next = {profile: $('profile').value, gateDb: +$('gateDb').value, fullDb: +$('fullDb').value, attackDb: +$('attackDb').value, smoothing: +$('smoothing').value, maxSpeed: +$('maxSpeed').value / 100, maxTurn: +$('maxTurn').value / 100};
  disarm('設定変更');
  const inputs = ['gateDb', 'fullDb', 'attackDb', 'smoothing'];
  const valid = validateConfig(next) && inputs.every(id => $(id).value !== '' && $(id).checkValidity());
  configValid = valid;
  inputs.forEach(id => $(id).setAttribute('aria-invalid', String(!valid)));
  if (!valid) { comparisonUi?.markSettingsChanged(); halt('設定が無効です。値を修正して動作を再開してください。'); message('configStatus', '強く弾いた音は無音判定より6 dB以上高く設定してください。各項目の範囲も確認してください。'); return; }
  config = next; mapper.reset(); updateSettings(); comparisonUi?.markSettingsChanged();
  $('maxSpeedValue').value = `${$('maxSpeed').value}%`; $('maxTurnValue').value = `${$('maxTurn').value}%`;
  message('ruleHelp', config.profile === 'volume' ? '音が大きいほど速く前進。無音では停止します。' : '強弱で速度、アタックごとに左右交互の旋回。安定した発音間隔で速度を補正します。');
  message('configStatus', '設定を反映しました。UDP送信は停止状態です。'); event('config_change', {config: {...config}});
}
for (const id of ['profile', 'gateDb', 'fullDb', 'attackDb', 'smoothing', 'maxSpeed', 'maxTurn']) $(id).addEventListener('input', readConfig);
$('calibrate').onclick = () => {
  if (!isFresh() || session.mode !== 'live') return;
  halt('無音を測定中です。ギターを弾かずに2秒待ってください。');
  calibration = {start: performance.now(), values: []}; $('calibrate').disabled = true;
  message('configStatus', '無音の測定中…'); event('calibration_start');
};
function finishCalibration() {
  const values = calibration.values.sort((a, b) => a - b); calibration = null;
  $('calibrate').disabled = !session?.ready || session.mode !== 'live';
  if (values.length < 10) { message('configStatus', '測定できませんでした。入力接続を確認してください。'); return; }
  const gate = Math.round(clamp(values[Math.floor(values.length * .95)] + 10, -90, -10));
  if (gate > config.fullDb - 6) { message('configStatus', '入力ノイズが大きすぎます。入力音量や配線を確認してください。'); return; }
  $('gateDb').value = gate; readConfig(); message('configStatus', `無音判定を ${gate} dBFSに設定しました。「動作を再開」で続行できます。`);
}
function renderFeatures() {
  const f = feature;
  $('level').textContent = f && f.db > -120 ? f.db.toFixed(1) : '−∞';
  $('bar').style.width = `${f ? clamp((f.db + 90) / 90 * 100, 0, 100) : 0}%`;
  $('bar').style.background = f?.clipped ? '#ff977f' : '#b5f578';
  document.querySelector('.meter').setAttribute('aria-valuenow', String(f ? clamp(f.db, -90, 0) : -90));
  $('intensity').innerHTML = `${Math.round(f ? clamp((f.db - config.gateDb) / (config.fullDb - config.gateDb), 0, 1) * 100 : 0)}<small> / 100</small>`;
  $('attacks').textContent = f?.onsetCount || 0;
  $('bpm').textContent = f?.bpm ? `${Math.round(f.bpm)} BPM` : '—';
  $('tempoStatus').textContent = f?.bpm ? `発音間隔の安定度 ${Math.round(f.tempoConfidence * 100)}%` : '4回以上の安定した発音で推定';
  $('centroid').textContent = f?.centroid ? `${Math.round(f.centroid)} Hz` : '—';
  if (session?.ready) message('status', !isFresh() ? '新しい音声を待っています。動作指令は停止します。' : f?.clipped ? '入力が上限付近です。G3の出力を下げてください。' : f.db <= config.gateDb ? '無音判定以下 · 動作指令は停止' : '信号を解析中 · 動きとの対応を確認できます');
  const canvas = $('wave'), pen = canvas.getContext('2d'); pen.clearRect(0, 0, canvas.width, canvas.height);
  if (f) { pen.strokeStyle = '#b5f578'; pen.lineWidth = 2; pen.beginPath(); f.wave.forEach((v, i) => { const x = i / (f.wave.length - 1) * canvas.width, y = canvas.height / 2 - v * canvas.height * .45; i ? pen.lineTo(x, y) : pen.moveTo(x, y); }); pen.stroke(); }
}
function resetPath() { position = {x: 450, y: 260, heading: -Math.PI / 2}; path = []; event('path_reset'); }
$('resetPath').onclick = resetPath;
function renderMotion(dt) {
  position.heading += command.turn * dt * 3;
  position.x = clamp(position.x + Math.cos(position.heading) * command.speed * dt * 240, 20, 880);
  position.y = clamp(position.y + Math.sin(position.heading) * command.speed * dt * 240, 20, 500);
  if (command.speed > .001 || Math.abs(command.turn) > .001) { path.push([position.x, position.y]); if (path.length > 3000) path.shift(); }
  const pen = $('arena').getContext('2d'); pen.clearRect(0, 0, 900, 520);
  pen.strokeStyle = '#78d7d080'; pen.lineWidth = 3; pen.beginPath(); path.forEach(([x, y], i) => i ? pen.lineTo(x, y) : pen.moveTo(x, y)); pen.stroke();
  pen.save(); pen.translate(position.x, position.y); pen.rotate(position.heading);
  pen.fillStyle = '#071018'; pen.fillRect(-16, -23, 30, 8); pen.fillRect(-16, 15, 30, 8);
  pen.fillStyle = paused ? '#ff977f' : '#b5f578'; pen.fillRect(-24, -15, 44, 30);
  pen.fillStyle = '#162622'; pen.beginPath(); pen.moveTo(13, 0); pen.lineTo(-2, -8); pen.lineTo(-2, 8); pen.closePath(); pen.fill(); pen.restore();
  $('speed').textContent = `${Math.round(command.speed * 100)}%`; $('turn').textContent = `${Math.round(command.turn * 100)}%`;
  $('wheels').textContent = `${Math.round(command.left * 100)} / ${Math.round(command.right * 100)}`;
  if (!paused) message('motionStatus', !session ? '入力待ち' : !isFresh() ? '音声更新待ち · 停止' : command.intensity === 0 ? '無音 · 停止' : '仮想走行中 · 画面端では位置を制限します');
}

$('record').onclick = () => {
  if (!session?.recordStream || recordingPending) return;
  try {
    const active = new MediaRecorder(session.recordStream); recorder = active; const chunks = [];
    active.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    active.onerror = () => { finishRecording(); message('recordStatus', '録音に失敗しました。入力を再接続してください。'); };
    active.onstop = () => {
      recordingPending = false;
      clearTimeout(recordingTimer);
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      const blob = new Blob(chunks, {type: active.mimeType}); recordingBlob = blob; $('useRecording').disabled = !blob.size; recordingUrl = URL.createObjectURL(blob);
      $('playback').src = recordingUrl; $('playback').hidden = false; $('download').href = recordingUrl;
      $('download').download = `guitar-${Date.now()}.${blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`;
      $('download').hidden = !blob.size; $('record').disabled = !session?.ready; $('recordStop').disabled = true;
      message('recordStatus', blob.size ? '録音できました。再生・保存できます。' : '録音データがありません。');
    };
    $('playback').pause(); active.start(); recordingPending = true; $('record').disabled = true; $('recordStop').disabled = false;
    message('recordStatus', '録音中（最大10秒）…'); recordingTimer = setTimeout(finishRecording, 10000);
  } catch (e) { message('recordStatus', `録音できませんでした：${e.message}`); }
};
$('recordStop').onclick = finishRecording;
$('useRecording').onclick = () => {
  if (recordingBlob?.size) { comparisonUi.loadBlob(recordingBlob, {name: 'アプリで録音した演奏', kind: 'recording'}); $('comparisonTitle').scrollIntoView({behavior: 'smooth'}); }
};

$('logStart').onclick = () => {
  if (!session?.ready) return;
  if (log?.rows.length && !log.saved && !window.confirm('未保存の実験記録があります。新しい記録に置き換えますか？')) return;
  logStarted = performance.now(); logging = true;
  log = {version: 1, appVersion: '0.3.0', startedAt: new Date().toISOString(), source: session.mode, fileSource: session.fileSource ?? null, device: session.device, sampleRate: session.context.sampleRate, frameSize: 2048, hopSize: 1024, browser: navigator.userAgent, note: $('experimentNote').value, initialConfig: {...config}, channel: $('channel').value, units: {db: 'dBFS RMS', centroid: 'Hz, spectral centroid', speed: 'normalized command, not measured speed', turn: 'normalized command', time: 'milliseconds since log start'}, rows: [], events: []};
  $('logStart').disabled = true; $('logStop').disabled = false; $('experimentNote').disabled = true;
  $('exportCsv').disabled = $('exportJson').disabled = true; message('logStatus', '実験記録中…'); event('log_start');
};
$('logStop').onclick = () => stopLog();
function appendLog(now, fresh) {
  if (!logging) return;
  const f = feature;
  log.rows.push({elapsed_ms: Math.round(now - logStarted), audio_time_s: f?.time ?? '', fresh: fresh ? 1 : 0, paused: paused ? 1 : 0, db: f?.db ?? '', rms: f?.rms ?? '', peak: f?.peak ?? '', clipped: f?.clipped ? 1 : 0, onset_count: f?.onsetCount ?? 0, bpm: f?.bpm ?? '', tempo_confidence: f?.tempoConfidence ?? 0, centroid_hz: f?.centroid ?? '', intensity: command.intensity, speed: command.speed, turn: command.turn, left: command.left, right: command.right, udp_armed: armed ? 1 : 0, last_ack_seq: txStatus?.last_ack_seq ?? '', ack_age_ms: txStatus?.ack_age_ms ?? '', channel: $('channel').value, ...config});
  message('logCount', `${log.rows.length} samples`);
  if (log.rows.length >= 12000) stopLog('記録上限（12,000件）に達しました。保存してから次の実験を開始してください。');
}
function saveFile(contents, extension, mime) {
  const url = URL.createObjectURL(new Blob([contents], {type: mime})), link = document.createElement('a');
  link.href = url; link.download = `guitar-experiment-${log.startedAt.replace(/[:.]/g, '-')}.${extension}`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('exportCsv').onclick = () => {
  if (!log?.rows.length) return;
  const fields = Object.keys(log.rows[0]);
  const escape = value => `"${String(value).replaceAll('"', '""')}"`;
  saveFile('\uFEFF' + [fields.join(','), ...log.rows.map(row => fields.map(field => escape(row[field])).join(','))].join('\r\n'), 'csv', 'text/csv;charset=utf-8');
  message('logStatus', 'CSVを保存しました。実験条件を残すためJSONも保存してください。');
};
$('exportJson').onclick = () => { if (log?.rows.length) { saveFile(JSON.stringify(log, null, 2), 'json', 'application/json'); log.saved = true; message('logStatus', '実験条件・全データをJSONに保存しました。'); } };
window.addEventListener('beforeunload', e => { if (log?.rows.length && !log.saved) { e.preventDefault(); e.returnValue = ''; } });

async function api(path, body, timeout = 700) {
  const response = await fetch(`/api/${path}`, {method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), cache: 'no-store'});
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
}
async function checkBridge() {
  try { bridge = await api('status'); message('bridgeStatus', bridge.target ? `接続先 ${bridge.target} · ${bridge.loopback ? 'PC内受信テスト' : '外部UDP受信機'}（到達確認は送信開始後）` : 'ローカルサーバー接続済み。UDP通信先は未設定です。'); }
  catch { message('bridgeStatus', '静的ページとして動作中。UDP通信には py server.py を使用します。'); }
}
function disarm(reason = '送信停止') {
  armGeneration++; arming = false;
  const old = armed; armed = null;
  if (old) { event('udp_stop', {reason}); api('stop', {token: old.token}).catch(() => {}); }
  $('disarm').disabled = true; message('transportStatus', `送信オフ · ${reason}`);
}
$('arm').onclick = async () => {
  if (!isFresh() || paused || !configValid || !bridge?.target || session.mode !== 'live' && !bridge.loopback) return;
  const generation = ++armGeneration; arming = true;
  try {
    const result = await api('arm', {source: session.mode});
    if (generation !== armGeneration || !isFresh() || paused) { api('stop', {token: result.token}).catch(() => {}); return; }
    armed = {token: result.token, seq: 0}; txStatus = null;
    $('disarm').disabled = false; event('udp_arm'); message('transportStatus', '送信開始 · 受信応答を待っています');
  } catch (e) { message('transportStatus', `送信できません：${e.message}`); }
  finally { arming = false; }
};
$('disarm').onclick = () => disarm();
async function transmit() {
  if (!armed || sending) return;
  const state = armed; sending = true;
  try {
    const status = await api('command', {token: state.token, seq: ++state.seq, speed: command.speed, turn: command.turn});
    if (armed !== state) return;
    txStatus = status;
    if (!status.active) { disarm(status.reason || '受信応答がありません'); return; }
    message('transportStatus', status.ack_age_ms === null ? '送信中 · 受信応答を待っています' : `受信応答あり · ${status.receiver_mode} · 応答 ${Math.round(status.ack_age_ms)} ms前（モーター動作の確認ではありません）`);
  } catch (e) { if (armed === state) disarm(`通信停止：${e.message}`); }
  finally { sending = false; }
}
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now(), dt = Math.min(.1, (now - lastTick) / 1000); lastTick = now;
  const fresh = isFresh(now);
  if (armed && (!fresh || paused)) disarm('音声更新の停止または動作停止');
  command = mapper.step(feature, config, now / 1000, fresh && !paused && configValid);
  if (calibration && now - calibration.start >= 2000) finishCalibration();
  renderFeatures(); renderMotion(dt); appendLog(now, fresh);
  $('arm').disabled = !!armed || arming || !fresh || paused || !configValid || !bridge?.target || session?.mode !== 'live' && !bridge.loopback;
  if (armed) transmit();
}, 50);
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => devices().catch(() => {}));
checkBridge();

comparisonUi = initComparison({
  getConfig: () => configValid ? {...config} : null,
  getChannel: () => $('channel').value,
  onPrepare: () => { stopAudio('ファイル読み込み・比較のため入力と送信を停止しました。'); $('playback').pause(); },
  onPlay: selection => { startAudio('file', selection); $('connection').scrollIntoView({behavior: 'smooth'}); }
});
