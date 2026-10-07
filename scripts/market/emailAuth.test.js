const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MarketStore } = require('./store');
const { createMarketServer } = require('./server');

test('email signup and returning login share an account and preserve budgets', () => {
  const store = new MarketStore();
  try {
    assert.throws(() => store.identifierLogin('person@example.com'), /register first/);
    const first = store.registerIdentifier('  Person@Example.com  ');
    assert.equal(first.user.role, 'user');
    assert.equal(first.user.budget, 2000);
    store.run('UPDATE users SET budget=1800 WHERE id=?', first.user.id);
    const next = store.emailLogin('person@example.com');
    assert.equal(next.user.id, first.user.id);
    assert.equal(next.user.budget, 1800);
    assert.throws(() => store.identifierLogin('invalid identifier'), /identifier/);
    store.run('UPDATE users SET disabled=1 WHERE id=?', first.user.id);
    assert.throws(() => store.emailLogin('person@example.com'), /unavailable/);
    assert.throws(() => store.session(first.token), /unavailable/);
  } finally { store.close(); }
});

test('registration is required before login; duplicates never create sessions or reset budgets', async t => {
  const store = new MarketStore();
  const server = createMarketServer(store, { origin: 'http://localhost:3010' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/market`;
  const post = (route, value) => fetch(base + route, { method: 'POST', headers: { Origin: 'http://localhost:3010', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  for (const value of [{ identifier: 'prolific-001' }, { email: 'prolific-001', registering: true, developer: true }]) {
    const rejected = await post('/login', value);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('set-cookie'), null);
  }
  assert.equal(store.one('SELECT COUNT(*) n FROM users').n, 0);
  assert.equal(store.one('SELECT COUNT(*) n FROM sessions').n, 0);
  assert.equal(store.one('SELECT COUNT(*) n FROM ledger').n, 0);
  assert.equal((await fetch(base + '/auctions')).status, 401);
  const response = await post('/register', { identifier: ' Prolific-001 ' });
  assert.equal(response.status, 200);
  const first = (await response.json()).user;
  assert.equal(first.identifier, 'prolific-001');
  const count = store.one('SELECT COUNT(*) n FROM sessions').n;
  store.run('UPDATE users SET budget=1800 WHERE id=?', first.id);
  const duplicate = await post('/register', { identifier: 'PROLIFIC-001' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.headers.get('set-cookie'), null);
  assert.equal(store.one('SELECT COUNT(*) n FROM sessions').n, count);
  const login = await post('/login', { identifier: 'prolific-001' });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.budget, 1800);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/auctions', { headers: { Cookie: cookie } })).status, 200);
});

test('dev entry is opt-in, loopback-only, blocked in production and not reachable through email signup', async t => {
  const store = new MarketStore();
  const options = { devLogin: false, origin: 'http://localhost:3010' };
  const server = createMarketServer(store, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/market`;
  const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { Origin: options.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/dev-login')).status, 403);
  assert.equal((await (await fetch(base + '/auth-options')).json()).devLogin, false);
  options.devLogin = true;
  const response = await post('/dev-login');
  const first = await response.json();
  assert.equal(first.user.role, 'admin');
  assert.equal(first.adminAccess, true);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  const devCookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/admin/state', { headers: { Cookie: devCookie } })).status, 200);
  assert.equal((await (await post('/dev-login')).json()).user.id, first.user.id);
  assert.equal((await post('/login', { email: first.user.email })).status, 403);
  const signup = await (await post('/register', { email: 'new@example.com', role: 'admin', developer: true })).json();
  assert.equal(signup.user.role, 'user');
  options.origin = 'https://example.com';
  assert.equal((await post('/dev-login')).status, 403);
  options.origin = 'http://localhost:3010';
  const original = process.env.NODE_ENV;
  try { process.env.NODE_ENV = 'production'; assert.equal((await post('/dev-login')).status, 403); }
  finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
});
