// Seller job core: memory store + fake chain, no AWS and no network.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { ADDRESS, KEYS, NOW, PAYLOAD, createEnv, makeBot, makeConfig, makeItem } from "./sellerFakes.mjs";

const require = createRequire(import.meta.url);
const { classifyError } = require("../../infrastructure/faucet/sellerJob.js");

test("idle skip (disabled, or nothing left): no scan and no secret read", async () => {
  for (const config of [makeConfig({ enabled: false }), makeConfig({ bots: [makeBot({ running: false })] })]) {
    const env = createEnv({ config });
    const result = await env.run();
    assert.equal(result.status, "idle");
    assert.equal(env.store.state.calls.countPresence, 0);
    assert.equal(env.secretReads.count, 0);
    assert.ok(env.events().some((event) => event.event === "seller_idle_skip"));
  }
  const exhausted = createEnv({ config: makeConfig({ bots: [makeBot({ items: [makeItem({ quantity: 1 })] })] }) });
  await exhausted.run();
  exhausted.advance(600);
  await exhausted.run(); // finalizes the auction (secret needed, no scan needed)
  const before = { scans: exhausted.store.state.calls.countPresence, secrets: exhausted.secretReads.count };
  exhausted.advance(600);
  const idle = await exhausted.run();
  assert.equal(idle.status, "idle");
  assert.deepEqual({ scans: exhausted.store.state.calls.countPresence, secrets: exhausted.secretReads.count }, before);
});

test("active: exactly one auction per bot per run, the payload goes only to the signer", async () => {
  const env = createEnv({ config: makeConfig({ bots: [makeBot({ id: "bot-1", maxConcurrentOpen: 5 }), makeBot({ id: "bot-2", maxConcurrentOpen: 5 })] }) });
  const result = await env.run();
  assert.equal(result.created, 2);
  assert.equal(env.chain.state.created.length, 2);
  assert.deepEqual(env.chain.state.created.map((c) => c.payload), [PAYLOAD, PAYLOAD]);
  assert.deepEqual(env.records().map((r) => r.status), ["created", "created"]);
  assert.ok(env.records().every((r) => r.auction && r.endTime && r.nonce === 0 && /^0x[0-9a-f]{64}$/.test(r.txHash)));
  await env.run(); // same minute: spacing
  assert.equal(env.chain.state.created.length, 2);
  assert.ok(env.events().some((e) => e.event === "seller_skip" && e.reason === "spacing"));
});

test("spacing and maxConcurrentOpen", async () => {
  const env = createEnv({ config: makeConfig({ bots: [makeBot({ spacingSeconds: 30, maxConcurrentOpen: 2, items: [makeItem({ quantity: 10, durationMinutes: 30 })] })] }) });
  await env.run();
  env.advance(29); await env.run();
  assert.equal(env.chain.state.created.length, 1, "29 s is inside the spacing");
  env.advance(2); await env.run();
  assert.equal(env.chain.state.created.length, 2);
  env.advance(60); await env.run();
  assert.equal(env.chain.state.created.length, 2, "two open auctions is the cap");
  assert.ok(env.events().some((e) => e.reason === "max_open"));
});

test("balance below the minimum creates nothing", async () => {
  const env = createEnv();
  env.chain.state.balances.set(ADDRESS["bot-1"].toLowerCase(), 10n ** 16n);
  await env.run();
  assert.equal(env.chain.state.created.length, 0);
  assert.ok(env.events().some((e) => e.reason === "low_balance"));
});

test("quantity is per item and is never exceeded", async () => {
  const env = createEnv({ config: makeConfig({ bots: [makeBot({ spacingSeconds: 30, maxConcurrentOpen: 5, items: [makeItem({ slot: 1, quantity: 2 }), makeItem({ slot: 2, quantity: 1, description: "other" })] })] }) });
  for (let i = 0; i < 8; i += 1) { await env.run(); env.advance(31); }
  const bySlot = (slot) => env.records().filter((r) => r.item === slot && r.status === "created").length;
  assert.equal(bySlot(1), 2);
  assert.equal(bySlot(2), 1);
  assert.equal(env.chain.state.created.length, 3);
});

test("crash after the record was written but before signing: released and reused, never duplicated", async () => {
  const env = createEnv({ config: makeConfig({ bots: [makeBot({ items: [makeItem({ quantity: 1 })] })] }) });
  await env.store.createRecord({ botId: "bot-1", item: 1, seq: 1, status: "sending", createdAt: 1, sendingAt: 1 }); // a dead run
  await env.run();
  assert.equal(env.records().length, 1);
  assert.equal(env.records()[0].status, "created");
  assert.equal(env.chain.state.created.length, 1);
  env.advance(3600); await env.run(); await env.run();
  assert.equal(env.chain.state.created.length, 1, "quantity 1 holds");
});

