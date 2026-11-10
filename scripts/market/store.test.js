const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const {
  randomUUID
} = require('node:crypto');
const {
  mkdtempSync,
  rmSync
} = require('node:fs');
const {
  tmpdir
} = require('node:os');
const {
  join
} = require('node:path');
const {
  MarketStore
} = require('./store');
const password = 'a-long-test-password';
async function fixture(t, file) {
  let now = 1000000;
  const s = new MarketStore(file, () => now);
  t.after(() => s.close());
  const admin = await s.createUser({
    name: 'Admin',
    email: 'admin@example.com',
    password,
    role: 'admin'
  }, null, true);
  const make = (name, role = 'user') => s.createUser({
    name,
    email: `${name}@example.com`,
    password,
    role
  }, admin.id);
  const seller = await make('seller'),
    a = await make('a'),
    b = await make('b');
  const auction = (minutes = 1) => s.createAuction({
    description: 'Dataset',
    payload: 'private payload',
    minimum: 50,
    minutes
  }, seller.id).id;
  return {
    s,
    admin,
    seller,
    a,
    b,
    auction,
    make,
    advance: ms => {
      now += ms;
    }
  };
}
test('bidding history shows the configured bot name and the human identifier', async t => {
  const { s, admin, seller, a, auction } = await fixture(t);
  const bot = await s.createUser({ name: 'Dana', email: 'generated@bot.invalid', role: 'bot' }, admin.id);
  const id = auction();
  s.bid(id, 50, bot.id, randomUUID());
  s.bid(id, 60, a.id, randomUUID());
  assert.deepEqual(s.auction(id, seller.id).bids.map(bid => bid.bidder), ['Dana', 'a@example.com']);
});
test('cumulative bids reserve full amount, release old winner, finalize exactly once', async t => {
  const {
    s,
    a,
    b,
    seller,
    auction,
    advance
  } = await fixture(t);
  const id = auction();
  s.bid(id, 100, a.id, randomUUID());
  assert.equal(s.user(a.id).budget, 1900);
  s.bid(id, 150, b.id, randomUUID());
  assert.equal(s.user(a.id).budget, 2000);
  const bid = s.bid(id, 100, a.id, randomUUID());
  assert.equal(bid.cumulative, 200);
  assert.equal(bid.budget_after, 1800);
  assert.equal(s.user(b.id).budget, 2000);
  assert.equal(s.auction(id, b.id).payload, undefined);
  advance(60000);
  s.tick();
  s.finalize(id, a.id);
  assert.equal(s.user(seller.id).budget, 2200);
  assert.equal(s.auction(id, a.id).payload, 'private payload');
  assert.equal(s.all("SELECT * FROM ledger WHERE reason='seller-payment'").length, 1);
});
test('reject own bid, insufficient budget, exact end boundary and malformed values', async t => {
  const {
    s,
    a,
    seller,
    auction,
    advance
  } = await fixture(t);
  const id = auction();
  assert.throws(() => s.bid(id, 50, seller.id, randomUUID()), /own auction/);
  assert.throws(() => s.bid(id, 2001, a.id, randomUUID()), /Insufficient/);
  assert.throws(() => s.bid(id, NaN, a.id, randomUUID()), /integer/);
  advance(60000);
  assert.throws(() => s.bid(id, 50, a.id, randomUUID()), /ended/);
});
test('idempotency prevents double bids and rejects conflicting retry', async t => {
  const {
    s,
    a,
    auction
  } = await fixture(t);
  const id = auction(),
    key = randomUUID();
  assert.deepEqual(s.bid(id, 50, a.id, key), s.bid(id, 50, a.id, key));
  assert.throws(() => s.bid(id, 100, a.id, key), /reused/);
  assert.deepEqual(s.auction(id, a.id).bids, []);
  assert.equal(s.auction(id, a.id).my_bid, 50);
});
test('budget adjustment includes reservations and cannot create a release windfall', async t => {
  const {
    s,
    a,
    b,
    admin,
    auction
  } = await fixture(t);
  const id = auction();
  s.bid(id, 500, a.id, randomUUID());
  assert.throws(() => s.setBudget(a.id, 499, admin.id), /reserved/);
  s.setBudget(a.id, 600, admin.id);
  assert.equal(s.user(a.id).budget, 100);
  s.bid(id, 510, b.id, randomUUID());
  assert.equal(s.user(a.id).budget, 600);
});
test('authentication, authorization, expiry and disabled-account session revocation', async t => {
  const {
    s,
    a,
    admin,
    advance
  } = await fixture(t);
  await assert.rejects(s.login(a.email, 'wrong'), /incorrect/);
  const login = await s.login(a.email, password);
  assert.equal(s.session(login.token).id, a.id);
  assert.throws(() => s.adminState(a.id), /Administrator/);
  const system = s.adminState(admin.id).system;
  assert.equal(system.runtime.status, 'online');
  assert.equal(system.database.engine, 'SQLite');
  assert.equal(system.database.path, ':memory:');
  assert.equal(system.database.journal_mode, 'memory');
  assert.equal(system.database.foreign_keys, true);
  assert.equal(system.scheduler.tick_interval_ms, 1000);
  assert.equal(system.counts.users, 4);
  assert.equal(system.counts.auctions, 0);
  s.disable(a.id, true, admin.id);
  assert.throws(() => s.session(login.token), /sign in|unavailable/);
  s.disable(a.id, false, admin.id);
  const next = await s.login(a.email, password);
  advance(8 * 3600000);
  assert.throws(() => s.session(next.token), /sign in/);
});
test('batch is atomic and rollback does not expose payload in reports', async t => {
  const {
    s,
    admin
  } = await fixture(t);
  const input = {
    description: 'Batch',
    payload: 'TOPSECRET',
    minimum: 50,
    minutes: 1
  };
  assert.throws(() => s.batch([input, {
    ...input,
    minutes: 31
  }], admin.id));
  assert.equal(s.auctions().length, 0);
  s.batch([input], admin.id);
  const ogCreated = s.insertAuction({
    dataDescription: 'OG format auction',
    dataForSell: 'OG payload',
    minimumContribution: '100',
    auctionDuration: '10'
  }, admin.id);
  assert.equal(s.auction(ogCreated.id, admin.id).minimum, 100);
  const report = s.report(admin.id);
  assert(!JSON.stringify(report).includes('TOPSECRET'));
  assert(!JSON.stringify(report).includes(password));
  assert(report.snapshots.some(s => s.reason === 'report-generated'));
});
test('100 bots, 1000 ended auctions, 50 active: distinct assignments and active-only planning', async t => {
  const {
    s,
    admin,
    auction,
    advance,
    make
  } = await fixture(t);
  for (let i = 0; i < 1000; i++) auction();
  advance(60001);
  s.tick();
  for (let i = 0; i < 50; i++) auction(30);
  for (let i = 0; i < 100; i++) {
    const bot = await make(`bot${i}`, 'bot');
    s.botSettings(bot.id, {
      running: true
    }, admin.id);
  }
  const round = s.runBots();
  assert.equal(round.active, 50);
  assert.equal(round.sent, 50);
  const assignments = round.decisions.filter(d => d.auction).map(d => d.auction);
  assert.equal(new Set(assignments).size, assignments.length);
  assert.equal(s.runBots(), null);
  for (const b of s.all('SELECT user_id FROM bots')) s.botSettings(b.user_id, {
    running: false
  }, admin.id);
  advance(60000);
  assert.equal(s.runBots(), null);
  for (const u of s.all('SELECT budget FROM users')) assert(u.budget >= 0);
});
test('bot command controls run one bot and retire it without deleting audit evidence', async t => {
  const { s, admin, auction, make } = await fixture(t);
  const botA = await make('controlled-bot-a', 'bot');
  const botB = await make('controlled-bot-b', 'bot');
  auction(30);
  auction(30);
  s.botSettings(botA.id, { running: true }, admin.id);
  s.botSettings(botB.id, { running: true }, admin.id);

  const round = s.runBots(true, botA.id);
  assert.equal(round.bots, 1);
  assert(round.decisions.every(decision => decision.bot === botA.id));
  assert.equal(s.one('SELECT cycles FROM bots WHERE user_id=?', botA.id).cycles, 1);
  assert.equal(s.one('SELECT cycles FROM bots WHERE user_id=?', botB.id).cycles, 0);

  const removed = s.removeBot(botA.id, admin.id);
  assert.deepEqual(removed, { id: botA.id, retired: true });
  assert.equal(s.one('SELECT disabled FROM users WHERE id=?', botA.id).disabled, 1);
  assert.equal(s.one('SELECT running FROM bots WHERE user_id=?', botA.id).running, 0);
  assert(!s.adminState(admin.id).bots.some(bot => bot.user_id === botA.id));
  assert.equal(s.one("SELECT COUNT(*) n FROM events WHERE type='bot-retired'").n, 1);
  assert.equal(s.one('SELECT COUNT(*) n FROM rounds').n, 1);
});
test('bots use independent budgets, one cheapest-eligible auction per round, and a fixed ten-point step', async t => {
  const { s, admin, a, auction, make } = await fixture(t);
  const bot = await make('budgeted-cheapest-bot', 'bot');
  const id = auction(30);
  s.botSettings(bot.id, {
    running: true,
    budget: 75
  }, admin.id);

  const firstRound = s.runBots(true, bot.id);
  assert.equal(firstRound.sent, 1);
  assert.equal(s.auction(id, admin.id).highest, 50);
  assert.equal(s.user(bot.id).budget, 25);

  s.bid(id, 70, a.id, randomUUID());
  const overBudgetRound = s.runBots(true, bot.id);
  assert.equal(overBudgetRound.sent, 0);
  assert.equal(s.auction(id, admin.id).highest, 70);
  assert.match(overBudgetRound.decisions[0].reason, /budget/);

  s.botSettings(bot.id, { budget: 100 }, admin.id);
  const fundedRound = s.runBots(true, bot.id);
  assert.equal(fundedRound.sent, 1);
  assert.equal(s.auction(id, admin.id).highest, 80);
  assert.equal(s.user(bot.id).budget, 20);
});

