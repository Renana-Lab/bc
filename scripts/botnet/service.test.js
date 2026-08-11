const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ensureSingleMetaMaskAgentBot,
  isBotConfigured,
  isMetaMaskAgentBot,
  normalizeBotRecord,
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
