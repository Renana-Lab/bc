const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const {
  MarketStore
} = require('./store');
const {
  createMarketServer
} = require('./server');
test('HTTP gate, CSRF, role enforcement, cookies and concurrent bid ordering', async t => {
  const store = new MarketStore();
  const admin = await store.createUser({
    name: 'Admin',
    email: 'admin@example.com',
    password: 'long-admin-password',
    role: 'admin'
  }, null, true);
  const users = await Promise.all(['a', 'b'].map(name => store.createUser({
    name,
    email: `${name}@example.com`,
    password: 'long-user-password'
  }, admin.id)));
  const server = createMarketServer(store, {
    origin: 'http://localhost:3010'
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/market`;
  const post = (route, body, cookie = '', extra = {}) => fetch(base + route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3010',
      Cookie: cookie,
      ...extra
    },
    body: JSON.stringify(body)
  });
  assert.equal((await fetch(base + '/auctions')).status, 401);
  assert.equal((await post('/login', {}, '', {
    Origin: 'http://evil.example'
  })).status, 403);
  const logins = await Promise.all(users.map(u => post('/login', {
    email: u.email,
    password: 'long-user-password'
  })));
  assert.match(logins[0].headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookies = logins.map(r => r.headers.get('set-cookie').split(';')[0]);
  assert.equal((await fetch(base + '/admin/report', {
    headers: {
      Cookie: cookies[0]
    }
  })).status, 403);
  const id = store.createAuction({
    description: 'test',
    payload: 'secret',
    minimum: 50,
    minutes: 30
  }, admin.id).id;
  const results = await Promise.all(cookies.map((cookie, i) => post(`/auctions/${id}/bid`, {
    amount: 100
  }, cookie, {
    'Idempotency-Key': `test-bid-${i}`
  })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(store.auction(id, users[0].id).bids, []);
  assert.equal(store.auction(id, users[0].id).my_bid, results[0].status === 200 ? 100 : 0);
  await post('/logout', {}, cookies[0]);
  assert.equal((await fetch(base + '/session', {
    headers: {
      Cookie: cookies[0]
    }
  })).status, 401);
});

test('HTTP: admin messages via heartbeat and soft delete of auctions', async t => {
  const store = new MarketStore();
  const admin = await store.createUser({ name: 'Admin', email: 'admin@example.com', password: 'long-admin-password', role: 'admin' }, null, true);
  const user = await store.createUser({ name: 'u', email: 'u@example.com', password: 'long-user-password' }, admin.id);
  const other = await store.createUser({ name: 'o', email: 'o@example.com', password: 'long-user-password' }, admin.id);
  const server = createMarketServer(store, { origin: 'http://localhost:3010' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/market`;
  const post = (route, body, cookie = '', extra = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3010', Cookie: cookie, ...extra }, body: JSON.stringify(body) });
  const get = (route, cookie) => fetch(base + route, { headers: { Cookie: cookie } });
  const signIn = async email => (await post('/login', { email })).headers.get('set-cookie').split(';')[0];
  const [adminCookie, userCookie, otherCookie] = await Promise.all([signIn(admin.email), signIn(user.email), signIn(other.email)]);

  assert.equal((await post(`/admin/users/${user.id}/messages`, { body: 'hi' }, userCookie)).status, 403);
  assert.equal((await post(`/admin/users/${user.id}/messages`, { body: '' }, adminCookie)).status, 400);
  assert.equal((await post(`/admin/users/${user.id}/messages`, { body: 'x'.repeat(1001) }, adminCookie)).status, 400);
  assert.equal((await post(`/admin/users/${user.id}/messages`, { body: 'Hello <i>there</i>' }, adminCookie)).status, 200);
  const beat = await (await post('/heartbeat', {}, userCookie)).json();
  assert.equal(beat.ok, true);
  assert.equal(beat.messages.length, 1);
  assert.equal(beat.messages[0].body, 'Hello <i>there</i>');
  assert.deepEqual((await (await post('/heartbeat', {}, otherCookie)).json()).messages, []);
  assert.equal((await post(`/messages/${beat.messages[0].id}/read`, {}, otherCookie)).status, 404);
  assert.equal((await post(`/messages/${beat.messages[0].id}/read`, {}, userCookie)).status, 200);
  assert.deepEqual((await (await post('/heartbeat', {}, userCookie)).json()).messages, []);
  assert.equal((await get(`/admin/users/${user.id}/messages`, userCookie)).status, 403);
  const history = await (await get(`/admin/users/${user.id}/messages`, adminCookie)).json();
  assert.equal(history.messages.length, 1);
  assert.ok(history.messages[0].read_at);

  const id = store.createAuction({ description: 'Visible data', payload: 'secret', minimum: 50, minutes: 30 }, other.id).id;
  assert.equal((await post(`/admin/auctions/${id}/delete`, {}, userCookie)).status, 403);
  assert.equal((await post(`/admin/auctions/${id}/delete`, { note: 'policy' }, adminCookie)).status, 200);
  assert.equal((await post(`/admin/auctions/${id}/delete`, {}, adminCookie)).status, 409);
  assert.deepEqual((await (await get('/auctions', userCookie)).json()).auctions, []);
  assert.equal((await get(`/auctions/${id}`, userCookie)).status, 404);
  assert.equal((await post(`/auctions/${id}/bid`, { amount: 100 }, userCookie, { 'Idempotency-Key': 'deleted-bid-1' })).status, 404);
  const adminList = (await (await get('/auctions', adminCookie)).json()).auctions;
  assert.equal(adminList[0].deleted_note, 'policy');
  assert.equal((await get(`/auctions/${id}`, adminCookie)).status, 200);
});
