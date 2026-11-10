const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const {
  MarketStore,
  MarketError,
  check
} = require('./store');
const MAX_STREAMS_PER_USER = 5;
const STREAM_PING_MS = 25000;
function createMarketServer(store, options = {}) {
  // Open Server-Sent Event streams: userId -> Set of { res, userId, digest (session token hash), timer }.
  const streams = new Map();
  const closeStream = entry => {
    const set = streams.get(entry.userId);
    set?.delete(entry);
    if (set && !set.size) streams.delete(entry.userId);
    clearInterval(entry.timer);
    if (!entry.res.writableEnded) entry.res.end();
  };
  const closeWhere = predicate => {
    for (const set of [...streams.values()]) for (const entry of [...set]) if (predicate(entry)) closeStream(entry);
  };
  const sseWrite = (entry, text) => {
    try { entry.res.write(text); } catch { closeStream(entry); }
  };
  const sendMessageEvent = (entry, message) => sseWrite(entry, `event: message\ndata: ${JSON.stringify(message)}\n\n`);
  const onMessage = ({ userId, message }) => { for (const entry of [...(streams.get(userId) || [])]) sendMessageEvent(entry, message); };
  const onSessionClosed = ({ digest }) => closeWhere(entry => entry.digest === digest);
  const onUserClosed = ({ userId }) => closeWhere(entry => entry.userId === userId);
  store.bus.on('message', onMessage);
  store.bus.on('session-closed', onSessionClosed);
  store.bus.on('user-sessions-closed', onUserClosed);
  const attempts = new Map();
  const origin = options.origin || 'http://localhost:3010';
  const secure = new URL(origin).protocol === 'https:';
  const cookie = (token, expired = false) => `market_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${expired ? 0 : 28800}${secure ? '; Secure' : ''}`;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, origin),
        route = url.pathname.replace(/^\/api\/market/, '');
      if (!url.pathname.startsWith('/api/market/')) {
        if (options.staticDir && req.method === 'GET') {
          const root = path.resolve(options.staticDir),
            requested = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
          check(requested.startsWith(root + path.sep) || requested === root, 'Invalid path', 400);
          const file = fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : path.join(root, 'index.html');
          const types = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.woff2': 'font/woff2',
            '.jpg': 'image/jpeg'
          };
          res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
          fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
          return;
        }
        throw new MarketError('Not found', 404);
      }
      const write = !['GET', 'HEAD'].includes(req.method);
      if (write) {
        check(req.headers.origin === (options.origin || origin), 'Origin not allowed', 403);
        check(req.headers['content-type']?.split(';')[0] === 'application/json', 'JSON content type required', 415);
      }
      let body = {};
      if (write) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          check(size <= 3_000_000, 'Request too large', 413);
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {
          throw new MarketError('Invalid JSON');
        }
        check(body && typeof body === 'object' && !Array.isArray(body), 'JSON object required');
      }
      const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('market_session='))?.slice(15) || '';
      const localOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(options.origin || origin).hostname);
      const localRequest = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const devLogin = options.devLogin === true && process.env.NODE_ENV !== 'production' && localOrigin && localRequest;
      if (route === '/auth-options' && req.method === 'GET') { send(200, { devLogin }); return; }
      if (route === '/dev-login' && req.method === 'POST') {
        check(devLogin, 'Development sign-in is disabled', 403);
        const result = store.identifierLogin('dev-admin@market.invalid', true);
        store.unlockAdminSession(result.token);
        res.setHeader('Set-Cookie', cookie(result.token));
        send(200, { user: result.user, settings: store.settings(), adminAccess: true }); return;
      }
      if (route.endsWith('/password')) throw new MarketError('Password sign-in is no longer used', 410);
      if ((route === '/login' || route === '/register') && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
        const identifier = body.identifier ?? body.email;
        check(typeof identifier === 'string' && identifier.length <= 200, 'Enter a valid identifier');
        for (const [key, limit] of [[ip, 120], [`${ip}:${identifier.toLowerCase().trim()}`, 10]]) {
          check(attempts.size < 10000 || attempts.has(key), 'Please try again later', 429);
          const attempt = attempts.get(key) || { count: 0, until: now + 60000 };
          check(++attempt.count <= limit, 'Too many sign-in attempts. Wait one minute.', 429);
          attempts.set(key, attempt);
        }
        const result = store.identifierLogin(identifier);
        res.setHeader('Set-Cookie', cookie(result.token));
        send(200, {
          user: result.user,
          settings: store.settings(),
          adminAccess: result.user.role === 'admin'
        });
        return;
      }
      if (route === '/logout' && req.method === 'POST') {
        store.logout(token);
        res.setHeader('Set-Cookie', cookie('', true));
        send(200, {
          ok: true
        });
        return;
      }
      const user = store.session(token);
      if (route === '/stream' && req.method === 'GET') {
        check(user.role !== 'bot', 'Streams are not available for this account', 403);
        req.socket.setTimeout(0);
        req.socket.setNoDelay(true);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        const entry = { res, userId: user.id, digest: createHash('sha256').update(token).digest('hex'), timer: null };
        const set = streams.get(user.id) || new Set();
        streams.set(user.id, set);
        set.add(entry);
        // Keep at most MAX_STREAMS_PER_USER; the oldest connections are closed first.
        while (set.size > MAX_STREAMS_PER_USER) {
          const oldest = set.values().next().value;
          // Tell the client not to reconnect (EventSource would otherwise evict another tab in a loop).
          sseWrite(oldest, 'event: superseded\ndata: {}\n\n');
          closeStream(oldest);
        }
        res.on('close', () => closeStream(entry));
        // Register before replaying so a message sent meanwhile is not lost (clients dedupe by id).
        sseWrite(entry, ': connected\n\n');
        for (const message of store.unreadMessages(user.id)) sendMessageEvent(entry, message);
        entry.timer = setInterval(() => {
          try { store.session(token); } catch { closeStream(entry); return; }
          sseWrite(entry, ': ping\n\n');
        }, options.streamPingMs || STREAM_PING_MS);
        return;
      }
      if (route === '/admin/access' && req.method === 'GET') {
        const access = store.adminAccess(token);
        send(200, { unlocked: access.unlocked }); return;
      }
      if (route === '/admin/unlock' && req.method === 'POST') {
        store.admin(user.id);
        send(200, { unlocked: true }); return;
      }
      const parts = route.split('/').filter(Boolean);
      if (parts[0] === 'auctions' && parts[2] === 'record' && parts.length === 3 && ['GET', 'POST'].includes(req.method)) {
        const result = req.method === 'GET' ? store.inspectAuction(parts[1], user.id, false) : store.editAuction(parts[1], body, user.id, false);
        send(200, result); return;
      }
      let result;
      if (route === '/session' && req.method === 'GET') result = {
        user,
        settings: store.settings(),
        adminAccess: user.role === 'admin',
        serverTime: store.now()
      };else if (route === '/heartbeat' && req.method === 'POST') {
        result = { ok: true, messages: store.heartbeat(token).messages };
      } else if (parts[0] === 'messages' && parts[2] === 'read' && parts.length === 3 && req.method === 'POST') {
        result = store.markMessageRead(parts[1], user.id);
      } else if (route === '/password' && req.method === 'POST') result = await store.changePassword(user.id, body.password, user.id, body.currentPassword);else if (route === '/auctions' && req.method === 'GET') result = {
        auctions: store.auctionsFor(user.id),
        serverTime: store.now()
      };else if (route === '/auctions' && req.method === 'POST') result = store.createAuction(body, user.id);else if (parts[0] === 'auctions' && parts.length === 2 && req.method === 'GET') result = store.auction(parts[1], user.id);else if (parts[0] === 'auctions' && parts[2] === 'bid' && req.method === 'POST') result = store.bid(parts[1], body.amount, user.id, req.headers['idempotency-key']);else if (parts[0] === 'auctions' && parts[2] === 'finalize' && req.method === 'POST') result = store.finalize(parts[1], user.id);else if (parts[0] === 'admin') {
        store.admin(user.id);
        if (parts[1] === 'auctions' && parts[3] === 'record' && parts.length === 4 && ['GET', 'POST'].includes(req.method)) {
          result = req.method === 'GET' ? store.inspectAuction(parts[2], user.id) : store.editAuction(parts[2], body, user.id);
          send(200, result); return;
        }
        if (parts[1] === 'users' && parts[3] === 'messages' && parts.length === 4 && ['GET', 'POST'].includes(req.method)) {
          result = req.method === 'GET' ? store.userMessages(parts[2], user.id) : store.sendMessage(parts[2], body.body, user.id);
          send(200, result); return;
        }
        if (parts[1] === 'auctions' && parts[3] === 'delete' && parts.length === 4 && req.method === 'POST') {
          result = store.deleteAuction(parts[2], body.note, user.id);
          send(200, result); return;
        }
        if (route === '/admin/bots' && req.method === 'POST') {
          result = await store.createUser({ name: body.name, email: `${randomUUID()}@bots.invalid`, role: 'bot' }, user.id);
          send(200, result); return;
        }
        if (route === '/admin/state' && req.method === 'GET') result = store.adminState(user.id);else if (route === '/admin/list-state' && req.method === 'GET') result = store.listStateAt(Number(url.searchParams.get('at')), user.id);else if (route === '/admin/report' && req.method === 'GET') result = store.report(user.id);else if (route === '/admin/users' && req.method === 'POST') result = await store.createUser(body, user.id);else if (route === '/admin/settings' && req.method === 'POST') result = store.configure(body, user.id);else if (route === '/admin/budgets/reset' && req.method === 'POST') result = store.resetBudgets(body.total, user.id);else if (route === '/admin/batch' && req.method === 'POST') result = store.batch(body.auctions, user.id);else if (route === '/admin/bots/run' && req.method === 'POST') result = store.runBots(true);else if (route === '/admin/bots/start' && req.method === 'POST') {
          store.transaction(() => {
            store.run('UPDATE bots SET running=1,next_at=? WHERE enabled=1 AND user_id IN (SELECT id FROM users WHERE disabled=0)', store.now());
            store.event('bots-started', user.id, {});
          });
          result = {
            ok: true
          };
        } else if (route === '/admin/bots/stop' && req.method === 'POST') {
          store.run('UPDATE bots SET running=0');
          store.event('bots-stopped', user.id, {});
          result = {
            ok: true
          };
        } else if (parts[1] === 'bots' && parts[3] === 'run' && req.method === 'POST') {
          result = store.runBots(true, parts[2]) || { bots: 0, sent: 0, decisions: [] };
        } else if (parts[1] === 'bots' && parts[3] === 'remove' && req.method === 'POST') {
          result = store.removeBot(parts[2], user.id);
        } else if (route === '/admin/finalize' && req.method === 'POST') result = store.all('SELECT id FROM auctions WHERE end_at<=? AND finalized_at IS NULL', store.now()).map(a => store.finalize(a.id, user.id));else if (parts[1] === 'users' && parts[3] === 'budget' && req.method === 'POST') result = store.setBudget(parts[2], body.total, user.id);else if (parts[1] === 'users' && parts[3] === 'password' && req.method === 'POST') result = await store.changePassword(parts[2], body.password, user.id, body.currentPassword);else if (parts[1] === 'users' && parts[3] === 'disabled' && req.method === 'POST') result = store.disable(parts[2], body.disabled, user.id);else if (parts[1] === 'bots' && parts.length === 3 && req.method === 'POST') result = store.botSettings(parts[2], body, user.id);else if (parts[1] === 'auctions' && parts[3] === 'close' && req.method === 'POST') result = store.closeAuction(parts[2], user.id);else throw new MarketError('Not found', 404);
      } else throw new MarketError('Not found', 404);
      send(200, result);
    } catch (error) {
      if (!(error instanceof MarketError)) console.error('Market request failed:', error.message);
      if (!res.headersSent) send(error.status || 500, {
        error: error.status ? error.message : 'Server error. Please retry.'
      });
    }
  });
  server.requestTimeout = 15000;
  const closeServer = server.close.bind(server);
  server.close = callback => {
    store.bus.off('message', onMessage);
    store.bus.off('session-closed', onSessionClosed);
    store.bus.off('user-sessions-closed', onUserClosed);
    closeWhere(() => true);
    return closeServer(callback);
  };
  return server;
}
if (require.main === module) {
  const dir = path.resolve(process.env.MARKET_DATA_DIR || 'market-data');
  fs.mkdirSync(dir, {
    recursive: true
  });
  const store = new MarketStore(path.join(dir, 'market.sqlite'));
  const server = createMarketServer(store, {
    devLogin: process.env.MARKET_DEV_LOGIN === '1',
    origin: process.env.MARKET_ORIGIN,
    staticDir: process.env.MARKET_STATIC_DIR,
    adminPassword: process.env.MARKET_ADMIN_PASSWORD
  });
  let lastFailure = '';
  const timer = setInterval(() => {
    try {
      store.tick();
      lastFailure = '';
    } catch (error) {
      if (lastFailure !== error.message) {
        console.error('Market scheduler:', error.message);
        lastFailure = error.message;
      }
    }
  }, 1000);
  server.listen(Number(process.env.MARKET_PORT || 3011), process.env.MARKET_HOST || '127.0.0.1', () => console.log(`Marketplace API listening on ${server.address().port}`));
  const stop = () => {
    clearInterval(timer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
module.exports = {
  createMarketServer
};
