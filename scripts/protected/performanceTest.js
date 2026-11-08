const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const Web3 = require('web3');
const w = new Web3();
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts/backend/protected');
const baseline = JSON.parse(fs.readFileSync(path.join(output, 'baseline-location.json'))).directory;
const directories = { baseline: path.join(baseline, 'dist'), protected: path.join(output, 'build') };
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.USERPROFILE || process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const wallet = '0x' + '9'.repeat(40);
const seller = '0x' + '8'.repeat(40);
const zero = '0x' + '0'.repeat(40);
const auctions = Array.from({ length: 20 }, (_, i) => '0x' + (i + 100).toString(16).padStart(40, '0'));
const abi = [...require('../../src/real_ethereum/build/Campaign.json').abi, ...require('../../src/real_ethereum/build/CampaignFactory.json').abi];
const functions = new Map(abi.filter(a => a.type === 'function').map(a => [w.eth.abi.encodeFunctionSignature(a), a]));
const end = Math.floor(Date.now() / 1000) + 1200;
function rpc(request) {
  let result;
  switch (request.method) {
    case 'eth_accounts': case 'eth_requestAccounts': result = [wallet]; break;
    case 'eth_chainId': result = '0xaa36a7'; break;
    case 'net_version': result = '11155111'; break;
    case 'eth_blockNumber': result = '0x100'; break;
    case 'eth_getLogs': result = []; break;
    case 'eth_getBalance': result = '0x100000000000000000'; break;
    case 'eth_getCode': result = '0x01'; break;
    case 'eth_call': {
      const a = functions.get(request.params[0].data.slice(0, 10));
      if (!a) throw new Error('Unexpected fixture selector');
      const i = Math.max(0, auctions.indexOf(request.params[0].to.toLowerCase()));
      const description = `Benchmark auction ${String(i + 1).padStart(2, '0')}`;
      const values = a.name === 'getDeployedCampaigns' ? [auctions] :
        ['getBudget', 'globalBudget'].includes(a.name) ? ['2000'] :
        a.name === 'getListSummary' ? ['50', '0', '0', seller, '0', description, zero, String(end), false] :
        a.name === 'getSummary' ? ['50', '0', '0', seller, '0', '', description, zero, [], String(end)] :
        a.name === 'getUserAuctionStatus' ? [false, '0', false, false, false] :
        a.name === 'getAddresses' ? [[]] :
        a.outputs.map(o => o.type === 'bool' ? false : o.type === 'address' ? seller : o.type === 'string' ? '' : '0');
      result = w.eth.abi.encodeParameters(a.outputs.map(o => o.type), values);
      break;
    }
    default: throw new Error('Unexpected fixture RPC method');
  }
  return { jsonrpc: '2.0', id: request.id, result };
}
const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
async function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const [variant, ...parts] = url.pathname.slice(1).split('/');
    const directory = directories[variant];
    if (!directory) { res.writeHead(404); return res.end(); }
    let file = path.resolve(directory, parts.join('/') || 'index.html');
    if (!file.startsWith(directory + path.sep)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file)) file = path.join(directory, 'index.html');
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
    let content = fs.readFileSync(file);
    if (path.extname(file) === '.html') content = Buffer.from(content.toString().replaceAll('src="/assets/', `src="/${variant}/assets/`).replaceAll('href="/assets/', `href="/${variant}/assets/`));
    res.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = { generatedAt: new Date().toISOString(), baselineCommit: '222f22e', deterministicRPCFixtures: true, engines: [] };
  try {
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        const measurements = {};
        for (const variant of ['baseline', 'protected']) {
          const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
          const page = await context.newPage();
          let keyRequests = 0;
          await page.route('**/*', async route => {
            const req = route.request();
            const url = new URL(req.url());
            if (url.origin === base) {
              // Vite uses root-absolute modulepreloads and SPA routes.
              if (url.pathname.startsWith('/assets/')) return route.continue({ url: `${base}/${variant}${url.pathname}` });
              if (!url.pathname.startsWith(`/${variant}/`)) return route.continue({ url: `${base}/${variant}${url.pathname}` });
              return route.continue();
            }
            if (/execute-api/.test(url.hostname)) keyRequests++;
            let body;
            try { body = req.postDataJSON(); } catch (_) {}
            if (body?.method || Array.isArray(body)) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(rpc) : rpc(body)) });
            return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
          });
          await page.exposeFunction('fixtureRPC', request => rpc({ ...request, id: 1 }).result);
          await page.addInitScript(() => {
            sessionStorage.setItem('bc:motion-profile:v1', 'balanced');
            const provider = { isMetaMask: true, _metamask: { isUnlocked: async () => true }, request: args => window.fixtureRPC(args), on() {}, removeListener() {} };
            window.ethereum = provider;
            window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns: 'io.metamask', uuid: 'fixture' }, provider } })));
          });
          await page.goto(`${base}/${variant}/auctions-list`, { waitUntil: 'domcontentloaded' });
          // BrowserRouter reads the actual path, not the static serving prefix.
          await page.evaluate(() => { history.replaceState(null, '', '/auctions-list'); window.dispatchEvent(new PopStateEvent('popstate')); });
          await page.getByText('Benchmark auction 01', { exact: true }).waitFor({ timeout: 30000 });
          assert.equal(await page.locator('tbody tr').count(), 20);
          await page.waitForTimeout(2500);
          const search = page.getByPlaceholder(/Search auctions/);
          const samples = [];
          for (let i = 0; i < 21; i++) {
            const start = performance.now();
            await search.fill('Benchmark auction 01');
            await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
            if (i > 0) samples.push(performance.now() - start);
            await search.fill('');
            await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 20);
          }
          const frames = await page.evaluate(() => new Promise(resolve => {
            const deltas = []; let last = performance.now();
            const tick = now => { deltas.push(now - last); last = now; if (deltas.length < 100) requestAnimationFrame(tick); else resolve(deltas.slice(1)); };
            requestAnimationFrame(tick);
          }));
          const index = fs.readdirSync(path.join(directories[variant], 'assets')).find(name => /^index-.*\.js$/.test(name));
          measurements[variant] = { motionProfile: await page.evaluate(() => document.documentElement.dataset.motionProfile), searchSamplesMs: samples.map(Math.round), searchMedianMs: median(samples), frameP95Ms: [...frames].sort((a, b) => a - b)[Math.ceil(frames.length * .95) - 1], keyRequests, initialIndexGzipBytes: zlib.gzipSync(fs.readFileSync(path.join(directories[variant], 'assets', index))).length };
          assert.equal(keyRequests, 0, 'Ordinary trading does not call the encryption service');
          await context.close();
        }
        const change = (measurements.protected.searchMedianMs / measurements.baseline.searchMedianMs - 1) * 100;
        report.engines.push({ engine, ...measurements, searchRegressionPercent: change, withinTenPercent: change <= 10 });
      } finally { await browser.close(); }
    }
    fs.writeFileSync(path.join(output, 'performance-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(`Deterministic performance check failed: ${error.name}`); process.exitCode = 1; });
