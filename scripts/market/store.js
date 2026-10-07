const {
  DatabaseSync
} = require('node:sqlite');
const {
  randomUUID,
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash
} = require('node:crypto');
const {
  promisify
} = require('node:util');
const derive = promisify(scrypt);
const LIMIT = 1_000_000_000;
class MarketError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const check = (condition, message, status) => {
  if (!condition) throw new MarketError(message, status);
};
function integer(value, min = 1, max = LIMIT) {
  const num = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
  check(Number.isSafeInteger(num) && num >= min && num <= max, `Expected an integer from ${min} to ${max}`);
  return num;
}
function label(value, max = 200) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Text is required (maximum ${max} characters)`);
  return value.trim();
}
const digest = token => createHash('sha256').update(token).digest('hex');
function identifier(value) {
  const normalized = label(value, 200).toLowerCase();
  check(/^[a-z0-9][a-z0-9._@+-]*$/.test(normalized), 'Use letters, numbers, dots, underscores, @, + or hyphens for the identifier');
  return normalized;
}
async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  check(typeof password === 'string' && password.length >= 12 && password.length <= 256, 'Password must contain 12-256 characters');
  return `${salt}:${(await derive(password, salt, 64)).toString('hex')}`;
}
async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, expected] = hash.split(':');
  const actual = await derive(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
class MarketStore {
  constructor(filename = ':memory:', clock = Date.now) {
    this.now = clock;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, default_budget INTEGER NOT NULL, auto_finalize INTEGER NOT NULL);
      INSERT OR IGNORE INTO settings VALUES(1,'Data Market',2000,1);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','admin','bot')), budget INTEGER NOT NULL CHECK(budget>=0), disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, seen_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auctions (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES users(id), description TEXT NOT NULL, payload TEXT NOT NULL, minimum INTEGER NOT NULL, end_at INTEGER NOT NULL, highest INTEGER NOT NULL DEFAULT 0, winner_id TEXT REFERENCES users(id), finalized_at INTEGER, end_recorded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auctions_active ON auctions(finalized_at,end_at);
      CREATE TABLE IF NOT EXISTS bids (id TEXT PRIMARY KEY, auction_id TEXT NOT NULL REFERENCES auctions(id), user_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, cumulative INTEGER NOT NULL, budget_before INTEGER NOT NULL, budget_after INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bids_actor ON bids(auction_id,user_id,created_at);
      CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), auction_id TEXT REFERENCES auctions(id), delta INTEGER NOT NULL, balance INTEGER NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, actor_id TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, reason TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bots (user_id TEXT PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 1, running INTEGER NOT NULL DEFAULT 0, interval_seconds INTEGER NOT NULL DEFAULT 60, max_bids INTEGER NOT NULL DEFAULT 1, max_bid INTEGER NOT NULL DEFAULT 2000, bid_increment INTEGER NOT NULL DEFAULT 10, max_above_opening INTEGER, next_at INTEGER NOT NULL DEFAULT 0, cycles INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (user_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(user_id,key));
      CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger is immutable'); END;`);
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all();
    if (!sessionColumns.some(column => column.name === 'admin_unlocked')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN admin_unlocked INTEGER NOT NULL DEFAULT 0');
    }
    const botColumns = this.db.prepare('PRAGMA table_info(bots)').all();
    if (!botColumns.some(column => column.name === 'bid_increment')) {
      this.db.exec('ALTER TABLE bots ADD COLUMN bid_increment INTEGER NOT NULL DEFAULT 10');
    }
    if (!botColumns.some(column => column.name === 'max_above_opening')) {
      this.db.exec('ALTER TABLE bots ADD COLUMN max_above_opening INTEGER');
    }
  }
  one(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settings() {
    return this.one('SELECT name,default_budget,auto_finalize FROM settings WHERE id=1');
  }
  user(id) {
    const user = this.one('SELECT id,name,email,email AS identifier,role,budget,disabled,created_at FROM users WHERE id=?', id);
    check(user && !user.disabled, 'Account unavailable', 401);
    return user;
  }
  admin(id) {
    const user = this.user(id);
    check(user.role === 'admin', 'Administrator access required', 403);
    return user;
  }
  event(type, actor, detail) {
    this.run('INSERT INTO events(type,actor_id,detail,created_at) VALUES(?,?,?,?)', type, actor, JSON.stringify(detail), this.now());
  }
  balance(id, delta, reason, actor, auction = null) {
    const before = this.one('SELECT budget FROM users WHERE id=?', id).budget;
    integer(before + delta, 0, Number.MAX_SAFE_INTEGER);
    this.run('UPDATE users SET budget=? WHERE id=?', before + delta, id);
    this.run('INSERT INTO ledger(user_id,auction_id,delta,balance,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)', id, auction, delta, before + delta, reason, actor, this.now());
  }
  async createUser(input, actor = null, bootstrap = false) {
    if (!bootstrap) this.admin(actor);
    const name = label(input.name, 100),
      email = identifier(input.identifier ?? input.email);
    const role = input.role || 'user';
    check(['admin', 'user', 'bot'].includes(role), 'Invalid role');
    const password = await hashPassword(input.password || randomBytes(32).toString('hex'));
    return this.transaction(() => {
      if (bootstrap) check(!this.one("SELECT id FROM users WHERE role='admin'"), 'An administrator already exists');else this.admin(actor);
      check(!this.one('SELECT id FROM users WHERE email=?', email), 'Identifier already registered', 409);
      const id = randomUUID(),
        budget = this.settings().default_budget;
      this.run('INSERT INTO users(id,name,email,password,role,budget,created_at) VALUES(?,?,?,?,?,0,?)', id, name, email, password, role, this.now());
      this.balance(id, budget, 'account-created', actor || id);
      if (role === 'bot') this.run('INSERT INTO bots(user_id) VALUES(?)', id);
      this.event('account-created', actor || id, {
        id,
        name,
        role
      });
      return this.user(id);
    });
  }
  async login(email, password) {
    const user = this.one('SELECT * FROM users WHERE email=?', String(email).toLowerCase().trim());
    // An unknown account still performs a password derivation.
    const valid = await verifyPassword(password, user?.password || `00000000000000000000000000000000:${'00'.repeat(64)}`);
    check(valid && user && !user.disabled && user.role !== 'bot', 'Email or password incorrect', 401);
    this.user(user.id);
    check(this.one('SELECT password FROM users WHERE id=?', user.id).password === user.password, 'Credentials changed. Please sign in again.', 401);
    const token = randomBytes(32).toString('hex');
    this.run('INSERT INTO sessions(token,user_id,expires_at,seen_at,admin_unlocked) VALUES(?,?,?,?,0)', digest(token), user.id, this.now() + 8 * 3600000, this.now());
    this.event('login', user.id, {});
    return {
      token,
      user: this.user(user.id)
    };
  }
  emailLogin(value, developer = false) {
    return this.identifierLogin(value, developer);
  }
  identifierLogin(value, developer = false) {
    return this.identifierSession(value, developer, false);
  }
  registerIdentifier(value) {
    return this.identifierSession(value, false, true);
  }
  identifierSession(value, developer, registering) {
    // Keep the legacy unique column so existing accounts, sessions and ledger references survive unchanged.
    const email = identifier(value);
    check(developer || email !== 'dev-admin@market.invalid', 'Use the local development sign-in button for this account', 403);
    return this.transaction(() => {
      let user = this.one('SELECT * FROM users WHERE email=?', email);
      check(!registering || !user, 'This identifier is already registered. Please sign in.', 409);
      check(user || registering || developer, 'This identifier is not registered. Please register first.', 403);
      if (!user) {
        const id = randomUUID(), role = developer ? 'admin' : 'user';
        const unusedCredential = `${randomBytes(16).toString('hex')}:${randomBytes(64).toString('hex')}`;
        this.run('INSERT INTO users(id,name,email,password,role,budget,created_at) VALUES(?,?,?,?,?,0,?)', id, developer ? 'Development admin' : email, email, unusedCredential, role, this.now());
        this.balance(id, this.settings().default_budget, 'account-created', id);
        this.event('account-created', id, { id, role, source: developer ? 'development' : 'identifier-signup' });
        user = this.user(id);
      }
      check(!user.disabled && user.role !== 'bot', 'Account unavailable', 403);
      check(!developer || user.role === 'admin', 'Development account already exists without admin access', 409);
      const token = randomBytes(32).toString('hex');
      this.run('INSERT INTO sessions(token,user_id,expires_at,seen_at,admin_unlocked) VALUES(?,?,?,?,0)', digest(token), user.id, this.now() + 8 * 3600000, this.now());
      this.event(developer ? 'development-login' : 'identifier-login', user.id, { ownershipVerified: false });
      return { token, user: this.user(user.id) };
    });
  }
  session(token) {
    const session = this.one('SELECT * FROM sessions WHERE token=? AND expires_at>?', digest(token || ''), this.now());
    check(session, 'Please sign in', 401);
    const user = this.user(session.user_id);
    return user;
  }
  adminAccess(token) {
    const session = this.one('SELECT * FROM sessions WHERE token=? AND expires_at>?', digest(token || ''), this.now());
    check(session, 'Please sign in', 401);
    const user = this.admin(session.user_id);
    return { user, unlocked: Boolean(session.admin_unlocked) };
  }
  unlockAdminSession(token) {
    const access = this.adminAccess(token);
    this.run('UPDATE sessions SET admin_unlocked=1,seen_at=? WHERE token=?', this.now(), digest(token));
    this.event('admin-zone-unlocked', access.user.id, {});
    return { unlocked: true };
  }
  adminSession(token) {
    const access = this.adminAccess(token);
    check(access.unlocked, 'Admin Zone password required', 403);
    return access.user;
  }
  heartbeat(token) {
    const user = this.session(token);
    this.run('UPDATE sessions SET seen_at=? WHERE token=?', this.now(), digest(token));
    return user;
  }
  logout(token) {
    this.run('DELETE FROM sessions WHERE token=?', digest(token || ''));
  }
  active() {
    return this.all('SELECT id,description,seller_id,minimum,end_at,highest,winner_id FROM auctions WHERE finalized_at IS NULL AND end_at>? ORDER BY end_at,id', this.now());
  }
  snapshot(reason) {
    this.run('INSERT INTO snapshots(reason,state,created_at) VALUES(?,?,?)', reason, JSON.stringify(this.active()), this.now());
  }
  auctions() {
    return this.all(`SELECT a.id,a.description,a.seller_id,u.email seller,u.email seller_identifier,a.minimum,a.end_at,a.highest,a.winner_id,a.finalized_at,a.created_at,
      (SELECT COUNT(DISTINCT user_id) FROM bids b WHERE b.auction_id=a.id) bidders FROM auctions a JOIN users u ON u.id=a.seller_id ORDER BY a.created_at DESC,a.id`);
  }
  auction(id, actor) {
    this.user(actor);
    const item = this.auctions().find(a => a.id === id);
    check(item, 'Auction not found', 404);
    const bids = this.all('SELECT b.*,u.name bidder FROM bids b JOIN users u ON u.id=b.user_id WHERE auction_id=? ORDER BY b.rowid', id);
    const payload = item.finalized_at && item.winner_id === actor ? this.one('SELECT payload FROM auctions WHERE id=?', id).payload : undefined;
    return {
      ...item,
      bids,
      payload,
      my_bid: bids.filter(b => b.user_id === actor).reduce((sum, b) => sum + b.amount, 0)
    };
  }
  createAuction(input, actor) {
    return this.transaction(() => this.insertAuction(input, actor));
  }
  inspectAuction(id, actor, adminOnly = true) {
    if (adminOnly) this.admin(actor); else this.user(actor);
    const record = this.one('SELECT * FROM auctions WHERE id=?', id);
    check(record, 'Auction not found', 404);
    check(adminOnly || record.seller_id === actor, 'Only the seller can edit this auction', 403);
    const bids = this.all('SELECT b.*,u.email AS identifier FROM bids b JOIN users u ON u.id=b.user_id WHERE auction_id=? ORDER BY b.rowid', id);
    return {
      record, revision: digest(JSON.stringify(record)), bids,
      seller_identifier: this.one('SELECT email FROM users WHERE id=?', record.seller_id).email,
      ledger: adminOnly ? this.all('SELECT * FROM ledger WHERE auction_id=? ORDER BY id', id) : [],
      events: adminOnly ? this.all("SELECT * FROM events WHERE json_extract(detail,'$.id')=? ORDER BY id DESC LIMIT 100", id) : [],
      editable: !bids.length && !record.finalized_at && record.end_at > this.now()
    };
  }
  editAuction(id, input, actor, adminOnly = true) {
    if (adminOnly) this.admin(actor); else this.user(actor);
    return this.transaction(() => {
      const current = this.inspectAuction(id, actor, adminOnly);
      check(input.revision === current.revision, 'Auction changed. Reload the record before saving.', 409);
      check(current.editable, 'Only open auctions without bids can be edited. Bid and payment history cannot be rewritten.', 409);
      check(Object.keys(input).every(key => ['revision', 'description', 'payload', 'minimum', 'end_at'].includes(key)), 'Unsupported database field');
      const description = label(input.description, 300), payload = label(input.payload, 50000);
      const minimum = integer(input.minimum), end = integer(input.end_at, this.now() + 1000, this.now() + 30 * 60000);
      this.run('UPDATE auctions SET description=?,payload=?,minimum=?,end_at=? WHERE id=?', description, payload, minimum, end, id);
      this.event('auction-edited', actor, { id, before: { description: current.record.description, minimum: current.record.minimum, end_at: current.record.end_at }, after: { description, minimum, end_at: end }, payloadChanged: payload !== current.record.payload });
      this.snapshot('auction-edited');
      return this.inspectAuction(id, actor, adminOnly);
    });
  }
  insertAuction(input, actor) {
    this.user(actor);
    const description = label(input.description ?? input.dataDescription, 300),
      payload = label(input.payload ?? input.dataForSell, 50000);
    const minimum = integer(input.minimum ?? input.minimumContribution),
      minutes = integer(input.minutes ?? input.auctionDuration, 1, 30);
    const id = randomUUID();
    this.run('INSERT INTO auctions(id,seller_id,description,payload,minimum,end_at,created_at) VALUES(?,?,?,?,?,?,?)', id, actor, description, payload, minimum, this.now() + minutes * 60000, this.now());
    this.event('auction-opened', actor, {
      id,
      description,
      minimum,
      minutes
    });
    this.snapshot('auction-opened');
    return {
      id
    };
  }
  batch(inputs, actor) {
    this.admin(actor);
    check(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 50, 'Batch must contain 1-50 auctions');
    return this.transaction(() => inputs.map(input => this.insertAuction(input, actor)));
  }
  bid(id, amount, actor, key) {
    integer(amount);
    check(typeof key === 'string' && /^[\w-]{8,100}$/.test(key), 'An idempotency key is required');
    return this.transaction(() => {
      const user = this.user(actor),
        fingerprint = `${id}:${amount}`;
      const previous = this.one('SELECT * FROM requests WHERE user_id=? AND key=?', actor, key);
      if (previous) {
        check(previous.fingerprint === fingerprint, 'Request key reused with different data', 409);
        return JSON.parse(previous.response);
      }
      const a = this.one('SELECT * FROM auctions WHERE id=?', id);
      check(a, 'Auction not found', 404);
      check(!a.finalized_at && a.end_at > this.now(), 'Auction has ended', 409);
      check(a.seller_id !== actor, 'You cannot bid on your own auction', 403);
      const own = this.one('SELECT COALESCE(SUM(amount),0) total FROM bids WHERE auction_id=? AND user_id=?', id, actor).total;
      const target = integer(own + amount);
      check(target >= a.minimum && target > a.highest, 'Bid must meet the minimum and exceed the highest bid', 409);
      const cost = a.winner_id === actor ? amount : target;
      check(user.budget >= cost, 'Insufficient available budget', 409);
      if (a.winner_id && a.winner_id !== actor) this.balance(a.winner_id, a.highest, 'outbid-release', actor, id);
      this.balance(actor, -cost, 'bid-reservation', actor, id);
      const bid = {
        id: randomUUID(),
        auction_id: id,
        user_id: actor,
        amount,
        cumulative: target,
        budget_before: user.budget,
        budget_after: user.budget - cost,
        created_at: this.now()
      };
      this.run('INSERT INTO bids VALUES(?,?,?,?,?,?,?,?)', ...Object.values(bid));
      this.run('UPDATE auctions SET highest=?,winner_id=? WHERE id=?', target, actor, id);
      this.event('bid-accepted', actor, bid);
      this.snapshot('bid-accepted');
      this.run('INSERT INTO requests VALUES(?,?,?,?)', actor, key, fingerprint, JSON.stringify(bid));
      return bid;
    });
  }
  finalize(id, actor) {
    return this.transaction(() => {
      const a = this.one('SELECT * FROM auctions WHERE id=?', id);
      check(a, 'Auction not found', 404);
      check(a.end_at <= this.now(), 'Auction is still open', 409);
      if (a.finalized_at) return {
        id,
        alreadyFinalized: true
      };
      if (a.highest) this.balance(a.seller_id, a.highest, 'seller-payment', actor, id);
      this.run('UPDATE auctions SET finalized_at=? WHERE id=?', this.now(), id);
      this.event('auction-finalized', actor, {
        id,
        amount: a.highest,
        seller: a.seller_id,
        winner: a.winner_id
      });
      this.snapshot('auction-finalized');
      return {
        id,
        amount: a.highest
      };
    });
  }
  closeAuction(id, actor) {
    this.admin(actor);
    return this.transaction(() => {
      check(this.one('SELECT id FROM auctions WHERE id=?', id), 'Auction not found', 404);
      this.run('UPDATE auctions SET end_at=MIN(end_at,?) WHERE id=?', this.now(), id);
      this.event('auction-closed-by-admin', actor, {
        id
      });
      this.snapshot('auction-closed');
      return {
        id
      };
    });
  }
  configure(input, actor) {
    this.admin(actor);
    return this.transaction(() => {
      const current = this.settings();
      const name = label(input.name ?? current.name, 100),
        budget = integer(input.default_budget ?? current.default_budget);
      check(input.auto_finalize === undefined || typeof input.auto_finalize === 'boolean', 'Invalid finalizer setting');
      this.run('UPDATE settings SET name=?,default_budget=?,auto_finalize=? WHERE id=1', name, budget, Number(input.auto_finalize ?? Boolean(current.auto_finalize)));
      this.event('market-configured', actor, this.settings());
      return this.settings();
    });
  }
  setBudget(id, total, actor) {
    this.admin(actor);
    integer(total, 0);
    return this.transaction(() => {
      const user = this.user(id);
      const held = this.one('SELECT COALESCE(SUM(highest),0) n FROM auctions WHERE winner_id=? AND finalized_at IS NULL', id).n;
      check(total >= held, `Budget cannot be lower than ${held} reserved credits`, 409);
      this.balance(id, total - held - user.budget, 'admin-budget-set', actor);
      this.event('budget-set', actor, {
        id,
        total,
        held
      });
      return this.user(id);
    });
  }
  disable(id, disabled, actor) {
    this.admin(actor);
    check(id !== actor, 'You cannot disable your own account');
    check(typeof disabled === 'boolean', 'Invalid account state');
    check(this.one('SELECT id FROM users WHERE id=?', id), 'Account not found', 404);
    this.run('UPDATE users SET disabled=? WHERE id=?', Number(disabled), id);
    this.run('DELETE FROM sessions WHERE user_id=?', id);
    if (disabled) this.run('UPDATE bots SET running=0 WHERE user_id=?', id);
    this.event('account-disabled', actor, {
      id,
      disabled
    });
    return {
      id,
      disabled
    };
  }
  resetBudgets(total, actor) {
    this.admin(actor);
    integer(total);
    return this.transaction(() => {
      const users = this.all('SELECT id,budget FROM users');
      for (const user of users) {
        const held = this.one('SELECT COALESCE(SUM(highest),0) n FROM auctions WHERE winner_id=? AND finalized_at IS NULL', user.id).n;
        check(total >= held, 'A user has more reserved credits than this budget. No budgets were changed.', 409);
        this.balance(user.id, total - held - user.budget, 'admin-global-budget-reset', actor);
      }
      this.run('UPDATE settings SET default_budget=? WHERE id=1', total);
      this.event('global-budget-reset', actor, {
        total,
        users: users.length
      });
      return {
        total,
        users: users.length
      };
    });
  }
  async changePassword(id, password, actor, currentPassword) {
    const acting = this.user(actor);
    const target = this.one('SELECT * FROM users WHERE id=?', id);
    check(target && target.role !== 'bot', 'Account not found', 404);
    check(acting.role === 'admin' || actor === id, 'Access denied', 403);
    if (actor === id) check(await verifyPassword(currentPassword, target.password), 'Current password is incorrect', 403);
    const hash = await hashPassword(password);
    return this.transaction(() => {
      this.user(actor);
      check(this.one('SELECT password FROM users WHERE id=?', id).password === target.password, 'Password changed. Please retry.', 409);
      this.run('UPDATE users SET password=? WHERE id=?', hash, id);
      this.run('DELETE FROM sessions WHERE user_id=?', id);
      this.event('password-changed', actor, {
        id
      });
      return {
        ok: true
      };
    });
  }
  botSettings(id, input, actor) {
    this.admin(actor);
    check(this.one('SELECT user_id FROM bots WHERE user_id=?', id), 'Bot not found', 404);
    const current = this.one('SELECT * FROM bots WHERE user_id=?', id);
    const interval = integer(input.interval_seconds ?? current.interval_seconds, 10, 3600);
    const maxBids = integer(input.max_bids ?? current.max_bids, 1, 5),
      maxBid = integer(input.max_bid ?? current.max_bid),
      bidIncrement = integer(input.bid_increment ?? current.bid_increment, 1, LIMIT);
    const openingCapInput = input.max_above_opening === undefined ? current.max_above_opening : input.max_above_opening;
    const maxAboveOpening = openingCapInput === null ? null : integer(openingCapInput, 0, LIMIT);
    const running = input.running ?? Boolean(current.running),
      enabled = input.enabled ?? Boolean(current.enabled);
    check(typeof running === 'boolean' && typeof enabled === 'boolean', 'Invalid bot state');
    if (running) this.user(id);
    this.run('UPDATE bots SET interval_seconds=?,max_bids=?,max_bid=?,bid_increment=?,max_above_opening=?,running=?,enabled=?,next_at=? WHERE user_id=?', interval, maxBids, maxBid, bidIncrement, maxAboveOpening, Number(running && enabled), Number(enabled), this.now(), id);
    this.event('bot-configured', actor, {
      id,
      interval,
      maxBids,
      maxBid,
      bidIncrement,
      maxAboveOpening,
      running,
      enabled
    });
    return {
      id
    };
  }
  removeBot(id, actor) {
    this.admin(actor);
    const bot = this.one('SELECT b.user_id,u.name FROM bots b JOIN users u ON u.id=b.user_id WHERE b.user_id=?', id);
    check(bot, 'Bot not found', 404);
    return this.transaction(() => {
      this.run('UPDATE bots SET running=0,enabled=0,next_at=0 WHERE user_id=?', id);
      this.run('UPDATE users SET disabled=1 WHERE id=?', id);
      this.event('bot-retired', actor, { id, name: bot.name });
      return { id, retired: true };
    });
  }
  runBots(force = false, onlyBot = null) {
    const started = this.now();
    const params = [];
    let conditions = 'u.disabled=0 AND b.enabled=1';
    if (!force) {
      conditions += ' AND b.running=1 AND b.next_at<=?';
      params.push(started);
    }
    if (onlyBot) {
      conditions += ' AND b.user_id=?';
      params.push(onlyBot);
    }
    const bots = this.all(`SELECT b.* FROM bots b JOIN users u ON u.id=b.user_id WHERE ${conditions} ORDER BY b.next_at,b.user_id`, ...params);
    if (!bots.length) return null;
    const active = this.active(),
      assigned = new Set(),
      decisions = [];
    // Rotate both cohorts and auction candidates; all bots share one active-only read.
    const roundNumber = this.one('SELECT COUNT(*) n FROM rounds').n;
    const rotate = items => items.length ? [...items.slice(roundNumber % items.length), ...items.slice(0, roundNumber % items.length)] : [];
    for (const bot of rotate(bots)) {
      let sent = 0;
      for (const a of rotate(active)) {
        if (sent >= bot.max_bids) break;
        if (assigned.has(a.id) || a.seller_id === bot.user_id || a.winner_id === bot.user_id || a.end_at - this.now() < 20000) continue;
        const target = Math.max(a.minimum, a.highest + bot.bid_increment);
        const strategyMaximum = bot.max_above_opening === null ? bot.max_bid : Math.min(bot.max_bid, a.minimum + bot.max_above_opening);
        if (target > strategyMaximum || target > this.user(bot.user_id).budget) continue;
        const own = this.one('SELECT COALESCE(SUM(amount),0) n FROM bids WHERE auction_id=? AND user_id=?', a.id, bot.user_id).n;
        assigned.add(a.id);
        try {
          const result = this.bid(a.id, target - own, bot.user_id, randomUUID());
          decisions.push({
            bot: bot.user_id,
            auction: a.id,
            outcome: 'sent',
            bid: result.id
          });
          sent++;
        } catch (error) {
          decisions.push({
            bot: bot.user_id,
            auction: a.id,
            outcome: 'failed',
            reason: error.message
          });
        }
      }
      if (!sent) decisions.push({
        bot: bot.user_id,
        outcome: 'skipped',
        reason: 'No eligible unassigned auction within budget and bid limit'
      });
      this.run('UPDATE bots SET next_at=?,last_seen=?,cycles=cycles+1,sent=sent+? WHERE user_id=?', this.now() + bot.interval_seconds * 1000, this.now(), sent, bot.user_id);
    }
    const detail = {
      duration: this.now() - started,
      active: active.length,
      bots: bots.length,
      sent: decisions.filter(d => d.outcome === 'sent').length,
      decisions
    };
    this.run('INSERT INTO rounds(detail,created_at) VALUES(?,?)', JSON.stringify(detail), this.now());
    return detail;
  }
  tick() {
    const ended = this.all('SELECT id FROM auctions WHERE end_at<=? AND end_recorded=0', this.now());
    if (ended.length) this.transaction(() => {
      for (const a of ended) {
        this.run('UPDATE auctions SET end_recorded=1 WHERE id=?', a.id);
        this.event('auction-ended', 'system', a);
      }
      this.snapshot('auction-ended');
    });
    if (this.settings().auto_finalize) for (const a of this.all('SELECT id FROM auctions WHERE end_at<=? AND finalized_at IS NULL', this.now())) this.finalize(a.id, 'system');
    this.runBots();
    this.run('DELETE FROM sessions WHERE expires_at<=?', this.now());
    const last = this.one('SELECT created_at FROM activity ORDER BY id DESC LIMIT 1');
    if (!last || this.now() - last.created_at >= 15000) this.run('INSERT INTO activity(detail,created_at) VALUES(?,?)', JSON.stringify(this.presence()), this.now());
  }
  presence() {
    const rows = this.all('SELECT DISTINCT u.id,u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.seen_at>? AND s.expires_at>? AND u.disabled=0', this.now() - 45000, this.now());
    return {
      users: rows.filter(u => u.role === 'user').length,
      admins: rows.filter(u => u.role === 'admin').length,
      bots: this.one('SELECT COUNT(*) n FROM bots WHERE running=1 AND enabled=1 AND last_seen>0 AND next_at>=?', this.now() - 5000).n,
      auctions: this.active().length
    };
  }
  adminState(actor) {
    this.admin(actor);
    return {
      users: this.all('SELECT id,name,email,email AS identifier,role,budget,disabled FROM users'),
      bots: this.all('SELECT b.*,u.name FROM bots b JOIN users u ON u.id=b.user_id WHERE u.disabled=0 ORDER BY u.created_at,b.user_id'),
      rounds: this.all('SELECT * FROM rounds ORDER BY id DESC LIMIT 30').map(r => ({
        ...r,
        detail: JSON.parse(r.detail)
      })),
      events: this.all('SELECT * FROM events ORDER BY id DESC LIMIT 100').map(e => ({
        ...e,
        detail: JSON.parse(e.detail)
      })),
      active: this.active(),
      presence: this.presence(),
      settings: this.settings()
    };
  }
  report(actor) {
    this.admin(actor);
    return this.transaction(() => {
      this.snapshot('report-generated');
      return {
        version: 1,
        mode: 'backend',
        unit: 'credits',
        generatedAt: this.now(),
        settings: this.settings(),
        users: this.all('SELECT id,name,email AS identifier,role,budget,disabled FROM users'),
        auctions: this.auctions(),
        bids: this.all('SELECT * FROM bids ORDER BY rowid'),
        ledger: this.all('SELECT * FROM ledger ORDER BY id'),
        events: this.all('SELECT * FROM events ORDER BY id'),
        snapshots: this.all('SELECT * FROM snapshots ORDER BY id').map(s => ({
          ...s,
          state: JSON.parse(s.state)
        })),
        rounds: this.all('SELECT * FROM rounds ORDER BY id').map(r => ({
          ...r,
          detail: JSON.parse(r.detail)
        })),
        activity: this.all('SELECT * FROM activity ORDER BY id').map(r => ({
          ...r,
          detail: JSON.parse(r.detail)
        })),
        presence: this.presence()
      };
    });
  }
  listStateAt(time, actor) {
    this.admin(actor);
    integer(time, 0, Number.MAX_SAFE_INTEGER);
    const state = this.one('SELECT * FROM snapshots WHERE created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1', time);
    return state ? {
      ...state,
      state: JSON.parse(state.state),
      requestedAt: time
    } : {
      state: [],
      requestedAt: time,
      reason: 'No recorded state at this time'
    };
  }
  close() {
    this.db.close();
  }
}
module.exports = {
  MarketStore,
  MarketError,
  check,
  integer
};