test("crash after broadcast (tx mined, record left sending): a re-run settles it without a duplicate", async () => {
  const env = createEnv({ config: makeConfig({ bots: [makeBot({ items: [makeItem({ quantity: 1 })] })] }) });
  env.chain.state.sendFailure = { when: "after", error: "socket hang up" }; // the node got it, the answer was lost
  const first = await env.run();
  assert.equal(first.errors, 1);
  assert.equal(env.records()[0].status, "sending");
  assert.equal(env.chain.state.created.length, 1);
  env.advance(120);
  await env.run();
  assert.equal(env.records()[0].status, "created");
  assert.ok(env.records()[0].auction);
  assert.equal(env.chain.state.created.length, 1);
});

test("crash before the broadcast reached the node: after the absent window the slot is released and reused once", async () => {
  const env = createEnv({ config: makeConfig({ bots: [makeBot({ items: [makeItem({ quantity: 1 })] })] }) });
  env.chain.state.sendFailure = { when: "before", error: "socket hang up" };
  await env.run();
  assert.equal(env.records()[0].status, "sending");
  env.advance(120); await env.run();
  assert.equal(env.records()[0].status, "sending", "still inside the window: a late broadcast cannot be ruled out");
  assert.equal(env.chain.state.created.length, 0);
  env.advance(400); await env.run();
  assert.equal(env.chain.state.created.length, 1);
  assert.equal(env.records().filter((r) => r.status === "created").length, 1);
  env.advance(3600); await env.run();
  assert.equal(env.chain.state.created.length, 1);
});

test("a transaction that is still pending (not mined) is waited for, not duplicated", async () => {
  const env = createEnv();
  env.chain.state.autoMine = false;
  const first = await env.run({ settings: { receiptWaitMs: 3000 } });
  assert.equal(first.created, 0);
  assert.equal(env.records()[0].status, "sending");
  env.advance(100); await env.run();
  assert.equal(env.chain.state.mempool.size, 1, "no second transaction while one is in flight");
  env.chain.mineAll();
  env.advance(100); await env.run();
  assert.equal(env.records().filter((r) => r.status === "created").length, 1);
  assert.equal(env.chain.state.created.length, 1);
});

test("presence: unknown (scan error) fails closed", async () => {
  const env = createEnv();
  env.store.state.failScan = true;
  await env.run();
  assert.equal(env.chain.state.created.length, 0);
  assert.equal(env.secretReads.count, 0);
  assert.equal(env.store.state.progress.presence.state, "unknown");
});

test("presence: idle only after the grace period, and never active before having been active", async () => {
  const env = createEnv({ participants: 0 });
  await env.run();
  assert.equal(env.store.state.progress.presence.state, "idle", "nobody was ever here: no grace");
  env.seen(2); env.advance(60);
  await env.run();
  assert.equal(env.store.state.progress.presence.state, "active");
  assert.equal(env.chain.state.created.length, 1);
  env.seen(0); env.advance(120);
  await env.run();
  assert.equal(env.store.state.progress.presence.state, "active", "inside the 5 minute grace");
  env.advance(320); // more than the 5 minute grace
  await env.run();
  assert.equal(env.store.state.progress.presence.state, "idle");
  const created = env.chain.state.created.length;
  env.advance(600); await env.run();
  assert.equal(env.chain.state.created.length, created);
});

test("presence mode always skips the check", async () => {
  const env = createEnv({ config: makeConfig({ presenceMode: "always" }), participants: 0 });
  await env.run();
  assert.equal(env.chain.state.created.length, 1);
  assert.equal(env.store.state.calls.countPresence, 0);
});

test("presence threshold: minActiveParticipants", async () => {
  const env = createEnv({ config: makeConfig({ minActiveParticipants: 3 }), participants: 2 });
  await env.run();
  assert.equal(env.chain.state.created.length, 0);
  env.seen(3); env.advance(60); await env.run();
  assert.equal(env.chain.state.created.length, 1);
});

test("finalizes its own ended auctions (cap 3 per run) even when nobody is online", async () => {
  const env = createEnv({ config: makeConfig({ bots: [makeBot({ spacingSeconds: 30, maxConcurrentOpen: 5, items: [makeItem({ quantity: 5, durationMinutes: 30 })] })] }) });
  for (let i = 0; i < 5; i += 1) { await env.run(); env.advance(31); }
  assert.equal(env.chain.state.created.length, 5);
  env.seen(0); env.advance(3 * 3600);
  const result = await env.run();
  assert.equal(result.finalized, 3);
  const second = await env.run();
  assert.equal(second.finalized, 2);
  assert.ok([...env.chain.state.auctions.values()].every((a) => a.closed));
  assert.ok(env.records().every((r) => r.finalized === true));
});

test("an auction someone else already finalized is only marked", async () => {
  const env = createEnv();
  await env.run();
  const auction = env.chain.state.created[0].auction;
  env.chain.state.auctions.get(auction).closed = true;
  env.advance(3600); env.seen(0);
  const result = await env.run();
  assert.equal(result.finalized, 0);
  assert.equal(env.chain.state.finalizeTxs, 0);
  assert.equal(env.records()[0].finalized, true);
});