test('bots choose cheapest current prices, randomize only ties, and reconsider after price changes', async t => {
  const { s, admin, seller, a, make } = await fixture(t);
  const bot = await make('cheapest-bot', 'bot');
  const create = minimum => s.createAuction({ description: 'Dataset', payload: 'private', minimum, minutes: 30 }, seller.id).id;
  const formerlyCheap = create(1);
  s.bid(formerlyCheap, 500, a.id, randomUUID());
  const cheap = create(50);
  const tied = create(50);
  const expensive = create(70);
  const round = s.runBots(true, bot.id);
  assert.equal(round.sent, 1);
  assert([cheap, tied].includes(round.decisions[0].auction));
  s.bid(cheap, 100, a.id, randomUUID());
  s.bid(tied, 100, a.id, randomUUID());
  assert.equal(s.runBots(true, bot.id).decisions[0].auction, expensive);
});

test('bots preserve the ten-point opening floor and still skip their own auctions', async t => {
  const { s, admin, seller, make } = await fixture(t);
  const bot = await make('small-budget-bot', 'bot');
  s.createAuction({ description: 'Own dataset', payload: 'private', minimum: 1, minutes: 30 }, bot.id);
  const id = s.createAuction({ description: 'Other dataset', payload: 'private', minimum: 5, minutes: 30 }, seller.id).id;
  s.botSettings(bot.id, { budget: 5 }, admin.id);
  assert.equal(s.runBots(true, bot.id).sent, 0);
  s.botSettings(bot.id, { budget: 10 }, admin.id);
  const round = s.runBots(true, bot.id);
  assert.equal(round.sent, 1);
  assert.equal(round.decisions[0].auction, id);
  assert.equal(s.user(bot.id).budget, 0);
});
test('restart preserves bids, balances and idempotency', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'market-test-'));
  t.after(() => rmSync(dir, {
    recursive: true,
    force: true
  }));
  const file = join(dir, 'test.sqlite');
  const s = new MarketStore(file);
  const admin = await s.createUser({
    name: 'admin',
    email: 'a@a.com',
    password,
    role: 'admin'
  }, null, true);
  const bidder = await s.createUser({
    name: 'bidder',
    email: 'b@b.com',
    password
  }, admin.id);
  const id = s.createAuction({
      description: 'Data',
      payload: 'private',
      minimum: 1,
      minutes: 30
    }, admin.id).id,
    key = randomUUID();
  const first = s.bid(id, 50, bidder.id, key);
  s.close();
  const next = new MarketStore(file);
  try {
    assert.deepEqual(next.bid(id, 50, bidder.id, key), first);
    assert.equal(next.user(bidder.id).budget, 1950);
  } finally {
    next.close();
  }
});
test('ledger is immutable and reports preserve close boundaries', async t => {
  const {
    s,
    admin,
    auction,
    advance
  } = await fixture(t);
  const id = auction();
  assert.throws(() => s.run('DELETE FROM ledger'), /immutable/);
  advance(60000);
  s.tick();
  const report = s.report(admin.id);
  assert(report.snapshots.some(r => r.reason === 'auction-opened' && r.state.some(a => a.id === id)));
  assert(report.snapshots.some(r => r.reason === 'auction-ended' && !r.state.some(a => a.id === id)));
});
test('global reset rolls back every user when an active reservation exceeds target', async t => {
  const {
    s,
    admin,
    a,
    auction
  } = await fixture(t);
  s.bid(auction(), 1000, a.id, randomUUID());
  const before = s.all('SELECT id,budget FROM users');
  assert.throws(() => s.resetBudgets(500, admin.id), /No budgets were changed/);
  assert.deepEqual(s.all('SELECT id,budget FROM users'), before);
  s.resetBudgets(1200, admin.id);
  assert.equal(s.user(a.id).budget, 200);
  assert.equal(s.settings().default_budget, 1200);
});
test('password changes revoke sessions, require current password for self and exclude bots', async t => {
  const {
    s,
    a,
    admin,
    make
  } = await fixture(t);
  const login = await s.login(a.email, password);
  await assert.rejects(s.changePassword(a.id, 'new-long-password', a.id, 'wrong'), /incorrect/);
  await s.changePassword(a.id, 'new-long-password', a.id, password);
  assert.throws(() => s.session(login.token), /sign in/);
  await assert.rejects(s.login(a.email, password), /incorrect/);
  assert((await s.login(a.email, 'new-long-password')).token);
  await s.changePassword(a.id, 'admin-reset-password', admin.id);
  const bot = await make('automation', 'bot');
  await assert.rejects(s.login(bot.email, password), /incorrect/);
});
test('historical list lookup chooses latest observation at or before requested time', async t => {
  const {
    s,
    admin,
    auction,
    advance
  } = await fixture(t);
  assert.equal(s.listStateAt(s.now(), admin.id).state.length, 0);
  const id = auction();
  const opened = s.now();
  advance(60000);
  s.tick();
  assert.equal(s.listStateAt(opened, admin.id).state[0].id, id);
  assert.equal(s.listStateAt(s.now(), admin.id).state.length, 0);
});
test('data description must contain a letter, numbers alone are rejected', async t => {
  const { s, seller, admin } = await fixture(t);
  const create = (description, payload = '39') => s.createAuction({ description, payload, minimum: 50, minutes: 1 }, seller.id);
  for (const ok of ['my shoe size is 39', 'מידה 39', 'Größe 39', '39 cm', '一二三']) assert.ok(create(ok).id, ok);
  for (const bad of ['39', '39.5', '  42  ', '12-34', '٣٩', '３９', '😀', '😀 39', '9'.repeat(100)]) {
    assert.throws(() => create(bad), /words, not only numbers/, bad);
  }
  for (const bad of ['', '   ', 39, null, undefined, '9'.repeat(301)]) {
    assert.throws(() => create(bad), /Text is required/, String(bad));
  }
  // the dataDescription field name is validated too
  assert.throws(() => s.createAuction({ dataDescription: '39', payload: 'x', minimum: 50, minutes: 1 }, seller.id), /words, not only numbers/);
  assert.ok(s.createAuction({ dataDescription: 'shoe size', payload: 'x', minimum: 50, minutes: 1 }, seller.id).id);
  // Data For Sell may be numbers only
  assert.ok(create('shoe size', '39').id);
  // a missing or invalid minimum is still rejected by the server
  for (const minimum of ['', '  ', null, undefined, 0, 'abc', 1.5]) {
    assert.throws(() => s.createAuction({ description: 'shoe size', payload: 'p', minimum, minutes: 1 }, seller.id), /Expected an integer/, String(minimum));
  }
  // admin batch create goes through the same rule and is atomic
  assert.throws(() => s.batch([{ description: 'Valid words', payload: 'p', minimum: 50, minutes: 1 }, { description: '123', payload: 'p', minimum: 50, minutes: 1 }], admin.id), /words, not only numbers/);
  assert.equal(s.all("SELECT id FROM auctions WHERE description='Valid words'").length, 0);
});
test('existing numbers-only descriptions keep working, stay editable and biddable', async t => {
  const { s, seller, admin, a } = await fixture(t);
  const legacy = s.createAuction({ description: 'placeholder', payload: 'p', minimum: 50, minutes: 5 }, seller.id).id;
  s.run('UPDATE auctions SET description=? WHERE id=?', '12345', legacy);
  const edited = s.editAuction(legacy, { revision: s.inspectAuction(legacy, admin.id).revision, minimum: 70 }, admin.id);
  assert.equal(edited.record.minimum, 70);
  assert.equal(edited.record.description, '12345');
  const bid = s.bid(legacy, 80, a.id, randomUUID());
  assert.equal(bid.cumulative, 80);
  assert.equal(s.auction(legacy, a.id).description, '12345');
});

