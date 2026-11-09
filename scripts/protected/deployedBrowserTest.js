const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Web3 = require('web3');
const { Wallet } = require('ethers');
const { signTypedData, SignTypedDataVersion } = require('@metamask/eth-sig-util');
require('dotenv').config({ quiet: true });
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts/backend/protected');
const site = 'https://main.d1n93p6nqw0kho.amplifyapp.com';
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.USERPROFILE || process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
let stage = 'starting';

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(output, 'live-smoke-private.json')));
  const signer = new Wallet(state.winnerPrivateKey);
  const web3 = new Web3(process.env.PROTECTED_RPC_URL || process.env.RPC_URL);
  const { sha256 } = await import('../../src/protected/crypto.mjs');
  const report = { generatedAt: new Date().toISOString(), url: site, realAWS: true, realSepolia: true,
    walletAdapter: 'Automated EIP-6963 adapter with MetaMask eth-sig-util V4, NOT a real extension', engines: [] };
  for (const engine of ['chromium', 'webkit']) {
    stage = `${engine}:launch`;
    const browser = await playwright[engine].launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', () => errors.push('Page JavaScript error'));
      stage = `${engine}:unauthorized-direct-link`;
      await page.goto(`${site}/auction/${state.auction}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      assert.equal(await page.getByText('Protected verification dataset', { exact: true }).count(), 0, 'No protected content mounts without a wallet');
      assert.equal(await page.getByText(/Budget:/).count(), 0);
      await page.exposeFunction('automatedWalletRequest', async ({ method, params = [] }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [signer.address];
        if (method === 'eth_chainId') return '0xaa36a7';
        if (method === 'eth_signTypedData_v4') {
          assert.equal(params[0].toLowerCase(), signer.address.toLowerCase());
          const data = JSON.parse(params[1]);
          return signTypedData({ privateKey: Buffer.from(signer.privateKey.slice(2), 'hex'), data, version: SignTypedDataVersion.V4 });
        }
        if (!['eth_call', 'eth_blockNumber', 'eth_getBalance', 'eth_getBlockByNumber', 'net_version'].includes(method)) throw new Error('Unsupported read-only automated wallet method');
        return new Promise((resolve, reject) => web3.currentProvider.send({ jsonrpc: '2.0', id: Date.now(), method, params }, (error, result) => error || result.error ? reject(new Error('Read RPC failed')) : resolve(result.result)));
      });
      await page.addInitScript(() => {
        const listeners = new Map();
        window.automatedWalletUnlocked = true;
        const provider = {
          isMetaMask: true, _metamask: { isUnlocked: async () => window.automatedWalletUnlocked },
          request: args => window.automatedWalletRequest(args),
          on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
          removeListener: (name, fn) => listeners.get(name)?.delete(fn),
        };
        const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
          info: { uuid: 'af445d27-1d8c-41f8-bfef-38b7298b043a', name: 'Automated test wallet', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' }, provider,
        } }));
        window.addEventListener('eip6963:requestProvider', announce);
        window.ethereum = provider;
        announce();
      });
      stage = `${engine}:winner-page`;
      await page.goto(`${site}/auction/${state.auction}`, { waitUntil: 'domcontentloaded' });
      const button = page.getByRole('button', { name: 'View Data', exact: true });
      await button.waitFor({ state: 'visible', timeout: 45000 }).catch(async error => {
        await page.screenshot({ path: path.join(output, `deployed-${engine}-before-decrypt-failure.png`) });
        console.error(JSON.stringify({ stage, beforeDecryption: true, pageText: (await page.locator('body').innerText()).slice(0, 1800) }));
        throw error;
      });
      await page.screenshot({ path: path.join(output, `deployed-${engine}-winner.png`), animations: 'disabled' });
      stage = `${engine}:decrypt`;
      const started = Date.now();
      await button.click();
      const result = page.locator('[class*="revealedData"]');
      await result.waitFor({ state: 'visible', timeout: 45000 });
      const text = await result.innerText();
      const marker = text.match(/PROTECTED-LIVE-[0-9a-f-]+/i)?.[0];
      assert.ok(marker && await sha256(marker) === state.expectedDigest, 'Production browser decrypted the verified dummy content');
      const revealMs = Date.now() - started;
      stage = `${engine}:lock-revocation`;
      await page.evaluate(() => { window.automatedWalletUnlocked = false; });
      await result.waitFor({ state: 'hidden', timeout: 5000 });
      assert.equal((await page.locator('body').innerText()).includes(marker), false, 'Locking clears decrypted content');
      assert.deepEqual(errors, []);
      report.engines.push({ engine, unauthenticatedDirectLinkBlocked: true, newDeviceWinnerDecrypted: true, lockedWalletClearedData: true, revealMs, errors });
      await context.close();
    } finally { await browser.close(); }
  }
  report.passed = true;
  fs.writeFileSync(path.join(output, 'deployed-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(JSON.stringify({ failed: true, stage, errorType: error.name, timeout: /Timeout/.test(error.message), noSecretsLogged: true })); process.exitCode = 1; });
