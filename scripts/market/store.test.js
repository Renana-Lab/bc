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
  assert.equal(s.auction(id, a.id).bids.length, 1);
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
test('bots use independent budgets, one random auction per round, and a fixed ten-credit step', async t => {
  const { s, admin, a, auction, make } = await fixture(t);
  const bot = await make('budgeted-random-bot', 'bot');
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