// --- cheapest-first bot selection -------------------------------------------
async function botFixture(t, random) {
  const f = await fixture(t);
  if (random) f.s.random = random;
  const mk = (minimum, minutes = 30, seller = f.seller) =>
    f.s.createAuction({ description: 'Dataset', payload: 'p', minimum, minutes }, seller.id).id;
  const bot = async (name, budget = 1000) => {
    const b = await f.make(name, 'bot');
    f.s.botSettings(b.id, { running: true, budget }, f.admin.id);
    return b;
  };
  return { ...f, mk, bot };
}
const picked = round => round.decisions.filter(d => d.auction).map(d => d.auction);

test('bots pick the lowest required next bid regardless of insertion order', async t => {
  const { s, mk, bot } = await botFixture(t);
  mk(90);
  const cheap = mk(50);
  mk(70);
  const b = await bot('b1');
  const round = s.runBots(true, b.id);
  assert.deepEqual(picked(round), [cheap]);
  assert.equal(round.sent, 1);
});

test('ranking uses required next bid (highest+10), not opening minimum', async t => {
  const { s, a, mk, bot } = await botFixture(t);
  const lowOpenHighBid = mk(50), highOpen = mk(80);
  s.bid(lowOpenHighBid, 200, a.id, randomUUID()); // required next bid 210 > 80
  const b = await bot('b2');
  assert.deepEqual(picked(s.runBots(true, b.id)), [highOpen]);
});

