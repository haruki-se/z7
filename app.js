'use strict';
const $ = id => document.getElementById(id);
let stream, context, analyser, frame, recorder, timer, recordingUrl, monitorGain;
let monitoring = false;
const supported = !!navigator.mediaDevices?.getUserMedia;
$('start').disabled = !supported;
if (!supported) $('status').textContent = 'このブラウザでは入力を利用できません。localhost または HTTPS で開いてください。';
async function devices() {
  const list = await navigator.mediaDevices.enumerateDevices();
  const selected = $('device').value;
  $('device').replaceChildren(new Option('既定の入力', ''));
  list.filter(d => d.kind === 'audioinput').forEach((d, i) => $('device').add(new Option(d.label || `入力 ${i + 1}`, d.deviceId)));
  if ([...$('device').options].some(o => o.value === selected)) $('device').value = selected;
}
function setOutputStatus(message) {
  $('outputStatus').textContent = message;
}
function updateMonitor() {
  monitorGain?.gain.setTargetAtTime(monitoring ? Number($('volume').value) / 100 : 0, context.currentTime, 0.015);
  $('monitor').setAttribute('aria-pressed', String(monitoring));
  $('monitor').textContent = monitoring ? 'スピーカー出力をオフ' : 'スピーカー出力をオン';
  setOutputStatus(monitoring ? '出力オン · OSの既定のスピーカーへ再生中' : '出力オフ');
}
$('monitor').onclick = async () => {
  if (!context) return;
  const activeContext = context;
  try {
    await activeContext.resume();
    if (context !== activeContext) return;
    monitoring = !monitoring;
    if (monitoring) $('playback').pause();
    updateMonitor();
  } catch { setOutputStatus('出力を開始できません。入力を再接続してください。'); }
};
$('volume').oninput = () => {
  $('volumeValue').textContent = `${$('volume').value}%`;
  updateMonitor();
};
$('playback').onplay = () => { monitoring = false; updateMonitor(); };
function finishRecording() {
  clearTimeout(timer);
  if (recorder?.state === 'recording') recorder.stop();
  $('recordStop').disabled = true;
}
function stop() {
  monitoring = false;
  updateMonitor();
  $('monitor').disabled = true;
  $('connection').textContent = 'STOPPED';
  $('connection').classList.remove('active');
  finishRecording();
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach(t => t.stop());
  context?.close();
  stream = context = analyser = monitorGain = null;
  $('start').disabled = !supported;
  $('stop').disabled = $('record').disabled = true;
  $('device').disabled = false;
  $('level').textContent = '−∞'; $('bar').style.width = '0%';
  document.querySelector('.meter').setAttribute('aria-valuenow', '-60');
  $('status').textContent = '入力は停止中です。';
  $('detail').textContent = '入力デバイスは接続していません。';
  const c = $('wave'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
}
$('start').onclick = async () => {
  $('start').disabled = true;
  $('status').textContent = '入力の許可・接続を待っています…';
  try {
    const deviceId = $('device').value;
    stream = await navigator.mediaDevices.getUserMedia({audio: {deviceId: deviceId ? {exact: deviceId} : undefined, echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
    context = new AudioContext({latencyHint: 'interactive'});
    await context.resume();
    analyser = context.createAnalyser(); analyser.fftSize = 2048;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    monitorGain = context.createGain();
    monitorGain.gain.value = 0;
    source.connect(monitorGain);
    monitorGain.connect(context.destination);
    await devices();
    const track = stream.getAudioTracks()[0];
    track.onended = () => { stop(); $('status').textContent = '入力デバイスとの接続が切れました。'; };
    const settings = track.getSettings();
    if (settings.deviceId) $('device').value = settings.deviceId;
    $('detail').textContent = `${track.label} · ${settings.sampleRate || context.sampleRate} Hz · ${settings.channelCount || '不明'} ch`;
    $('device').disabled = true; $('stop').disabled = false;
    $('record').disabled = !window.MediaRecorder || !!recorder && recorder.state !== 'inactive';
    $('monitor').disabled = false;
    $('connection').textContent = 'CONNECTED';
    $('connection').classList.add('active');
    if (!window.MediaRecorder) $('recordStatus').textContent = 'このブラウザでは録音を利用できません。';
    const samples = new Float32Array(analyser.fftSize);
    const canvas = $('wave'), pen = canvas.getContext('2d'); canvas.width = 1000; canvas.height = 200;
    function draw() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0, peak = 0;
      for (const v of samples) {sum += v*v; peak = Math.max(peak, Math.abs(v));}
      const db = 20*Math.log10(Math.sqrt(sum/samples.length));
      $('level').textContent = Number.isFinite(db) ? db.toFixed(1) : '−∞';
      $('bar').style.width = `${Math.max(0, Math.min(100, (db+60)/60*100))}%`;
      $('bar').style.background = peak >= .98 ? '#ff977f' : '#95efab';
      document.querySelector('.meter').setAttribute('aria-valuenow', String(Math.max(-60, Math.min(0, Number.isFinite(db) ? db : -60))));
      const signalStatus = peak >= .98 ? 'ピークが上限付近です。G3の出力を下げてください。' : db > -55 ? '音声信号を検出しています。' : '入力を接続中。ギターを弾いて信号を確認してください。';
      if ($('status').textContent !== signalStatus) $('status').textContent = signalStatus;
      pen.clearRect(0,0,1000,200); pen.strokeStyle='#95efab'; pen.lineWidth=2; pen.beginPath();
      samples.forEach((v,i) => {const x=i/(samples.length-1)*1000,y=100-v*95; i ? pen.lineTo(x,y) : pen.moveTo(x,y);}); pen.stroke();
      frame = requestAnimationFrame(draw);
    }
    draw();
  } catch (e) {
    stop();
    const errors = {NotAllowedError:'マイクの使用が許可されていません。ブラウザの権限設定を確認してください。',NotFoundError:'音声入力が見つかりません。G3のUSB接続を確認してください。',NotReadableError:'入力を開けません。他のアプリの使用状況やドライバーを確認してください。',OverconstrainedError:'選択した入力が利用できません。デバイスを選び直してください。'};
    $('status').textContent = errors[e.name] || `入力を開始できませんでした: ${e.message}`;
  }
};
$('stop').onclick = stop;
$('record').onclick = () => {
  if (!stream || recorder?.state === 'recording') return;
  try {
    const activeRecorder = new MediaRecorder(stream);
    recorder = activeRecorder;
    const chunks = [];
    recorder.ondataavailable = e => {if(e.data.size) chunks.push(e.data);};
    recorder.onstop = () => {
      clearTimeout(timer);
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      const blob = new Blob(chunks, {type: activeRecorder.mimeType});
      recordingUrl = URL.createObjectURL(blob);
      $('playback').src = recordingUrl; $('playback').hidden = false;
      $('download').href = recordingUrl;
      $('download').download = `g3-input.${blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`;
      $('download').hidden = false;
      $('record').textContent = '10秒録音'; $('record').disabled = !stream;
      $('recordStop').disabled = true;
      $('recordStatus').textContent = '録音できました。再生して確認できます。';
    };
    $('playback').pause();
    $('recordStatus').textContent = '録音中（最大10秒）…';
    recorder.start(); $('record').textContent = '録音中…'; $('record').disabled = true; $('recordStop').disabled = false;
    timer = setTimeout(finishRecording, 10000);
  } catch(e) { $('recordStatus').textContent = `録音できませんでした: ${e.message}`; }
};
$('recordStop').onclick = finishRecording;
if (supported) navigator.mediaDevices.addEventListener('devicechange', () => devices().catch(() => {}));
window.addEventListener('pagehide', stop);
