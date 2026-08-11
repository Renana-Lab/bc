import {
  extractPrivateKeysFromText,
  ensureSingleMetaMaskAgentBot,
  getBidDecision,
  getStrategy,
  isValidPrivateKey,
  normalizeBot,
  normalizePrivateKey,
  METAMASK_AGENT_WALLET,
} from "./BotnetControlPanel";

const KEY_A = "1".repeat(64);
const KEY_B = "2".repeat(64);

const strategy = {
  maxBidWei: 2000n,
  outbidByWei: 10n,
  maxMinContributionWei: 2000n,
  minTimeRemainingSec: 20,
  skipIfWinning: true,
};

const auction = {
  isActive: true,
  isManager: false,
  secondsLeft: 120,
  isWinner: false,
  minimumContribution: 100n,
  approversCount: 0,
  highestBid: 0n,
  myBid: 0n,
};

describe("bot command center stress cases", () => {
  test("extracts unique keys from txt, csv, json, and env-shaped text", () => {
    const keys = extractPrivateKeysFromText(
      `BOT_A=${KEY_A}\n{"key":"0x${KEY_B}"}\n${KEY_A},0x${KEY_B}`,
    );

    expect(keys).toEqual([`0x${KEY_A}`, `0x${KEY_B}`]);
  });

  test("normalizes and validates private keys", () => {
    expect(normalizePrivateKey(KEY_A)).toBe(`0x${KEY_A}`);
    expect(isValidPrivateKey(KEY_A)).toBe(true);
    expect(isValidPrivateKey("deadbeef")).toBe(false);
  });

  test("recovers stale running cycles instead of leaving bots stuck", () => {
    const bot = normalizeBot({
      id: "stale",
      name: "Stale",
      privateKey: KEY_A,
      running: true,
      status: "running-cycle",
      lastCycleAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    expect(bot.status).toBe("running");
    expect(bot.lastError).toMatch(/interrupted/i);
  });

  test("reserves exactly one of four command-center bots for MetaMask Agent Wallet", () => {
    const bots = ensureSingleMetaMaskAgentBot(
      [KEY_A, KEY_B, "3".repeat(64), "4".repeat(64)].map((privateKey, index) => ({
        id: `bot-${index}`,
        name: `Bot ${index + 1}`,
        privateKey,
        enabled: true,
      })),
    );

    expect(bots).toHaveLength(4);
    expect(bots.filter((bot) => bot.walletType === METAMASK_AGENT_WALLET)).toHaveLength(1);
    expect(bots[3]).toMatchObject({
      name: "MetaMask Wallet Agent",
      walletType: METAMASK_AGENT_WALLET,
      status: "runner-managed",
      running: false,
    });
  });

  test("never promotes more than one Agent Wallet bot", () => {
    const bots = ensureSingleMetaMaskAgentBot(
      Array.from({ length: 4 }, (_, index) => ({
        id: `agent-${index}`,
        name: `Agent ${index}`,
        walletType: METAMASK_AGENT_WALLET,
        privateKey: `${index + 1}`.repeat(64),
      })),
    );
    expect(bots.filter((bot) => bot.walletType === METAMASK_AGENT_WALLET)).toHaveLength(1);
  });

  test("computes initial, outbid, and incremental rebid values", () => {
    expect(getBidDecision(auction, 2000n, strategy)).toMatchObject({
      bid: true,
      amountWei: 100n,
      targetBid: 100n,
    });
    expect(
      getBidDecision(
        { ...auction, approversCount: 2, highestBid: 500n },
        2000n,
        strategy,
      ),
    ).toMatchObject({ bid: true, amountWei: 510n, targetBid: 510n });
    expect(
      getBidDecision(
        { ...auction, approversCount: 2, highestBid: 500n, myBid: 480n },
        2000n,
        strategy,
      ),
    ).toMatchObject({ bid: true, amountWei: 30n, targetBid: 510n });
  });

  test.each([
    [{ ...auction, isActive: false }, 2000n, /closed/i],
    [{ ...auction, isManager: true }, 2000n, /seller/i],
    [{ ...auction, secondsLeft: 1 }, 2000n, /time/i],
    [{ ...auction, isWinner: true }, 2000n, /winning/i],
    [{ ...auction, minimumContribution: 3000n }, 5000n, /minimum/i],
    [{ ...auction, minimumContribution: 2100n }, 2000n, /minimum/i],
    [{ ...auction, minimumContribution: 100n }, 99n, /budget/i],
  ])("rejects unsafe bid scenario %#", (candidate, budget, reason) => {
    expect(getBidDecision(candidate, budget, strategy)).toMatchObject({ bid: false });
    expect(getBidDecision(candidate, budget, strategy).reason).toMatch(reason);
  });

  test("normalizes malformed strategy overrides to safe defaults", () => {
    const normalized = getStrategy({
      overrides: {
        MAX_BID_WEI: "not-a-number",
        AUTO_TRADE_INTERVAL_SEC: "0",
        ENABLE_BIDDING: "false",
      },
    });

    expect(normalized.maxBidWei).toBe(0n);
    expect(normalized.intervalSec).toBe(60);
    expect(normalized.enableBidding).toBe(false);
  });
});