test('previous losing bidder is ranked and budget-checked by full cumulative target', async t => {
  const { s, a, admin, mk, bot } = await botFixture(t);
  const x = mk(50), y = mk(60);
  const b = await bot('b3', 100);
  s.bid(x, 50, b.id, randomUUID());
  s.bid(x, 90, a.id, randomUUID()); // b outbid and refunded
  assert.equal(s.user(b.id).budget, 100);
  // Full cumulative target for x is 100 (increment only 50); y at 60 is cheaper.
  assert.deepEqual(picked(s.runBots(true, b.id)), [y]);
  assert.equal(s.user(b.id).budget, 40);
  // Re-fund so exactly 99 is available: x's full cumulative target (100) is not affordable
  s.botSettings(b.id, { budget: 99 + 60 }, admin.id); // reserved 60 held on y => available 99
  assert.equal(s.user(b.id).budget, 99);
  const skipped = s.runBots(true, b.id);
  assert.equal(skipped.sent, 0);
  s.botSettings(b.id, { budget: 100 + 60 }, admin.id); // available 100
  const sent = s.runBots(true, b.id);
  assert.deepEqual(picked(sent), [x]);
  assert.equal(s.auction(x, admin.id).highest, 100);
  assert.equal(s.one('SELECT SUM(amount) n FROM bids WHERE auction_id=? AND user_id=?', x, b.id).n, 100);
  assert.equal(s.user(b.id).budget, 0); // earlier 50 was refunded when outbid, so the full cumulative 100 is re-reserved
});

