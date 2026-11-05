// Optional end-to-end test. Install Playwright and Chromium; see README.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PYTHON_COMMAND || 'python3';
const receiver = spawn(python, ['robot_simulator.py', '--port', '19000'], {cwd: root});
const server = spawn(python, ['server.py', '--port', '18765', '--robot-host', '127.0.0.1', '--robot-port', '19000'], {cwd: root});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timed out')), 10000);
    server.stdout.on('data', chunk => { if (chunk.toString().includes('Guitar Motion Lab:')) { clearTimeout(timer); resolve(); } });
    server.on('error', reject); server.on('exit', code => { if (code) reject(new Error(`server exit ${code}`)); });
  });
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}, acceptDownloads: true});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(options) { super(options); window.testContext = this; window.testLatencyHint = options.latencyHint; }
      createGain() { const gain = super.createGain(); window.testGain = gain; return gain; }
    };
  });
  await page.goto('http://127.0.0.1:18765');
  assert(await page.evaluate(() => [...document.querySelectorAll('input')].every(input => input.checkValidity())));
  await page.click('#demo');
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('DEMO'));
  await page.waitForFunction(() => Number(document.querySelector('#attacks').textContent) >= 5);
  assert.match(await page.textContent('#bpm'), /\d+ BPM/);
  assert.equal(await page.textContent('#turn'), '0%');
  assert.equal(await page.evaluate(() => window.testLatencyHint), 'interactive');
  assert.equal(await page.evaluate(() => window.testGain.gain.value), 0);
  await page.click('#monitor'); await page.waitForTimeout(100);
  assert(Math.abs(await page.evaluate(() => window.testGain.gain.value) - .2) < .01);
  await page.locator('#volume').fill('35'); await page.locator('#volume').dispatchEvent('input');
  await page.waitForTimeout(100); assert(Math.abs(await page.evaluate(() => window.testGain.gain.value) - .35) < .01);
  const outputRms = await page.evaluate(async () => {
    const analyser = window.testContext.createAnalyser(); window.testGain.connect(analyser);
    const data = new Float32Array(analyser.fftSize); let maximum = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 20)); analyser.getFloatTimeDomainData(data);
      maximum = Math.max(maximum, Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length));
    }
    window.testGain.disconnect(analyser); return maximum;
  });
  assert(outputRms > .005, 'audible signal must reach the monitoring output');
  await page.locator('#experimentNote').fill('ルール比較テスト / 合成120 BPM');
  await page.click('#logStart'); await page.waitForTimeout(800);
  await page.selectOption('#profile', 'expression');
  await page.waitForFunction(() => document.querySelector('#turn').textContent !== '0%');
  await page.waitForTimeout(500);
  await page.locator('.simulation summary').click();
  await page.click('#arm');
  await page.waitForFunction(() => document.querySelector('#transportStatus').textContent.includes('SIM'));
  const state = await page.evaluate(async () => (await fetch('/api/status')).json());
  assert(state.active); assert.equal(state.receiver_mode, 'SIM');
  await page.click('#record'); await page.waitForTimeout(1200); await page.click('#recordStop');
  await page.waitForFunction(() => !document.querySelector('#playback').hidden);
  assert(await page.evaluate(async () => (await (await fetch(document.querySelector('#playback').src)).blob()).size > 0));
  await page.evaluate(() => document.querySelector('#playback').play());
  await page.waitForFunction(() => document.querySelector('#monitor').getAttribute('aria-pressed') === 'false');
  await page.click('#logStop');
  const csvDownload = page.waitForEvent('download'); await page.click('#exportCsv');
  const csv = await readFile(await (await csvDownload).path(), 'utf8');
  assert(csv.includes('centroid_hz')); assert(csv.includes('"volume"')); assert(csv.includes('"expression"'));
  const jsonDownload = page.waitForEvent('download'); await page.click('#exportJson');
  const json = JSON.parse(await readFile(await (await jsonDownload).path(), 'utf8'));
  assert(json.rows.length > 20); assert.equal(json.source, 'demo'); assert.equal(json.sampleRate, await page.evaluate(() => window.testContext.sampleRate));
  assert(json.events.some(e => e.type === 'config_change')); assert(json.events.some(e => e.type === 'udp_arm'));
  assert(json.rows.some(row => row.speed > 0)); assert(json.rows.some(row => row.turn !== 0));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#speed').textContent === '0%');
  assert.equal(await page.getAttribute('#monitor', 'aria-pressed'), 'false');
  await page.waitForTimeout(150); assert(!(await page.evaluate(async () => (await fetch('/api/status')).json())).active);
  await page.click('#resumeMotion');
  await page.locator('#fullDb').fill('-60'); await page.locator('#fullDb').dispatchEvent('input');
  await page.click('#resumeMotion'); await page.waitForTimeout(150); assert.equal(await page.textContent('#speed'), '0%');
  await page.locator('#fullDb').fill('-15'); await page.locator('#fullDb').dispatchEvent('input'); await page.click('#resumeMotion');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#speed').textContent === '0%');
  await page.evaluate(() => { delete document.hidden; }); await page.click('#resumeMotion');
  await page.locator('.simulation summary').click();
  await page.mouse.move(0, 0); await page.screenshot({path: join(tmpdir(), 'guitar-motion-desktop.png'), fullPage: true});
  await page.evaluate(() => window.testContext.suspend());
  await page.waitForFunction(() => document.querySelector('#speed').textContent === '0%');
  assert(await page.locator('#resumeMotion').isVisible());
  await page.click('#resumeMotion');
  await page.click('#stop'); await page.waitForFunction(() => window.testContext.state === 'closed');
  await page.click('#start'); await page.waitForFunction(() => document.querySelector('#connection').textContent === 'LIVE INPUT');
  await page.selectOption('#channel', 'right');
  await page.click('#stop');
  await page.setViewportSize({width: 390, height: 844});
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: join(tmpdir(), 'guitar-motion-mobile.png'), fullPage: true});
  assert.deepEqual(errors, []);
  console.log(`PASS: demo DSP/BPM, two mappings, monitor/gain, UDP ACK, recording/playback, ${json.rows.length} experiment rows + metadata export, emergency stop, invalid config, hidden-page stop, live capture lifecycle, mobile layout, no JS errors`);
} finally {
  await browser?.close(); server.kill(); receiver.kill();
}
