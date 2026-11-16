import { autoClaim, AUTO_CLAIM_MIN_WEI, __resetAutoClaimForTests } from "./autoClaim.mjs";

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const PID = "5f1a2b3c4d5e6f7a8b9c0d1e";
const address = (n) => `0x${String(n).repeat(40)}`;
const base = (overrides = {}) => ({
  faucetUrl: "https://faucet.example", address: address(1), strictPid: PID, openPid: PID,
  readBalance: async () => "0x0", sleep: async () => {}, ...overrides,
});
const faucet = ({ open = true, pidMode = "prolific", claim = reply(200, { status: "paid" }) } = {}) => {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    calls.push({ url, init });
    return url.endsWith("/status") ? reply(200, { open, updatedAt: null, pidMode }) : claim;
  });
  return { fetchImpl, calls, claims: () => calls.filter((c) => c.url.endsWith("/claim")) };
};
beforeEach(() => __resetAutoClaimForTests());

test("a funded-below-0.05 wallet with a pid claims once, with the same request as the button", async () => {
  const f = faucet();
  expect(await autoClaim(base({ fetchImpl: f.fetchImpl, studyId: "s1" }))).toBe("claimed");
  expect(f.claims()).toHaveLength(1);
  expect(JSON.parse(f.claims()[0].init.body)).toEqual({ pid: PID, address: address(1), studyId: "s1" });
});

test("fires at most once per page load: repeats and parallel calls share the first attempt, no loop", async () => {
  const f = faucet();
  const args = base({ fetchImpl: f.fetchImpl });
  const results = await Promise.all([autoClaim(args), autoClaim(args), autoClaim(args)]);
  expect(results).toEqual(["claimed", "claimed", "claimed"]);
  expect(await autoClaim(args)).toBe("claimed");
  expect(f.claims()).toHaveLength(1);
});

test("already claimed is silent (resolves like success)", async () => {
  const f = faucet({ claim: reply(200, { status: "already_paid" }) });
  expect(await autoClaim(base({ fetchImpl: f.fetchImpl }))).toBe("claimed");
});

test.each([
  ["a refused claim", reply(403, { error: "not_eligible" })],
  ["an exhausted budget", reply(403, { error: "budget_exhausted" })],
  ["an empty faucet", reply(503, { error: "faucet_empty" })],
])("%s fails silently (resolves, never throws, no retry loop)", async (_name, claim) => {
  const f = faucet({ claim });
  await expect(autoClaim(base({ fetchImpl: f.fetchImpl }))).resolves.toBe("failed");
  expect(f.claims()).toHaveLength(1);
});

test("a network failure fails silently", async () => {
  const fetchImpl = jest.fn(async () => { throw new TypeError("Failed to fetch"); });
  await expect(autoClaim(base({ fetchImpl }))).resolves.toBe("failed");
});

test("a claim that hangs does not block the session beyond the wait limit", async () => {
  const fetchImpl = jest.fn(async (url) => (url.endsWith("/status") ? reply(200, { open: true, pidMode: "prolific" }) : new Promise(() => {})));
  await expect(autoClaim(base({ fetchImpl, maxWaitMs: 20 }))).resolves.toBe("failed");
});

test("skipped: balance already at 0.05, no pid, no faucet url, closed faucet", async () => {
  const f = faucet();
  expect(await autoClaim(base({ fetchImpl: f.fetchImpl, readBalance: async () => `0x${AUTO_CLAIM_MIN_WEI.toString(16)}`, address: address(2) }))).toBe("skipped");
  expect(await autoClaim(base({ fetchImpl: f.fetchImpl, strictPid: "", openPid: "", address: address(3) }))).toBe("skipped");
  expect(await autoClaim(base({ fetchImpl: f.fetchImpl, faucetUrl: "", address: address(4) }))).toBe("skipped");
  const closed = faucet({ open: false });
  expect(await autoClaim(base({ fetchImpl: closed.fetchImpl, address: address(5) }))).toBe("skipped");
  expect(f.claims()).toHaveLength(0);
  expect(closed.claims()).toHaveLength(0);
});

test("a balance just below 0.05 still claims; an unreadable balance lets the faucet decide", async () => {
  const f = faucet();
  expect(await autoClaim(base({ fetchImpl: f.fetchImpl, readBalance: async () => `0x${(AUTO_CLAIM_MIN_WEI - 1n).toString(16)}` }))).toBe("claimed");
  const g = faucet();
  expect(await autoClaim(base({ fetchImpl: g.fetchImpl, address: address(6), readBalance: async () => { throw new Error("rpc down"); } }))).toBe("claimed");
});