test('ties are broken randomly among the cheapest candidates only', async t => {
  for (const pick of [0, 1]) {
    const calls = [];
    const { s, mk, bot } = await botFixture(t, n => (calls.push(n), pick));
    mk(50); mk(50); const pricey = mk(60);
    const tied = s.active().filter(x => x.minimum === 50).map(x => x.id);
    const b = await bot(`tie${pick}`);
    const chosen = picked(s.runBots(true, b.id));
    assert.deepEqual(chosen, [tied[pick]]);
    assert.notEqual(chosen[0], pricey);
    assert.deepEqual(calls, [2]); // random range is only the tied set
  }
});

test('a single cheapest candidate is chosen without consulting randomness', async t => {
  const { s, mk, bot } = await botFixture(t, () => { throw new Error('random must not be used'); });
  mk(60);
  const cheap = mk(50);
  const b = await bot('single');
  assert.deepEqual(picked(s.runBots(true, b.id)), [cheap]);
});

test('cheap but ineligible auctions are skipped', async t => {
  const { s, mk, bot, advance } = await botFixture(t);
  const b = await bot('picky', 100);
  const near = mk(10, 1);         // closing within 20s once time advances
  const own = mk(11, 30, b);      // bot's own auction
  const leading = mk(12, 30);     // bot already leads it
  const tooDear = mk(500, 30);    // beyond budget
  const ok = mk(80, 30);
  s.bid(leading, 12, b.id, randomUUID()); // budget 88 left
  advance(45000);                  // `near` has ~15s left
  const round = s.runBots(true, b.id);
  assert.deepEqual(picked(round), [ok]);
  assert.equal(s.one('SELECT COUNT(*) n FROM bids WHERE auction_id IN (?,?,?)', near, own, tooDear).n, 0);
});

