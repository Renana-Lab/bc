const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
let playwright;
try {
  playwright = require('playwright');
} catch (error) {
  const fallback = path.join(
    process.env.USERPROFILE || 'C:\\Users\\Programmers',
    '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'
  );
  if (fs.existsSync(fallback)) {
    playwright = require(fallback);
  } else {
    throw error;
  }
}
const {
  chromium,
  webkit
} = playwright;
const {
  MarketStore
} = require('./store');
const {
  createMarketServer
} = require('./server');
(async () => {
  const store = new MarketStore();
  const password = 'browser-test-password';
  const admin = await store.createUser({
    name: 'Research admin',
    email: 'admin@example.com',
    password,
    role: 'admin'
  }, null, true);
  const user = await store.createUser({
    name: 'Participant',
    email: 'participant@example.com',
    password
  }, admin.id);
  await store.createUser({
    name: 'Bot 01',
    email: 'bot@example.com',
    role: 'bot'
  }, admin.id);
  const auction = store.createAuction({
    description: 'Research dataset',
    payload: 'Purchased dataset',
    minimum: 50,
    minutes: 25
  }, admin.id);
  // Origin is supplied after listen so the fixture uses a free port.
  const options = {
    staticDir: path.resolve('build-backend'),
    origin: 'http://localhost:3010',
    adminPassword: 'browser-admin-password',
    devLogin: true
  };
  const server = createMarketServer(store, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  options.origin = base;
  const engine = process.argv[2] === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({
    headless: true
  });
  const errors = [],
    requests = [];
  let page;
  try {
    const context = await browser.newContext({
      viewport: {
        width: 1440,
        height: 1000
      }
    });
    page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => requests.push(r.url()));
    await page.goto(base + '/manage-budget');
    await page.getByRole('button', {
      name: 'Log in',
      exact: true
    }).waitFor();
    assert.equal(await page.getByRole('heading', {
      name: 'Admin Zone'
    }).count(), 0);
    await page.getByLabel('Identifier').fill('admin@example.com');
    await page.getByRole('button', {
      name: 'Log in',
      exact: true
    }).click();
    await page.getByRole('heading', { name: 'Admin Zone', exact: true }).waitFor();
    assert.equal(await page.getByText('Bot 01', { exact: true }).count(), 0);
    await page.getByLabel('Admin password').fill('wrong-password');
    await page.getByRole('button', { name: 'Unlock Admin Zone', exact: true }).click();
    await page.getByText('Admin password incorrect', { exact: true }).waitFor();
    await page.getByLabel('Admin password').fill('browser-admin-password');
    await page.getByRole('button', { name: 'Unlock Admin Zone', exact: true }).click();
    await page.getByRole('heading', {
      name: 'Admin Zone'
    }).waitFor();
    await page.getByText('Bot 01', {
      exact: true
    }).first().waitFor();
    await page.getByRole('button', {
      name: 'Run manual cycle'
    }).click();
    await page.getByText('1 cycles / 1 bids', {
      exact: false
    }).waitFor();
    fs.mkdirSync('artifacts/backend', {
      recursive: true
    });
    await page.screenshot({
      path: 'artifacts/backend/admin-desktop.png',
      fullPage: true
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.goto(base + '/auctions-list');
    await page.getByRole('button', { name: 'Manage database record: Research dataset', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByText('This record is read-only', { exact: false }).waitFor();
    await page.getByRole('tab', { name: 'Bids (1)' }).click();
    await page.getByRole('cell', { name: 'bot@example.com', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const editable = store.createAuction({ description: 'Editable record', payload: 'Private editable data', minimum: 50, minutes: 25 }, admin.id);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Manage database record: Editable record', exact: true }).click();
    await page.getByRole('dialog').getByLabel(/^Description/).fill('Edited from list');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Database updated.', { exact: true }).waitFor();
    assert.equal(store.inspectAuction(editable.id, admin.id).record.description, 'Edited from list');
    await page.screenshot({ path: 'artifacts/backend/database-editor.png', fullPage: true });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.screenshot({ path: 'artifacts/backend/auctions-desktop.png', fullPage: true });
    await page.getByRole('button', {
      name: 'Open menu',
      exact: true
    }).click();
    // Drawer transitions can leave the link outside the synthetic viewport for one frame.
    await page.getByRole('link', { name: 'Start an Auction' }).evaluate(link => link.click());
    await page.getByRole('button', {
      name: 'Create auction',
      exact: true
    }).waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({
      path: 'artifacts/backend/open-auction-current.png',
      fullPage: true
    });
    await page.getByLabel(/^Description/).fill('Browser-created dataset');
    await page.getByLabel(/^Data for sale/).fill('Private browser-created data');
    await page.getByRole('button', {
      name: 'Create auction',
      exact: true
    }).click();
    await page.getByRole('heading', {
      name: 'Browser-created dataset',
      exact: true
    }).waitFor();
    await page.getByRole('button', {
      name: 'Sign out',
      exact: true
    }).click();
    await page.getByLabel('Identifier').fill(user.identifier);
    await page.getByRole('button', {
      name: 'Log in',
      exact: true
    }).click();
    await page.getByRole('heading', {
      name: 'Auctions',
      exact: true
    }).waitFor();
    const owned = store.createAuction({ description: 'Seller-owned auction', payload: 'Owner data', minimum: 50, minutes: 25 }, user.id);
    await page.goto(`${base}/auction/${owned.id}`);
    await page.getByRole('button', { name: 'Edit your auction', exact: true }).click();
    assert.equal(await page.getByRole('dialog').getByLabel(/^Description/).isDisabled(), true);
    await page.getByRole('dialog').getByLabel(/^Minimum bid/).fill('60');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Auction updated.', { exact: true }).waitFor();
    assert.equal(store.inspectAuction(owned.id, user.id, false).record.description, 'Seller-owned auction');
    assert.equal(store.inspectAuction(owned.id, user.id, false).record.minimum, 60);
    await page.getByRole('dialog').getByLabel(/^Minimum bid/).fill('70');
    store.bid(owned.id, 60, admin.id, 'browser-edit-race');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Auction changed. Reload the record before saving.', { exact: true }).waitFor();
    assert.equal(store.inspectAuction(owned.id, user.id, false).record.minimum, 60);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Edit your auction', exact: true }).waitFor({ state: 'hidden' });
    await page.goto(`${base}/auction/${auction.id}`);
    assert.equal(await page.getByRole('button', { name: 'Export Transactions', exact: true }).count(), 0);
    assert.equal(await page.getByText('Your cumulative bid:', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Auction status:', { exact: true }).count(), 0);
    await page.getByLabel(/^Add to your bid/).fill('100');
    await page.getByRole('button', {
      name: 'Place bid',
      exact: true
    }).click();
    await page.getByRole('cell', {
      name: 'Participant',
      exact: true
    }).waitFor();
    assert.equal(store.user(user.id).budget, 1900);
    store.closeAuction(auction.id, admin.id);
    store.tick();
    await page.getByText('Purchased dataset', {
      exact: true
    }).waitFor();
    await page.goto(base + '/manage-budget');
    await page.getByRole('heading', {
      name: 'Auctions',
      exact: true
    }).waitFor();
    await page.setViewportSize({
      width: 390,
      height: 844
    });
    await page.screenshot({
      path: 'artifacts/backend/auctions-mobile.png',
      fullPage: true
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.getByRole('button', { name: /Manage database record/ }).count(), 0);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Identifier').fill('participant-browser-02');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.getByRole('heading', { name: 'Auctions', exact: true }).waitFor();
    assert.equal(store.one('SELECT role FROM users WHERE email=?', 'participant-browser-02').role, 'user');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Quick dev sign-in', exact: true }).click();
    await page.goto(`${base}/auction/${auction.id}`);
    await page.getByRole('button', { name: 'Export Transactions', exact: true }).waitFor();
    await page.goto(base + '/manage-budget');
    await page.getByText('Bot 01', { exact: true }).first().waitFor();
    assert.equal(await page.getByLabel('Admin password').count(), 0);
    assert.deepEqual(errors, []);
    assert(!requests.some(url => !url.startsWith(base)), 'Unexpected external request');
    console.log('Browser checks passed: one-step login, admin gate, bots, minimum-only seller edits, creation, bidding, finalization, purchased data, desktop/mobile overflow, and local-only requests.');
    await context.close();
  } catch (error) {
    console.error('Page errors:', errors, 'Page text:', await page?.locator('body').innerText());
    throw error;
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
