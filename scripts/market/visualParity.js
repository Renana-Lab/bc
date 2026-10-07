const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));

(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ mode: 'development', server: { port: 0, host: '127.0.0.1', open: false } });
  const browser = await chromium.launch();
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    fs.mkdirSync('artifacts/backend', { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const read = async (url, name) => {
      const page = await context.newPage();
      await page.route('**/*', route => {
        const requested = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(requested.hostname) ? route.continue() : route.abort();
      });
      await page.goto(url);
      await page.getByRole('heading', { name: 'Welcome to our data marketplace', exact: true }).waitFor({ timeout: 60000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `artifacts/backend/${name}.png`, fullPage: true });
      const geometry = await page.getByRole('heading', { name: 'Welcome to our data marketplace', exact: true }).evaluate(el => {
        const box = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { x: box.x, y: box.y, width: box.width, height: box.height, font: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, color: style.color };
      });
      await page.close();
      return geometry;
    };
    const original = await read(origin, 'original-welcome');
    const backend = await read('http://localhost:3010', 'backend-welcome');
    console.log(JSON.stringify({ original, backend }, null, 2));
    for (const key of ['font', 'size', 'lineHeight', 'color']) assert.equal(backend[key], original[key], key);
    for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(backend[key] - original[key]) < 2, `${key}: original ${original[key]}, backend ${backend[key]}`);
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