test('ended and finalized auctions are never selected', async t => {
  const { s, mk, bot, advance } = await botFixture(t);
  const ended = mk(10, 1), finalized = mk(10, 1);
  advance(60001);
  s.finalize(finalized, 'system');
  const live = mk(80, 30);
  const b = await bot('late');
  assert.deepEqual(picked(s.runBots(true, b.id)), [live]);
  assert.equal(s.one('SELECT COUNT(*) n FROM bids WHERE auction_id IN (?,?)', ended, finalized).n, 0);
});

test('multiple bots wait rather than spill from a reserved minimum to higher prices', async t => {
  const { s, mk, bot } = await botFixture(t);
  const c1 = mk(50); mk(60); mk(70);
  await bot('m1'); await bot('m2'); await bot('m3');
  const round = s.runBots(true);
  const chosen = picked(round);
  assert.equal(new Set(chosen).size, 1);
  assert.deepEqual(chosen, [c1]);
  assert.equal(round.decisions.filter(d => d.outcome === 'skipped').length, 2);
});

test('no eligible auctions means no bid', async t => {
  const { s, mk, bot } = await botFixture(t);
  mk(500);
  const b = await bot('broke', 100);
  const round = s.runBots(true, b.id);
  assert.equal(round.sent, 0);
  assert.equal(round.decisions[0].outcome, 'skipped');
  assert.equal(s.one('SELECT COUNT(*) n FROM bids').n, 0);
});

