import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'node:fs';

const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true, protocolTimeout: 120000 });
const watchdog = setTimeout(() => { console.error('Browser smoke test exceeded 135 seconds; terminating browser.'); browser.process()?.kill('SIGKILL'); }, 135000);
const page = await browser.newPage();
const errors = [], requests = [];
await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.on('console', msg => { console.log(msg.type(), msg.text()); if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
page.on('request', request => { requests.push(request.url()); });
page.on('response', response => { if (response.status() >= 400) console.error('HTTP ERROR', response.status(), response.url()); });
try {
  await page.goto(process.env.PLAYER_URL || 'http://127.0.0.1:8000/silksong/', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: '.arena/player-start.png' });
  const before = requests.filter(url => url.includes('.part')).length;
  if (before) throw new Error('Archive fetched before Start');
  await page.click('#start-button');
  await page.waitForFunction(() => window.silksongInstance || !document.getElementById('warning').hidden, { timeout: 150000 });
  await page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), Number(process.env.SMOKE_OBSERVE_MS || 60000));
  if (process.env.SMOKE_INPUT === '1') {
    for (let i = 0; i < 2; i++) {
      await page.click('[data-key="Enter"]', { delay: 100 });
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 8000)));
    }
  }
  const state = await page.evaluate(() => ({
    heap: window.silksongInstance?.Module?.HEAPU8?.byteLength,
    warning: document.getElementById('warning').hidden ? '' : document.getElementById('warning').textContent,
    canvas: [document.getElementById('unity-canvas').width, document.getElementById('unity-canvas').height],
  }));
  await page.screenshot({ path: '.arena/player-running.png' });
  fs.writeFileSync('.arena/browser-smoke.json', JSON.stringify({ state, errors, requests }, null, 2));
  console.log('RESULT', JSON.stringify(state), 'Requests:', requests.length);
  if (state.warning || errors.length) process.exitCode = 1;
} finally { clearTimeout(watchdog); await browser.close().catch(() => {}); }
