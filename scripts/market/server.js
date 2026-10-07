const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const {
  MarketStore,
  MarketError,
  check
} = require('./store');
function createMarketServer(store, options = {}) {
  const attempts = new Map();
  const origin = options.origin || 'http://localhost:3010';
  const secure = new URL(origin).protocol === 'https:';
  const passwordMatches = value => {
    const configured = options.adminPassword || process.env.MARKET_ADMIN_PASSWORD || '';
    check(configured.length >= 8, 'Admin Zone password is not configured', 503);
    check(typeof value === 'string' && value.length <= 256, 'Admin password required', 400);
    const expected = createHash('sha256').update(configured).digest();
    const actual = createHash('sha256').update(value).digest();
    return timingSafeEqual(actual, expected);
  };
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
        const result = route === '/register' ? store.registerIdentifier(identifier) : store.identifierLogin(identifier);
        res.setHeader('Set-Cookie', cookie(result.token));
        send(200, {
          user: result.user,
          settings: store.settings()
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
      if (route === '/admin/access' && req.method === 'GET') {
        const access = store.adminAccess(token);
        send(200, { unlocked: access.unlocked }); return;
      }
      if (route === '/admin/unlock' && req.method === 'POST') {
        store.admin(user.id);
        const key = `${req.socket.remoteAddress}:admin-unlock`;
        const now = Date.now();
        let attempt = attempts.get(key) || { count: 0, until: now + 60000 };
        if (attempt.until < now) attempt = { count: 0, until: now + 60000 };
        check(++attempt.count <= 8, 'Too many admin password attempts. Wait one minute.', 429);
        attempts.set(key, attempt);
        check(passwordMatches(body.password), 'Admin password incorrect', 403);
        send(200, store.unlockAdminSession(token)); return;
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
        adminAccess: user.role === 'admin' ? store.adminAccess(token).unlocked : false,
        serverTime: store.now()
      };else if (route === '/heartbeat' && req.method === 'POST') {
        store.heartbeat(token);
        result = {
          ok: true
        };
      } else if (route === '/password' && req.method === 'POST') result = await store.changePassword(user.id, body.password, user.id, body.currentPassword);else if (route === '/auctions' && req.method === 'GET') result = {
        auctions: store.auctions(),
        serverTime: store.now()
      };else if (route === '/auctions' && req.method === 'POST') result = store.createAuction(body, user.id);else if (parts[0] === 'auctions' && parts.length === 2 && req.method === 'GET') result = store.auction(parts[1], user.id);else if (parts[0] === 'auctions' && parts[2] === 'bid' && req.method === 'POST') result = store.bid(parts[1], body.amount, user.id, req.headers['idempotency-key']);else if (parts[0] === 'auctions' && parts[2] === 'finalize' && req.method === 'POST') result = store.finalize(parts[1], user.id);else if (parts[0] === 'admin') {
        store.adminSession(token);
        if (parts[1] === 'auctions' && parts[3] === 'record' && parts.length === 4 && ['GET', 'POST'].includes(req.method)) {
          result = req.method === 'GET' ? store.inspectAuction(parts[2], user.id) : store.editAuction(parts[2], body, user.id);
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
