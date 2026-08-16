const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ensureSingleMetaMaskAgentBot,
  isBotConfigured,
  isMetaMaskAgentBot,
  normalizeBotRecord,
  classifyIndexedAuctions,
  getStrategy,
  getRpcFailureKind,
  enqueueWalletWrite,
  runWithConcurrency,
} = require("./service");

const key = (digit) => digit.repeat(64);

test("a MetaMask Agent Wallet bot is configured without a private key", () => {
  const bot = normalizeBotRecord({
    id: "agent",
    name: "Agent",
    walletType: "metamask-agent",
    enabled: true,
  });
  assert.equal(isMetaMaskAgentBot(bot), true);
  assert.equal(isBotConfigured(bot), true);
  assert.equal(bot.enabled, true);
  assert.equal(bot.privateKey, "");
});

test("existing bots receive one protected bid per cycle by default", () => {
  const bot = normalizeBotRecord({ id: "legacy", name: "Legacy", privateKey: key("1") });
  assert.equal(bot.overrides.MAX_BIDS_PER_CYCLE, "1");
  assert.equal(getStrategy(bot).maxBidsPerCycle, 1);
  bot.overrides.MAX_BIDS_PER_CYCLE = "99";
  assert.equal(getStrategy(bot).maxBidsPerCycle, 5);
});

test("the Node index excludes closed history from normal cycle work", () => {
  const now = 2000000000;
  const indexed = classifyIndexedAuctions([
    { address: "0x1", endTimeSec: now + 100, closed: false },
    { address: "0x2", endTimeSec: now - 100, closed: true },
    { address: "0x3", endTimeSec: now - 1, closed: false, approversCount: 1 },
    { address: "0x4", endTimeSec: now - 1, closed: false, approversCount: 0 },
  ], now);
  assert.deepEqual(indexed.activeAuctions.map((item) => item.address), ["0x1"]);
  assert.deepEqual(indexed.finalizableAuctions.map((item) => item.address), ["0x3", "0x4"]);
});

test("provider capacity failures are distinct from bot logic failures", () => {
  assert.equal(getRpcFailureKind(new Error("429 Too Many Requests")), "capacity");
  assert.equal(getRpcFailureKind(new Error("chain is not available on free plan")), "unsupported-plan");
  assert.equal(getRpcFailureKind(new Error("All configured RPC endpoints are cooling down.")), "network");
  assert.equal(getRpcFailureKind(new Error("execution reverted")), "other");
});

test("wallet writes are sequential per address but concurrent across addresses", async () => {
  const order = [];
  let active = 0;
  let peak = 0;
  const task = (label, delay = 5) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(`start-${label}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    order.push(`end-${label}`);
    active -= 1;
  };
  await Promise.all([
    enqueueWalletWrite("0xaaa", task("a1")),
    enqueueWalletWrite("0xaaa", task("a2")),
    enqueueWalletWrite("0xbbb", task("b1")),
  ]);
  assert.ok(order.indexOf("end-a1") < order.indexOf("start-a2"));
  assert.ok(peak >= 2);
});

test("exactly one of four bots is promoted to the Agent Wallet signer", () => {
  const bots = ensureSingleMetaMaskAgentBot(
    ["1", "2", "3", "4"].map((digit, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index + 1}`,
      privateKey: key(digit),
      enabled: true,
    })),
  );
  assert.equal(bots.length, 4);
  assert.equal(bots.filter(isMetaMaskAgentBot).length, 1);
  assert.equal(bots[3].name, "MetaMask Wallet Agent");
  assert.equal(bots.every(isBotConfigured), true);
});

test("duplicate Agent Wallet designations collapse to one", () => {
  const bots = ensureSingleMetaMaskAgentBot(
    ["1", "2", "3", "4"].map((digit, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index + 1}`,
      walletType: "metamask-agent",
      privateKey: key(digit),
      enabled: true,
    })),
  );
  assert.equal(bots.filter(isMetaMaskAgentBot).length, 1);
  assert.equal(bots.filter((bot) => bot.walletType === "private-key").length, 3);
});

test("fewer than four bots are not silently converted", () => {
  const bots = ensureSingleMetaMaskAgentBot([
    { id: "one", name: "One", privateKey: key("1"), enabled: true },
  ]);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].walletType, "private-key");
});

test("four bot cycles can execute concurrently and retain result order", async () => {
  let active = 0;
  let peak = 0;
  const results = await runWithConcurrency(
    [1, 2, 3, 4],
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return value * 10;
    },
    4,
  );
  assert.equal(peak, 4);
  assert.deepEqual(results, [10, 20, 30, 40]);
});

test("the concurrency bound is enforced under a larger stress batch", async () => {
  let active = 0;
  let peak = 0;
  await runWithConcurrency(
    Array.from({ length: 100 }, (_, index) => index),
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    },
    4,
  );
  assert.equal(peak, 4);
  assert.equal(active, 0);
});
