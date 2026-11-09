const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts/backend/protected/browser');
const factory = `0x${'1'.repeat(40)}`;
const wallet = `0x${'2'.repeat(40)}`;

function playwrightRuntime() {
  try { return require('playwright'); }
  catch (_) {
    return require(path.join(process.env.USERPROFILE || process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  }
}
const contentType = file => ({ '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const cryptoModule = await import(pathToFileURL(path.join(root, 'src/protected/crypto.mjs')).href);
  const kms = await cryptoModule.generateDeliveryKey();
  const publicKey = await cryptoModule.exportPublicKey(kms.publicKey);
  const uploads = new Map();
  const fixture = { calls: [], failComplete: false, latest: null, delayComplete: 0 };
  let base;
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, base);
      if (url.pathname.startsWith('/fixture/')) {
        let raw = ''; for await (const part of req) raw += part;
        const body = raw ? JSON.parse(raw) : {};
        fixture.calls.push({ method: req.method, path: url.pathname, body });
        const route = url.pathname.slice('/fixture'.length);
        if (route === '/config') return json(200, { chainId: 11155111, factory, publicKey });
        if (route === '/challenge') return json(200, { challengeId: 'fixture-challenge', typedData: { fixture: true } });
        if (route === '/session') return json(200, { token: 'explicitly-mocked-session', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
        if (route === '/uploads') {
          const id = `0x${String(uploads.size + 1).padStart(64, '0')}`;
          const record = { ...body, id }; uploads.set(id, record); fixture.latest = record;
          return json(200, { id, uploadUrl: `${base}/fixture/object/${id}` });
        }
        if (route.startsWith('/object/')) {
          const record = uploads.get(route.split('/')[2]);
          if (req.method === 'PUT') { record.envelope = body; return json(200, { ok: true }); }
          return json(200, record.envelope);
        }
        if (route.endsWith('/complete')) {
          if (fixture.delayComplete) await new Promise(resolve => setTimeout(resolve, fixture.delayComplete));
          if (fixture.failComplete) { fixture.failComplete = false; return json(503, { message: 'Explicit fixture retry' }); }
          const record = uploads.get(route.split('/')[2]);
          return json(200, { ready: true, ciphertextHash: record.ciphertextHash });
        }
        if (route === '/release') {
          const record = fixture.latest;
          const sessionPublic = fixture.calls.filter(call => call.path === '/fixture/challenge').at(-1).body.publicKey;
          if (!req.headers.authorization && body.publicKey !== sessionPublic) return json(409, { error: 'delivery_key_recovery_required' });
          const rawKey = await cryptoModule.unwrapKey(record.wrappedKey, kms.privateKey);
          try { return json(200, { id: record.id, ciphertextHash: record.ciphertextHash,
            wrappedKey: await cryptoModule.wrapKey(rawKey, sessionPublic), downloadUrl: `${base}/fixture/object/${record.id}` }); }
          finally { rawKey.fill(0); }
        }
        return json(404, { message: 'Unknown fixture route' });
      }
      if (url.pathname === '/harness.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><title>Protected client test harness</title><h1>Explicitly mocked service; real browser crypto</h1><script type="module" src="/harness/harness.js"></script>');
      }
      const directory = url.pathname.startsWith('/harness/') ? path.join(output, 'harness') : path.join(output, 'production');
      const relative = url.pathname.startsWith('/harness/') ? url.pathname.slice('/harness/'.length) : url.pathname.slice(1);
      let file = path.resolve(directory, relative || 'index.html');
      if (!file.startsWith(`${directory}${path.sep}`)) return json(403, {});
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(directory, 'index.html');
      res.writeHead(200, { 'Content-Type': contentType(file) }); res.end(fs.readFileSync(file));
    } catch (error) { json(500, { message: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const environment = { NODE_ENV: 'production', PUBLIC_URL: '', REACT_APP_PROTECTED_MARKET: 'true',
    REACT_APP_FACTORY_ADDRESS: factory, REACT_APP_PROTECTED_API_URL: `${base}/fixture`, REACT_APP_MARKET_ENV: 'testing' };
  const { build } = await import('vite');
  const report = { fixtureOnly: true, liveAWS: false, generatedAt: new Date().toISOString(), engines: [] };
  try {
    const beforeBuild = performance.now();
    await build({ root, configFile: path.join(root, 'vite.config.mjs'), mode: 'protected-browser-test',
      define: { 'process.env': JSON.stringify(environment) }, logLevel: 'warn',
      build: { outDir: path.join(output, 'production'), emptyOutDir: true } });
    report.productionBuildMs = Math.round(performance.now() - beforeBuild);
    const mock = `
      const listeners = new Set();
      let state = {status:'connected', account:'${wallet}'};
      export const getWalletAccess = () => state;
      export const requireWalletAccess = async () => {if(state.status !== 'connected') throw Error('Wallet revoked'); return state};
      export const subscribeWalletAccess = fn => {listeners.add(fn); return () => listeners.delete(fn)};
      export const getActiveFactoryAddress = () => '${factory}';
      const provider = {request:async ({method}) => {
        if(method==='eth_chainId') return '0xaa36a7';
        if(method==='eth_signTypedData_v4'){window.signatures=(window.signatures||0)+1; return 'fixture-signature-not-real'};
        throw Error('Unexpected wallet request '+method);
      }};
      export const getEthereumProvider = () => provider;
      window.fixtureWallet = connected => { state={status:connected?'connected':'locked',account:connected?'${wallet}':''}; listeners.forEach(fn=>fn()) };
    `;
    const entry = `import * as client from '${root.replaceAll('\\', '/')}/src/protected/client.js';
      import {getDeliveryKey} from '${root.replaceAll('\\', '/')}/src/protected/keys.js';
      window.harness={...client,getDeliveryKey,wallet:'${wallet}'}; window.fixtureWallet(true);`;
    await build({ root, base: '/harness/', configFile: false, define: { 'process.env': JSON.stringify(environment) }, logLevel: 'warn',
      plugins: [{ name: 'explicit-protected-fixture', enforce: 'pre', resolveId(source, importer) {
        if (source === 'protected-fixture-entry') return '\0entry';
        if (source === '\0fixture-wallet') return source;
        if (importer?.replaceAll('\\', '/').endsWith('/src/protected/client.js') &&
          /(?:ethereumProvider|walletAccess|marketConfig)$/.test(source)) return '\0fixture-wallet';
      }, load(id) { if (id === '\0entry') return entry; if (id === '\0fixture-wallet') return mock; } }],
      build: { outDir: path.join(output, 'harness'), emptyOutDir: true,
        rollupOptions: { input: 'protected-fixture-entry', output: { entryFileNames: 'harness.js' } } } });
    const playwright = playwrightRuntime();
    const engines = process.argv.includes('--chromium-only') ? ['chromium'] : ['chromium', 'webkit'];
    for (const name of engines) {
      const browser = await playwright[name].launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        const engine = { name, checks: [], metrics: {}, errors };
        report.engines.push(engine);
        const fixtureCallsBeforeWelcome = fixture.calls.length;
        const started = performance.now();
        await page.goto(base, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: /continue/i }).waitFor({ state: 'visible', timeout: 15000 });
        engine.metrics.welcomeLoadMs = Math.round(performance.now() - started);
        assert.ok((await page.locator('body').innerText()).length > 60, 'Production welcome is not blank');
        assert.ok(await page.getByRole('button', { name: /continue/i }).count(), 'Expected welcome action');
        assert.equal(await page.getByText(/Budget:/).count(), 0, 'Budget is hidden before wallet access');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal overflow');
        assert.equal(fixture.calls.length, fixtureCallsBeforeWelcome, 'Welcome does not call protected service');
        engine.metrics.startup = await page.evaluate(() => ({
          domContentLoadedMs: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
          jsTransferBytes: performance.getEntriesByType('resource').filter(item => /\.js/.test(item.name)).reduce((sum, item) => sum + item.transferSize, 0),
          workerChunksAtStartup: performance.getEntriesByType('resource').filter(item => /worker-/.test(item.name)).length,
        }));
        assert.equal(engine.metrics.startup.workerChunksAtStartup, 0);
        await page.screenshot({ path: path.join(output, `${name}-welcome.png`), animations: 'disabled' });
        const clicked = performance.now();
        await page.getByRole('button', { name: /continue/i }).click();
        engine.metrics.continueActionMs = Math.round(performance.now() - clicked);
        engine.checks.push('Nonblank protected production welcome; no crypto worker at startup');
        await page.goto(`${base}/harness.html`);
        await page.waitForFunction(() => !!window.harness);
        const key = await page.evaluate(async () => {
          const fingerprint = await harness.getBidKeyFingerprint(harness.wallet, 11155111);
          const stored = await harness.getDeliveryKey(harness.wallet, 11155111, () => { throw Error('Should be cached'); });
          let exportDenied = false;
          try { await crypto.subtle.exportKey('pkcs8', stored.privateKey); } catch (_) { exportDenied = true; }
          return { fingerprint, extractable: stored.privateKey.extractable, exportDenied };
        });
        assert.equal(key.extractable, false); assert.equal(key.exportDenied, true);
        await page.reload(); await page.waitForFunction(() => !!window.harness);
        assert.equal(await page.evaluate(() => harness.getBidKeyFingerprint(harness.wallet, 11155111)), key.fingerprint);
        engine.checks.push('Real worker RSA key; nonextractable IndexedDB key survives reload');
        fixture.failComplete = true;
        const uploadsBeforeRetry = uploads.size;
        const retryResult = await page.evaluate(async () => {
          const options = { wallet: harness.wallet, text: 'Browser-private-marker-7391', operationId: 'retry-operation' };
          let failed = false;
          try { await harness.prepareProtectedAuction(options); } catch (_) { failed = true; }
          const result = await harness.prepareProtectedAuction(options);
          const cached = await harness.prepareProtectedAuction(options);
          return { failed, result, cached, signatures: window.signatures };
        });
        assert.equal(retryResult.failed, true); assert.equal(retryResult.signatures, 1);
        assert.deepEqual(retryResult.result, retryResult.cached);
        engine.observations = { uploadRecordsForFailedCompletionAndRetry: uploads.size - uploadsBeforeRetry,
          note: uploads.size - uploadsBeforeRetry > 1 ? 'Retry creates another encrypted upload; success cache is reused afterward.' : 'Retry reuses its encrypted upload.' };
        engine.checks.push('503 retry and cached preparation do not repeat wallet signature');
        const other = await page.evaluate(() => harness.prepareProtectedAuction({ wallet: harness.wallet,
          text: 'Browser-private-marker-7391', operationId: 'separate-operation' }));
        assert.notEqual(other.nonce, retryResult.result.nonce);
        assert.notEqual(other.ciphertextHash, retryResult.result.ciphertextHash);
        assert.equal(JSON.stringify(fixture.latest.envelope).includes('Browser-private-marker'), false);
        const decrypted = await page.evaluate(({ expectedHash, expectedPayloadId }) => harness.decryptProtectedAuction({
          wallet: harness.wallet, address: `0x${'3'.repeat(40)}`, expectedHash, expectedPayloadId,
        }), { expectedHash: other.ciphertextHash, expectedPayloadId: other.payloadId });
        assert.equal(decrypted, 'Browser-private-marker-7391');
        assert.equal(await page.evaluate(() => window.signatures), 1);
        assert.equal(fixture.calls.filter(call => call.path === '/fixture/release').at(-1).body.publicKey !== undefined, true);
        engine.checks.push('Unique nonces and real worker AES/RSA roundtrip with transaction-bound reveal');
        fixture.delayComplete = 200;
        const revoked = await page.evaluate(async () => {
          let notifications = 0;
          const unsubscribe = harness.subscribeProtectedRevocation(() => notifications++);
          const operation = harness.prepareProtectedAuction({ wallet: harness.wallet, text: 'Revocation marker', operationId: 'revoke',
            onProgress: value => { if (value === 'Uploading encrypted data') setTimeout(() => window.fixtureWallet(false), 10); } });
          let rejected = false;
          try { await operation; } catch (_) { rejected = true; }
          unsubscribe(); return { rejected, notifications };
        });
        fixture.delayComplete = 0;
        assert.equal(revoked.rejected, true); assert.equal(revoked.notifications, 1);
        await page.evaluate(() => window.fixtureWallet(true));
        await page.evaluate(() => harness.prepareProtectedAuction({ wallet: harness.wallet,
          text: 'Reauthenticated after revoke', operationId: 'after-revoke' }));
        assert.equal(await page.evaluate(() => window.signatures), 2, 'Revocation removed old in-memory session');
        engine.checks.push('Wallet revoke rejects pending result and emits plaintext-clearing notification');
        assert.deepEqual(errors, []);
        await context.close();
      } finally { await browser.close(); }
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.failure = error.stack; throw error; }
  finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