test('scheduled runBots still honors next_at and audit label is cheapest-first', async t => {
  const { s, mk, bot, advance } = await botFixture(t);
  mk(50);
  await bot('sched');
  assert.equal(s.runBots().sent, 1);
  assert.equal(s.runBots(), null);
  advance(60000);
  assert(s.runBots());
  const ev = s.all("SELECT detail FROM events WHERE type='bot-configured'").map(e => JSON.parse(e.detail));
  assert(ev.some(d => d.strategy === 'cheapest-auction-random-tie'));
});

test('cheapest selection handles 200000 active candidates without argument spreading', t => {
  const s = new MarketStore(':memory:', () => 1000000, () => {
    throw new Error('The cheapest auction is unique');
  });
  t.after(() => s.close());
  const candidates = Array.from({ length: 200000 }, (_, index) => ({
    id: String(index), seller_id: 'seller', winner_id: null,
    end_at: 1100000, minimum: index === 199999 ? 25 : 50, highest: 0,
  }));
  s.all = () => [{ user_id: 'bot', interval_seconds: 60 }];
  s.one = () => ({ n: 0 });
  s.user = () => ({ budget: 2000 });
  s.active = () => candidates;
  s.bid = id => ({ id: `bid-${id}` });
  s.run = () => {};
  const round = s.runBots(true);
  assert.equal(round.sent, 1);
  assert.equal(round.decisions[0].auction, '199999');
});

test('admin messages: only admins send, validated, delivered oldest first, read only by the owner', async t => {
  const { s, admin, a, b, advance } = await fixture(t);
  assert.throws(() => s.sendMessage(a.id, 'hi', a.id), /Administrator access required/);
  assert.throws(() => s.sendMessage(a.id, '   ', admin.id), /Text is required/);
  assert.throws(() => s.sendMessage(a.id, 'x'.repeat(1001), admin.id), /maximum 1000/);
  assert.throws(() => s.sendMessage(randomUUID(), 'hi', admin.id), /Account not found/);
  const bot = await s.createUser({ name: 'Bot', email: 'g@bot.invalid', role: 'bot' }, admin.id);
  assert.throws(() => s.sendMessage(bot.id, 'hi', admin.id), /bot accounts/);
  const first = s.sendMessage(a.id, '<b>first</b>', admin.id).id;
  advance(10);
  const second = s.sendMessage(a.id, 'second', admin.id).id;
  assert.equal(s.all("SELECT id FROM events WHERE type='admin-message-sent'").length, 2);
  const login = s.identifierLogin('a@example.com');
  const beat = s.heartbeat(login.token);
  assert.deepEqual(beat.messages.map(m => m.id), [first, second]);
  assert.equal(beat.messages[0].body, '<b>first</b>');
  assert.deepEqual(s.heartbeat(s.identifierLogin('b@example.com').token).messages, []);
  assert.throws(() => s.markMessageRead(first, b.id), /Message not found/);
  assert.equal(s.one('SELECT read_at FROM user_messages WHERE id=?', first).read_at, null);
  advance(5);
  s.markMessageRead(first, a.id);
  const readAt = s.one('SELECT read_at FROM user_messages WHERE id=?', first).read_at;
  advance(5);
  s.markMessageRead(first, a.id);
  assert.equal(s.one('SELECT read_at FROM user_messages WHERE id=?', first).read_at, readAt);
  assert.deepEqual(s.heartbeat(login.token).messages.map(m => m.id), [second]);
  const history = s.userMessages(a.id, admin.id).messages;
  assert.deepEqual(history.map(m => m.id), [second, first]);
  assert.equal(history[1].read_at, readAt);
  assert.throws(() => s.userMessages(a.id, a.id), /Administrator access required/);
});