test("open-mode pids are sent only when the faucet says it is in open mode", async () => {
  const open = faucet({ pidMode: "open" });
  await autoClaim(base({ fetchImpl: open.fetchImpl, strictPid: "", openPid: "Participant_42!" }));
  expect(JSON.parse(open.claims()[0].init.body).pid).toBe("Participant_42!");
  const strict = faucet({ pidMode: "prolific" });
  expect(await autoClaim(base({ fetchImpl: strict.fetchImpl, address: address(7), strictPid: "", openPid: "Participant_42!" }))).toBe("skipped");
  expect(strict.claims()).toHaveLength(0);
});

test("exact 0.05 boundary: 0.049 claims, 0.05 skips (balance compared in wei)", async () => {
  const hex = (wei) => `0x${wei.toString(16)}`;
  const below = faucet();
  expect(await autoClaim(base({ fetchImpl: below.fetchImpl, address: address(8), readBalance: async () => hex(49n * 10n ** 15n) }))).toBe("claimed");
  expect(below.claims()).toHaveLength(1);
  const exact = faucet();
  expect(await autoClaim(base({ fetchImpl: exact.fetchImpl, address: address(9), readBalance: async () => hex(5n * 10n ** 16n) }))).toBe("skipped");
  expect(exact.claims()).toHaveLength(0);
  expect(AUTO_CLAIM_MIN_WEI).toBe(5n * 10n ** 16n);
});

test("no pid -> skipped by autoClaim itself, before any balance read or network call", async () => {
  const f = faucet();
  const readBalance = jest.fn(async () => "0x0");
  expect(await autoClaim(base({ fetchImpl: f.fetchImpl, readBalance, strictPid: "", openPid: "", address: address(1) }))).toBe("skipped");
  expect(await autoClaim(base({ fetchImpl: f.fetchImpl, readBalance, strictPid: undefined, openPid: undefined, address: address(2) }))).toBe("skipped");
  expect(readBalance).not.toHaveBeenCalled();
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

describe("faucet rate limit: one jittered retry", () => {
  const limited = reply(429, { error: "rate_limited" });
  const sequence = (...claims) => {
    const calls = [];
    let index = 0;
    const fetchImpl = jest.fn(async (url, init) => {
      calls.push(url);
      if (url.endsWith("/status")) return reply(200, { open: true, updatedAt: null, pidMode: "prolific" });
      const response = claims[Math.min(index, claims.length - 1)];
      index += 1;
      if (response instanceof Error) throw response;
      return response;
    });
    return { fetchImpl, claims: () => calls.filter((url) => url.endsWith("/claim")).length };
  };

  test("a 429 is retried once after 5-15 s (jitter), then succeeds", async () => {
    const delays = [];
    const f = sequence(limited, reply(200, { status: "paid" }));
    const result = await autoClaim(base({ fetchImpl: f.fetchImpl, random: () => 0.5, sleep: async (ms) => { delays.push(ms); } }));
    expect(result).toBe("claimed");
    expect(f.claims()).toBe(2);
    expect(delays).toEqual([10000]);
  });

  test("the jitter spans 5 s to under 15 s", async () => {
    for (const [random, expected] of [[0, 5000], [0.999999, 14999]]) {
      __resetAutoClaimForTests();
      const delays = [];
      const f = sequence(limited, reply(200, { status: "paid" }));
      await autoClaim(base({ fetchImpl: f.fetchImpl, random: () => random, sleep: async (ms) => { delays.push(ms); } }));
      expect(delays[0]).toBe(expected);
    }
  });

  test("a network error is retried once too", async () => {
    const f = sequence(new TypeError("Failed to fetch"), reply(200, { status: "paid" }));
    expect(await autoClaim(base({ fetchImpl: f.fetchImpl, random: () => 0, sleep: async () => {} }))).toBe("claimed");
    expect(f.claims()).toBe(2);
  });

  test("still limited on the retry -> fails silently; never a third attempt, and a repeat call does not start another", async () => {
    const f = sequence(limited);
    const args = base({ fetchImpl: f.fetchImpl, random: () => 0, sleep: async () => {} });
    expect(await autoClaim(args)).toBe("failed");
    expect(f.claims()).toBe(2);
    expect(await autoClaim(args)).toBe("failed");
    expect(f.claims()).toBe(2);
  });

  test("a refusal that is not a rate limit (not eligible) is not retried", async () => {
    const f = sequence(reply(403, { error: "not_eligible" }));
    expect(await autoClaim(base({ fetchImpl: f.fetchImpl, random: () => 0, sleep: async () => {} }))).toBe("failed");
    expect(f.claims()).toBe(1);
  });
});
