// Renders promo.html frame by frame and encodes MP4.
// Usage: node render.js [out.mp4] [fps]   |   node render.js --stills t1,t2,...
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

(async () => {
  const args = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.goto('file://' + path.join(__dirname, 'promo.html') + '?render=1');
  await page.evaluate(() => document.fonts.ready);

  if (args[0] === '--stills') {
    for (const t of args[1].split(',').map(Number)) {
      await page.evaluate(t => render(t), t);
      await page.screenshot({ path: path.join(args[2] || '.', `still-${t}.png`) });
    }
    await browser.close();
    return;
  }

  const out = args[0] || 'ospori-promo.mp4';
  const fps = Number(args[1] || 30);
  const dur = await page.evaluate(() => DUR);
  const ff = spawn(FFMPEG, ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(dur * fps);
  for (let f = 0; f < total; f++) {
    await page.evaluate(t => render(t), f / fps);
    ff.stdin.write(await page.screenshot({ type: 'png' }));
    if (f % 60 === 0) process.stderr.write(`frame ${f}/${total}\n`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  await browser.close();
})();