test('soft-deleted auctions are hidden from users but kept for admins and reports', async t => {
  const { s, admin, seller, a, auction } = await fixture(t);
  const id = auction(5), other = auction(5);
  s.bid(id, 60, a.id, randomUUID());
  const budgetBefore = s.user(a.id).budget;
  const ledgerBefore = s.one('SELECT COUNT(*) n FROM ledger').n;
  assert.throws(() => s.deleteAuction(id, 'x', seller.id), /Administrator access required/);
  assert.throws(() => s.deleteAuction(randomUUID(), '', admin.id), /Auction not found/);
  assert.throws(() => s.deleteAuction(id, 'n'.repeat(501), admin.id), /too long/);
  assert.equal(s.deleteAuction(id, undefined, admin.id).deleted_note, 'Deleted by admin');
  assert.equal(s.one('SELECT COUNT(*) n FROM ledger').n, ledgerBefore);
  assert.throws(() => s.deleteAuction(id, 'again', admin.id), /already deleted/);
  const row = s.one('SELECT deleted_at,deleted_by,deleted_note FROM auctions WHERE id=?', id);
  assert.deepEqual({ ...row }, { deleted_at: 1000000, deleted_by: admin.id, deleted_note: 'Deleted by admin' });
  assert.equal(s.one('SELECT COUNT(*) n FROM auctions').n, 2);
  assert.ok(s.one("SELECT id FROM events WHERE type='auction-deleted-by-admin'"));
  // Hidden from users: list, detail, record, bids and the active list used by bots.
  assert.deepEqual(s.auctionsFor(a.id).map(x => x.id), [other]);
  assert.equal('deleted_at' in s.auctionsFor(a.id)[0], false);
  assert.throws(() => s.auction(id, a.id), /Auction not found/);
  assert.throws(() => s.auction(id, seller.id), /Auction not found/);
  assert.throws(() => s.inspectAuction(id, seller.id, false), /Auction not found/);
  assert.throws(() => s.bid(id, 100, a.id, randomUUID()), /Auction not found/);
  assert.deepEqual(s.active().map(x => x.id), [other]);
  const bot = await s.createUser({ name: 'Bot', email: 'g@bot.invalid', role: 'bot' }, admin.id);
  s.runBots(true);
  assert.equal(s.one('SELECT COUNT(*) n FROM bids WHERE auction_id=? AND user_id=?', id, bot.id).n, 0);
  // Admin still sees it, marked deleted.
  assert.equal(s.auction(id, admin.id).deleted_at, 1000000);
  assert.equal(s.auctionsFor(admin.id).find(x => x.id === id).deleted_by, admin.id);
  assert.equal(s.adminState(admin.id).active.find(x => x.id === id).deleted_at, 1000000);
  assert.equal(s.report(admin.id).auctions.find(x => x.id === id).deleted_note, 'Deleted by admin');
  assert.equal(s.inspectAuction(id, admin.id).editable, false);
  // Deleting changes no budgets or ledger entries (bot activity above only touched the other auction).
  assert.equal(s.user(a.id).budget, budgetBefore);
  s.deleteAuction(other, '  spam  ', admin.id);
  assert.equal(s.one('SELECT deleted_note FROM auctions WHERE id=?', other).deleted_note, 'spam');
});

test('migration adds new columns and tables to an existing database', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'market-migrate-'));
  const file = join(dir, 'm.sqlite');
  const first = new MarketStore(file);
  first.db.exec('DROP TABLE user_messages; ALTER TABLE auctions DROP COLUMN deleted_at; ALTER TABLE auctions DROP COLUMN deleted_by; ALTER TABLE auctions DROP COLUMN deleted_note');
  first.close();
  const second = new MarketStore(file);
  t.after(() => second.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const columns = second.all('PRAGMA table_info(auctions)').map(c => c.name);
  for (const c of ['deleted_at', 'deleted_by', 'deleted_note']) assert.ok(columns.includes(c));
  assert.equal(second.one('SELECT COUNT(*) n FROM user_messages').n, 0);
});
