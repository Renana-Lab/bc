const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MarketStore } = require('./store');
const { createMarketServer } = require('./server');

test('auction HTTP history is seller/admin only and never exposes bidder budgets outside admin reports', async t => {
  const store = new MarketStore();
  const admin = await store.createUser({ name: 'Admin', identifier: 'privacy-admin', role: 'admin' }, null, true);
  const seller = store.registerIdentifier('privacy-seller').user;
  const buyer = store.registerIdentifier('privacy-buyer').user;
  const other = store.registerIdentifier('privacy-other').user;
  const auction = store.createAuction({ description: 'Private bids', payload: 'data', minimum: 50, minutes: 25 }, seller.id);
  store.bid(auction.id, 50, buyer.id, 'privacy-bid-01');
  const origin = 'http://localhost:3010';
  const server = createMarketServer(store, { origin });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/market`;
  for (const user of [buyer, other, seller, admin]) {
    const login = await fetch(base + '/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: user.identifier }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const detail = await (await fetch(`${base}/auctions/${auction.id}`, { headers })).json();
    const allowed = [seller.id, admin.id].includes(user.id);
    assert.equal(detail.can_view_history, allowed);
    assert.equal(detail.bids.length, allowed ? 1 : 0);
    assert.equal(detail.my_bid, user.id === buyer.id ? 50 : 0);
    assert(!JSON.stringify(detail).includes('budget_before'));
    assert(!JSON.stringify(detail).includes('budget_after'));
    if (user.id === seller.id) {
      const record = await (await fetch(`${base}/auctions/${auction.id}/record`, { headers })).json();
      assert.equal(record.bids.length, 1);
      assert(!JSON.stringify(record).includes('budget_before'));
    }
    const reportResponse = await fetch(base + '/admin/report', { headers });
    assert.equal(reportResponse.status, user.id === admin.id ? 200 : 403);
    if (user.id === admin.id) assert.equal((await reportResponse.json()).bids[0].budget_before, 2000);
  }
  store.closeAuction(auction.id, admin.id);
  store.tick();
  assert.deepEqual(store.auction(auction.id, buyer.id).bids, []);
  assert.equal(store.auction(auction.id, seller.id).bids.length, 1);
});

test('identifiers preserve legacy accounts, sessions, budgets and seller identity across restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'market-identity-'));
  let store = new MarketStore(path.join(dir, 'test.sqlite'));
  try {
    const admin = await store.createUser({ name: 'Display name', email: 'existing@example.com', role: 'admin' }, null, true);
    const session = store.emailLogin('existing@example.com');
    const auction = store.createAuction({ description: 'Original dataset', payload: 'private', minimum: 50, minutes: 25 }, admin.id);
    const record = store.inspectAuction(auction.id, admin.id);
    store.editAuction(auction.id, { revision: record.revision, minimum: 60 }, admin.id);
    store.setBudget(admin.id, 1500, admin.id);
    store.close(); store = new MarketStore(path.join(dir, 'test.sqlite'));
    const returning = store.identifierLogin('  EXISTING@example.com ');
    assert.equal(returning.user.id, admin.id);
    assert.equal(returning.user.budget, 1500);
    assert.equal(store.session(session.token).id, admin.id);
    assert.equal(store.auction(auction.id, admin.id).seller_identifier, 'existing@example.com');
    const minimums = store.one('SELECT minimum,original_minimum,adjusted_minimum FROM auctions WHERE id=?', auction.id);
    assert.deepEqual({ ...minimums }, { minimum: 60, original_minimum: 50, adjusted_minimum: 60 });
    const reported = store.report(admin.id).auctions.find(row => row.id === auction.id);
    assert.equal(reported.original_minimum, 50);
    assert.equal(reported.adjusted_minimum, 60);
    assert.equal(store.registerIdentifier('Participant-001').user.identifier, 'participant-001');
    for (const input of ['', 'a b', {}, null, 'a'.repeat(201), '<script>']) assert.throws(() => store.identifierLogin(input));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('existing marketplace databases gain the seller-edit setting without losing configuration', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'market-settings-migration-'));
  const filename = path.join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, default_budget INTEGER NOT NULL, auto_finalize INTEGER NOT NULL); INSERT INTO settings VALUES(1,'Existing marketplace',3456,0)");
  legacy.close();
  const store = new MarketStore(filename);
  try {
    assert.deepEqual({ ...store.settings() }, {
      name: 'Existing marketplace',
      default_budget: 3456,
      auto_finalize: 0,
      allow_post_submit_edit: 1
    });
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('existing auctions preserve their submitted minimum when adjustment columns are added', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'market-minimum-migration-'));
  const filename = path.join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, budget INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE auctions (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES users(id), description TEXT NOT NULL, payload TEXT NOT NULL, minimum INTEGER NOT NULL, end_at INTEGER NOT NULL, highest INTEGER NOT NULL DEFAULT 0, winner_id TEXT REFERENCES users(id), finalized_at INTEGER, end_recorded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES('seller','Seller','legacy-seller','unused','user',2000,0,1);
    INSERT INTO auctions VALUES('auction','seller','Legacy auction','private',75,9999999999999,0,NULL,NULL,0,1);
  `);
  legacy.close();
  const store = new MarketStore(filename);
  try {
    const auction = store.one('SELECT minimum,original_minimum,adjusted_minimum FROM auctions WHERE id=?', 'auction');
    assert.deepEqual({ ...auction }, { minimum: 75, original_minimum: 75, adjusted_minimum: null });
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('record editing is admin-only, optimistic, atomic, audited and immutable once bid on', async () => {
  let now = 1800000000000;
  const store = new MarketStore(':memory:', () => now);
  try {
    const admin = await store.createUser({ name: 'Admin', identifier: 'admin-test', role: 'admin' }, null, true);
    const bidder = store.registerIdentifier('participant-01').user;
    const { id } = store.createAuction({ description: 'Before', payload: 'secret', minimum: 50, minutes: 25 }, admin.id);
    assert.throws(() => store.inspectAuction(id, bidder.id), /Administrator/);
    let state = store.inspectAuction(id, admin.id);
    const edit = { revision: state.revision, minimum: 60 };
    assert.throws(() => store.editAuction(id, edit, bidder.id), /Administrator/);
    for (const extra of [{ highest: 10 }, { end_at: now - 1 }, { description: 'After' }, { payload: 'changed-secret' }]) {
      assert.throws(() => store.editAuction(id, { ...edit, ...extra }, admin.id), /only change the minimum/);
    }
    assert.equal(store.inspectAuction(id, admin.id).record.description, 'Before');
    state = store.editAuction(id, edit, admin.id);
    assert.equal(state.record.description, 'Before');
    assert.equal(state.record.payload, 'secret');
    assert.equal(state.record.minimum, 60);
    assert.equal(state.events[0].type, 'auction-edited');
    assert(!JSON.stringify(state.events).includes('changed-secret'));
    assert.throws(() => store.editAuction(id, edit, admin.id), /changed/);
    store.bid(id, 60, bidder.id, 'database-test-bid');
    state = store.inspectAuction(id, admin.id);
    assert.equal(state.editable, false);
    assert.throws(() => store.editAuction(id, { ...edit, revision: state.revision }, admin.id), /cannot be rewritten/);
    assert.equal(state.bids[0].identifier, 'participant-01');
    now += 25 * 60000;
    store.finalize(id, admin.id);
    assert.equal(store.user(bidder.id).budget, 1940);
    assert.equal(store.user(admin.id).budget, 2060);
  } finally { store.close(); }
});

test('HTTP identifier registration cannot grant admin rights or access record payloads', async t => {
  const store = new MarketStore();
  const admin = await store.createUser({ name: 'Admin', identifier: 'admin-test', role: 'admin' }, null, true);
  const { id } = store.createAuction({ description: 'Test', payload: 'private', minimum: 50, minutes: 25 }, admin.id);
  const origin = 'http://localhost:3010';
  const server = createMarketServer(store, { origin });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/market`;
  const response = await fetch(base + '/register', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'P-001', role: 'admin', developer: true }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role, 'user');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  for (const method of ['GET', 'POST']) {
    const result = await fetch(`${base}/admin/auctions/${id}/record`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(result.status, 403);
    assert(!JSON.stringify(await result.json()).includes('private'));
  }
  assert.equal((await fetch(`${base}/admin/auctions/${id}/record`)).status, 401);
  assert.equal((await fetch(`${base}/auctions/${id}/record`, { headers: { Cookie: cookie } })).status, 403);
});

test('seller edits require ownership and zero bids, including a bid arriving after the editor opens', () => {
  let now = 1800000000000;
  const store = new MarketStore(':memory:', () => now);
  try {
    const seller = store.registerIdentifier('seller-01').user;
    const bidder = store.registerIdentifier('bidder-01').user;
    const { id } = store.createAuction({ description: 'Initial', payload: 'private', minimum: 50, minutes: 25 }, seller.id);
    let record = store.inspectAuction(id, seller.id, false);
    assert.equal(record.record.original_minimum, 50);
    assert.equal(record.record.adjusted_minimum, null);
    assert.deepEqual(record.ledger, []);
    assert.throws(() => store.inspectAuction(id, bidder.id, false), /Only the seller/);
    const forbidden = { revision: record.revision, description: 'Seller update', payload: 'changed', minimum: 60, end_at: now + 900000 };
    assert.throws(() => store.editAuction(id, forbidden, bidder.id, false), /Only the seller/);
    assert.throws(() => store.editAuction(id, forbidden, seller.id, false), /only change the minimum/i);
    let edit = { revision: record.revision, minimum: 60 };
    record = store.editAuction(id, edit, seller.id, false);
    assert.equal(record.record.description, 'Initial');
    assert.equal(record.record.payload, 'private');
    assert.equal(record.record.minimum, 60);
    assert.equal(record.record.original_minimum, 50);
    assert.equal(record.record.adjusted_minimum, 60);
    edit = { revision: record.revision, minimum: 70 };
    store.bid(id, 60, bidder.id, 'seller-edit-race');
    assert.throws(() => store.editAuction(id, edit, seller.id, false), /changed/);
    edit.revision = store.inspectAuction(id, seller.id, false).revision;
    assert.throws(() => store.editAuction(id, edit, seller.id, false), /cannot be rewritten/);
    assert.equal(store.auction(id, seller.id).minimum, 60);
    assert.equal(store.auction(id, seller.id).original_minimum, 50);
    assert.equal(store.auction(id, seller.id).adjusted_minimum, 60);
    const empty = store.createAuction({ description: 'Ends without bids', payload: 'private', minimum: 50, minutes: 1 }, seller.id);
    record = store.inspectAuction(empty.id, seller.id, false);
    now += 60000;
    assert.throws(() => store.editAuction(empty.id, { revision: record.revision, minimum: 60 }, seller.id, false), /cannot be rewritten/);
  } finally { store.close(); }
});

test('admin can toggle seller post-submission editing without losing database controls', async () => {
  let now = 1800000000000;
  const store = new MarketStore(':memory:', () => now);
  try {
    const admin = await store.createUser({ name: 'Admin', identifier: 'edit-policy-admin', role: 'admin' }, null, true);
    const seller = store.registerIdentifier('edit-policy-seller').user;
    const { id } = store.createAuction({ description: 'Original', payload: 'private', minimum: 50, minutes: 25 }, seller.id);
    let sellerRecord = store.inspectAuction(id, seller.id, false);
    assert.equal(sellerRecord.editable, true);

    let settings = store.configure({ allow_post_submit_edit: false }, admin.id);
    assert.equal(settings.allow_post_submit_edit, 0);
    sellerRecord = store.inspectAuction(id, seller.id, false);
    assert.equal(sellerRecord.editable, false);
    const sellerEdit = { revision: sellerRecord.revision, minimum: 60 };
    assert.throws(() => store.editAuction(id, sellerEdit, seller.id, false), /disabled by the administrator/);

    const adminRecord = store.inspectAuction(id, admin.id);
    assert.equal(adminRecord.editable, true);
    const adminEdit = store.editAuction(id, { revision: adminRecord.revision, minimum: 55 }, admin.id);
    assert.equal(adminEdit.record.description, 'Original');
    assert.equal(adminEdit.record.original_minimum, 50);
    assert.equal(adminEdit.record.adjusted_minimum, 55);

    settings = store.configure({ allow_post_submit_edit: true }, admin.id);
    assert.equal(settings.allow_post_submit_edit, 1);
    sellerRecord = store.inspectAuction(id, seller.id, false);
    assert.equal(sellerRecord.editable, true);
    const restored = store.editAuction(id, { ...sellerEdit, revision: sellerRecord.revision }, seller.id, false);
    assert.equal(restored.record.description, 'Original');
    assert.equal(restored.record.minimum, 60);
    assert.equal(restored.record.original_minimum, 50);
    assert.equal(restored.record.adjusted_minimum, 60);
    const report = store.report(admin.id);
    const reportedAuction = report.auctions.find(auction => auction.id === id);
    assert.equal(reportedAuction.original_minimum, 50);
    assert.equal(reportedAuction.adjusted_minimum, 60);
    const latestEditSnapshot = [...report.snapshots].reverse().find(snapshot => snapshot.reason === 'auction-edited');
    const snapshottedAuction = latestEditSnapshot.state.find(auction => auction.id === id);
    assert.equal(snapshottedAuction.original_minimum, 50);
    assert.equal(snapshottedAuction.adjusted_minimum, 60);
  } finally { store.close(); }
});

test('admin role grants direct Admin Zone access while regular users remain blocked', async t => {
  const store = new MarketStore();
  const admin = await store.createUser({ name: 'Admin', identifier: 'admin-lock-test', role: 'admin' }, null, true);
  const participant = store.registerIdentifier('participant-admin-gate').user;
  const origin = 'http://localhost:3010';
  const options = { origin };
  const server = createMarketServer(store, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/market`;
  const post = (route, body, cookie = '') => fetch(base + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const login = await post('/login', { identifier: admin.identifier });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await login.json()).adminAccess, true);
  assert.equal((await fetch(base + '/admin/access', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await (await fetch(base + '/admin/access', { headers: { Cookie: cookie } })).json()).unlocked, true);
  assert.equal((await fetch(base + '/admin/state', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await (await fetch(base + '/session', { headers: { Cookie: cookie } })).json()).adminAccess, true);
  const userLogin = await post('/login', { identifier: participant.identifier });
  const userCookie = userLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/admin/state', { headers: { Cookie: userCookie } })).status, 403);
});