test("three consecutive errors pause the bot with lastError; the pause is stored in the config", async () => {
  const env = createEnv();
  env.chain.state.rpcFailure = true;
  for (let i = 0; i < 3; i += 1) await env.run();
  const bot = env.store.state.config.bots[0];
  assert.equal(bot.running, false);
  assert.equal(bot.lastError, "rpc");
  assert.equal(env.store.state.version, 2);
  assert.ok(env.events().some((e) => e.event === "seller_paused" && e.bot === "bot-1"));
  env.chain.state.rpcFailure = false;
  const result = await env.run();
  assert.equal(result.status, "idle", "a paused bot does nothing");
});

test("a success resets the error counter", async () => {
  const env = createEnv();
  env.chain.state.rpcFailure = true;
  await env.run(); await env.run();
  env.chain.state.rpcFailure = false;
  await env.run();
  assert.equal(env.store.state.progress.bots["bot-1"].errors, 0);
});

test("the lease prevents overlapping runs", async () => {
  const env = createEnv();
  assert.equal(await env.store.acquireLease("other", Math.floor(NOW / 1000), Math.floor(NOW / 1000) + 150), true);
  assert.equal((await env.run()).status, "locked");
  assert.equal(env.chain.state.created.length, 0);
  env.advance(151);
  assert.equal((await env.run()).status, "ran");
  const [a, b] = await Promise.all([createEnv().run(), createEnv().run()]); // separate envs: both run
  assert.equal(a.status === "ran" && b.status === "ran", true);
  const shared = createEnv();
  const results = await Promise.all([shared.run({ holder: "a" }), shared.run({ holder: "b" })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["locked", "ran"]);
  assert.equal(shared.chain.state.created.length, 1);
});

test("calldata that is not enveloped is refused (plaintext path throws) and nothing is broadcast", async () => {
  const env = createEnv();
  env.chain.state.plaintext = true;
  const result = await env.run();
  assert.equal(result.created, 0);
  assert.equal(env.chain.state.mempool.size + env.chain.state.mined.size, 0);
  assert.ok(env.events().some((e) => e.event === "seller_error" && e.code === "not_enveloped"));
  assert.equal(env.records()[0].status, "released");
});

test("logs contain no payload, key, description, participant address or raw error text", async () => {
  const env = createEnv({ config: makeConfig({ bots: [makeBot({ items: [makeItem({ description: "visible-description-xyz" })] })] }) });
  await env.run();
  env.chain.state.rpcFailure = true;
  env.chain.getBalance = async () => { throw new Error(`boom with ${PAYLOAD} and ${KEYS["bot-1"]}`); };
  env.advance(100); await env.run();
  const text = env.logs.join("\n");
  for (const secret of [PAYLOAD, "visible-description-xyz", ...Object.values(KEYS), ...Object.values(KEYS).map((key) => key.slice(2))]) assert.equal(text.includes(secret), false);
  for (const address of env.store.state.sweepSeen.keys()) assert.equal(text.includes(address), false);
  assert.equal(text.includes(ADDRESS["bot-1"]), false);
  for (const line of env.logs) assert.ok(JSON.parse(line).event);
  assert.ok(env.events().some((e) => e.event === "seller_created" && e.auction && e.txHash));
});

test("bot addresses are written to the progress item and excluded from the presence count", async () => {
  const env = createEnv({ participants: 0 });
  env.store.state.progress = { addresses: { "bot-1": ADDRESS["bot-1"] } };
  env.store.state.sweepSeen.set(ADDRESS["bot-1"], Math.floor(NOW / 1000));
  await env.run();
  assert.equal(env.store.state.progress.presence.count, 0, "the bot itself is not a participant");
  assert.equal(env.chain.state.created.length, 0);
  env.seen(1); env.store.state.sweepSeen.set(ADDRESS["bot-1"], Math.floor(NOW / 1000));
  await env.run();
  assert.equal(env.store.state.progress.addresses["bot-1"], ADDRESS["bot-1"]);
});

test("progress reset: raising seqBase starts a fresh quantity", async () => {
  const env = createEnv({ config: makeConfig({ bots: [makeBot({ spacingSeconds: 30, items: [makeItem({ quantity: 1, durationMinutes: 1 })] })] }) });
  await env.run();
  env.advance(200); await env.run(); // finalizes
  env.advance(100); await env.run();
  assert.equal(env.chain.state.created.length, 1);
  const config = structuredClone(env.store.state.config);
  config.bots[0].items[0].seqBase = 1; // what resetProgress does
  env.setConfig(config);
  env.advance(100); await env.run();
  assert.equal(env.chain.state.created.length, 2);
});

test("error codes are short classes, never the message", () => {
  assert.equal(classifyError(new Error("insufficient funds for gas * price + value")), "insufficient_funds");
  assert.equal(classifyError(new Error("nonce too low")), "nonce");
  assert.equal(classifyError(new Error("execution reverted: secret text")), "revert");
  assert.equal(classifyError(new Error("something else with secret")), "unknown");
});
