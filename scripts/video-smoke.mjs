import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(process.env.PLAYER_URL || 'http://127.0.0.1:8000/silksong/');
  for (const name of ['placeholder.mp4', 'Intro_Cinematic.webm', 'Lace_Battle.webm', 'Ending_E.webm']) {
    const result = await page.evaluate(name => new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const timer = setTimeout(() => { video.remove(); reject(new Error('Video timeout: ' + name)); }, 10000);
      video.muted = true; video.playsInline = true;
      video.onended = () => {
        clearTimeout(timer);
        resolve({ name, duration: video.duration, width: video.videoWidth, height: video.videoHeight });
        video.src = ''; video.remove();
      };
      video.onerror = () => { clearTimeout(timer); reject(new Error(`Video error ${video.error?.code}: ${name}`)); video.remove(); };
      document.body.append(video);
      video.src = new URL('StreamingAssets/VideoClip/' + name, document.baseURI);
      video.play().catch(reject);
    }), name);
    if (Math.abs(result.duration - 1) > 0.1 || result.width !== 160 || result.height !== 90) throw new Error('Invalid placeholder dimensions or duration');
    console.log('Ended normally:', result);
  }
} finally { await browser.close(); }
