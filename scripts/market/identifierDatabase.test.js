const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MarketStore } = require('./store');
const { createMarketServer } = require('./server');

test('identifiers preserve legacy accounts, sessions, budgets and seller identity across restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'market-identity-'));
  let store = new MarketStore(path.join(dir, 'test.sqlite'));
  try {
    const admin = await store.createUser({ name: 'Display name', email: 'existing@example.com', role: 'admin' }, null, true);
    const session = store.emailLogin('existing@example.com');
    const auction = store.createAuction({ description: 'Original dataset', payload: 'private', minimum: 50, minutes: 25 }, admin.id);
    store.setBudget(admin.id, 1500, admin.id);
    store.close(); store = new MarketStore(path.join(dir, 'test.sqlite'));
    const returning = store.identifierLogin('  EXISTING@example.com ');
    assert.equal(returning.user.id, admin.id);
    assert.equal(returning.user.budget, 1500);
    assert.equal(store.session(session.token).id, admin.id);
    assert.equal(store.auction(auction.id, admin.id).seller_identifier, 'existing@example.com');
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

test('record editing is admin-only, optimistic, atomic, audited and immutable once bid on', async () => {
  let now = 1800000000000;
  const store = new MarketStore(':memory:', () => now);
  try {
    const admin = await store.createUser({ name: 'Admin', identifier: 'admin-test', role: 'admin' }, null, true);
    const bidder = store.registerIdentifier('participant-01').user;
    const { id } = store.createAuction({ description: 'Before', payload: 'secret', minimum: 50, minutes: 25 }, admin.id);
    assert.throws(() => store.inspectAuction(id, bidder.id), /Administrator/);
    let state = store.inspectAuction(id, admin.id);
    const edit = { revision: state.revision, description: 'After', payload: 'changed-secret', minimum: 60, end_at: now + 600000 };
    assert.throws(() => store.editAuction(id, edit, bidder.id), /Administrator/);
    assert.throws(() => store.editAuction(id, { ...edit, highest: 10 }, admin.id), /Unsupported/);
    assert.throws(() => store.editAuction(id, { ...edit, end_at: now - 1 }, admin.id), /integer/);
    assert.equal(store.inspectAuction(id, admin.id).record.description, 'Before');
    state = store.editAuction(id, edit, admin.id);
    assert.equal(state.record.description, 'After');
    assert.equal(state.events[0].type, 'auction-edited');
    assert(!JSON.stringify(state.events).includes('changed-secret'));
    assert.throws(() => store.editAuction(id, edit, admin.id), /changed/);
    store.bid(id, 60, bidder.id, 'database-test-bid');
    state = store.inspectAuction(id, admin.id);
    assert.equal(state.editable, false);
    assert.throws(() => store.editAuction(id, { ...edit, revision: state.revision }, admin.id), /cannot be rewritten/);
    assert.equal(state.bids[0].identifier, 'participant-01');
    now += 600000;
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
    edit = { revision: record.revision, minimum: 70 };
    store.bid(id, 60, bidder.id, 'seller-edit-race');
    assert.throws(() => store.editAuction(id, edit, seller.id, false), /changed/);
    edit.revision = store.inspectAuction(id, seller.id, false).revision;
    assert.throws(() => store.editAuction(id, edit, seller.id, false), /cannot be rewritten/);
    assert.equal(store.auction(id, seller.id).minimum, 60);
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
    const adminEdit = store.editAuction(id, { revision: adminRecord.revision, description: 'Admin edit', payload: 'admin payload', minimum: 55, end_at: now + 600000 }, admin.id);
    assert.equal(adminEdit.record.description, 'Admin edit');

    settings = store.configure({ allow_post_submit_edit: true }, admin.id);
    assert.equal(settings.allow_post_submit_edit, 1);
    sellerRecord = store.inspectAuction(id, seller.id, false);
    assert.equal(sellerRecord.editable, true);
    const restored = store.editAuction(id, { ...sellerEdit, revision: sellerRecord.revision }, seller.id, false);
    assert.equal(restored.record.description, 'Admin edit');
    assert.equal(restored.record.minimum, 60);
  } finally { store.close(); }
});

test('regular admin sessions require a password while dev sessions can be pre-unlocked', async t => {
  const store = new MarketStore();
  const admin = await store.createUser({ name: 'Admin', identifier: 'admin-lock-test', role: 'admin' }, null, true);
  const origin = 'http://localhost:3010';
  const options = { origin, adminPassword: 'correct-admin-password' };
  const server = createMarketServer(store, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/market`;
  const post = (route, body, cookie = '') => fetch(base + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const login = await post('/login', { identifier: admin.identifier });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await login.json()).adminAccess, undefined);
  assert.equal((await fetch(base + '/admin/access', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await (await fetch(base + '/admin/access', { headers: { Cookie: cookie } })).json()).unlocked, false);
  assert.equal((await fetch(base + '/admin/state', { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await post('/admin/unlock', { password: 'incorrect' }, cookie)).status, 403);
  assert.equal(store.adminAccess(cookie.split('=')[1]).unlocked, false);
  assert.equal((await post('/admin/unlock', { password: 'correct-admin-password' }, cookie)).status, 200);
  assert.equal((await fetch(base + '/admin/state', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await (await fetch(base + '/session', { headers: { Cookie: cookie } })).json()).adminAccess, true);
});
