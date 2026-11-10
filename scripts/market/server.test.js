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

test('SSE stream: unread on connect, targeted push, auth, caps, closes on logout and disable', async t => {
  const store = new MarketStore();
  const admin = await store.createUser({ name: 'Admin', email: 'admin@example.com', password: 'long-admin-password', role: 'admin' }, null, true);
  const user = await store.createUser({ name: 'u', email: 'u@example.com', password: 'long-user-password' }, admin.id);
  const other = await store.createUser({ name: 'o', email: 'o@example.com', password: 'long-user-password' }, admin.id);
  const server = createMarketServer(store, { origin: 'http://localhost:3010' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const readers = [];
  t.after(async () => {
    for (const reader of readers) await reader.cancel().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/market`;
  const post = (route, body, cookie = '') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3010', Cookie: cookie }, body: JSON.stringify(body) });
  const signIn = async email => (await post('/login', { email })).headers.get('set-cookie').split(';')[0];
  const [adminCookie, userCookie, otherCookie] = await Promise.all([signIn(admin.email), signIn(user.email), signIn(other.email)]);

  // Minimal SSE client: collects parsed events and reports when the server ends the stream.
  const connect = async cookie => {
    const response = await fetch(base + '/stream', { headers: { Cookie: cookie } });
    const client = { response, events: [], ended: false };
    if (response.status !== 200) return client;
    const reader = response.body.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
            if (event && data) client.events.push({ type: event[1], data: JSON.parse(data[1]) });
          }
        }
      } catch { /* cancelled */ }
      client.ended = true;
    })();
    return client;
  };
  const until = async (condition, ms = 1000) => {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    return condition();
  };

  // No stream without a session.
  assert.equal((await fetch(base + '/stream')).status, 401);

  // Unread messages are replayed on connect, with the right headers.
  store.sendMessage(user.id, 'queued before connect', admin.id);
  const first = await connect(userCookie);
  assert.equal(first.response.status, 200);
  assert.match(first.response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(first.response.headers.get('cache-control'), 'no-cache');
  assert.equal(first.response.headers.get('x-accel-buffering'), 'no');
  assert.ok(await until(() => first.events.length === 1));
  assert.equal(first.events[0].type, 'message');
  assert.equal(first.events[0].data.body, 'queued before connect');
  assert.ok(first.events[0].data.id && first.events[0].data.created_at);

  // A new admin message is pushed within 1s to that user only (all of their streams).
  const second = await connect(userCookie);
  const outsider = await connect(otherCookie);
  assert.ok(await until(() => second.events.length === 1));
  const sent = await (await post(`/admin/users/${user.id}/messages`, { body: 'pushed <b>now</b>' }, adminCookie)).json();
  assert.ok(await until(() => first.events.length === 2 && second.events.length === 2));
  assert.equal(first.events[1].data.id, sent.id);
  assert.equal(first.events[1].data.body, 'pushed <b>now</b>');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(outsider.events, []);

  // At most 5 streams per user: the oldest is closed.
  const extra = [];
  for (let i = 0; i < 4; i++) extra.push(await connect(userCookie));
  assert.ok(await until(() => first.ended));
  assert.equal(second.ended, false);

  // Logging out closes only that session's streams.
  assert.equal((await post('/logout', {}, userCookie)).status, 200);
  assert.ok(await until(() => second.ended && extra.every(c => c.ended)));
  assert.equal((await fetch(base + '/stream', { headers: { Cookie: userCookie } })).status, 401);
  assert.equal(outsider.ended, false);

  // Disabling an account closes its streams.
  assert.equal((await post(`/admin/users/${other.id}/disabled`, { disabled: true }, adminCookie)).status, 200);
  assert.ok(await until(() => outsider.ended));
});

test('SSE stream closes when its session expires', async t => {
  let now = 1000000;
  const store = new MarketStore(':memory:', () => now);
  const admin = await store.createUser({ name: 'Admin', email: 'admin@example.com', password: 'long-admin-password', role: 'admin' }, null, true);
  const server = createMarketServer(store, { origin: 'http://localhost:3010', streamPingMs: 30 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let reader;
  t.after(async () => {
    await reader?.cancel().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const login = await fetch(`http://127.0.0.1:${server.address().port}/api/market/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3010' }, body: JSON.stringify({ email: admin.email }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/market/stream`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  reader = response.body.getReader();
  now += 9 * 3600000;
  const deadline = Date.now() + 2000;
  let ended = false;
  while (!ended && Date.now() < deadline) ended = (await reader.read()).done;
  assert.equal(ended, true);
});
