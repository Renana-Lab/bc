import {
  AUDIT_CACHE_TTL_MS,
  DEFAULT_AUDIT_LOOKBACK_BLOCKS,
  MAX_AUDIT_LOOKBACK_BLOCKS,
  getAuditLookbackBlocks,
  getAuditSnapshot,
  isRevertError,
  readAllUsers,
  resetAuditCache,
} from "./adminAuditReader";
import { alignBidHashes, DEFAULT_CSV_LOOKBACK_BLOCKS, getCsvLookbackBlocks } from "./reportUtils";

describe("lookback configuration", () => {
  test("defaults to 1000 blocks", () => {
    expect(DEFAULT_AUDIT_LOOKBACK_BLOCKS).toBe(1000);
    expect(getAuditLookbackBlocks(undefined)).toBe(1000);
    expect(getAuditLookbackBlocks("")).toBe(1000);
    expect(getAuditLookbackBlocks("abc")).toBe(1000);
    expect(getAuditLookbackBlocks("0")).toBe(1000);
    expect(getAuditLookbackBlocks("-5")).toBe(1000);
  });
  test("REACT_APP_ADMIN_AUDIT_LOOKBACK_BLOCKS overrides it, within a ceiling", () => {
    expect(getAuditLookbackBlocks("250")).toBe(250);
    expect(getAuditLookbackBlocks("999999999")).toBe(MAX_AUDIT_LOOKBACK_BLOCKS);
  });
  test("the real env default is used when the variable is unset", () => {
    expect(process.env.REACT_APP_ADMIN_AUDIT_LOOKBACK_BLOCKS).toBeUndefined();
    expect(getAuditLookbackBlocks()).toBe(DEFAULT_AUDIT_LOOKBACK_BLOCKS);
  });
  test("CSV window has a bounded default too", () => {
    expect(getCsvLookbackBlocks(undefined)).toBe(DEFAULT_CSV_LOOKBACK_BLOCKS);
    expect(getCsvLookbackBlocks("300")).toBe(300);
  });
});

describe("shared audit snapshot cache", () => {
  beforeEach(() => resetAuditCache());

  test("two cards share one read", async () => {
    const reader = jest.fn(async () => ({ events: [1] }));
    const [a, b] = await Promise.all([
      getAuditSnapshot("0xF", { reader }),
      getAuditSnapshot("0xf", { reader }),
    ]);
    expect(a).toBe(b);
    expect(reader).toHaveBeenCalledTimes(1);
    await getAuditSnapshot("0xF", { reader });
    expect(reader).toHaveBeenCalledTimes(1); // still inside the TTL
  });
  test("re-reads after the TTL and on force once the short force window passed", async () => {
    let clock = 1000;
    const reader = jest.fn(async () => ({ at: clock }));
    const options = { reader, now: () => clock };
    await getAuditSnapshot("0xF", options);
    clock += 1000;
    await getAuditSnapshot("0xF", { ...options, force: true });
    expect(reader).toHaveBeenCalledTimes(1); // a forced refresh right after a read is deduped
    clock += 5000;
    await getAuditSnapshot("0xF", { ...options, force: true });
    expect(reader).toHaveBeenCalledTimes(2);
    clock += AUDIT_CACHE_TTL_MS + 1;
    await getAuditSnapshot("0xF", options);
    expect(reader).toHaveBeenCalledTimes(3);
  });
  test("cache entries are per factory address", async () => {
    const reader = jest.fn(async (factory) => ({ factory, events: [] }));
    const a = await getAuditSnapshot("0xAAA", { reader });
    const b = await getAuditSnapshot("0xBBB", { reader }); // inside the TTL, must not reuse A's result
    expect(reader).toHaveBeenCalledTimes(2);
    expect(a.factory).toBe("0xAAA");
    expect(b.factory).toBe("0xBBB");
    expect(await getAuditSnapshot("0xaaa", { reader })).toBe(a);
    expect(await getAuditSnapshot("0xbbb", { reader })).toBe(b);
    expect(reader).toHaveBeenCalledTimes(2);
  });
  test("failures are not cached", async () => {
    const reader = jest.fn().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValueOnce({ events: [] });
    await expect(getAuditSnapshot("0xF", { reader })).rejects.toThrow("rpc down");
    await expect(getAuditSnapshot("0xF", { reader })).resolves.toEqual({ events: [] });
  });
});

describe("readAllUsers", () => {
  const revert = () => Object.assign(new Error("execution reverted"), { code: 3 });

  test("a revert at the end index is the end of the list, not an error", async () => {
    const result = await readAllUsers(async (i) => (i < 13 ? `0x${i}` : Promise.reject(revert())));
    expect(result.addresses).toHaveLength(13);
    expect(result).toMatchObject({ complete: true, warning: "" });
  });
  test("revert detection is by message, case-insensitively", async () => {
    expect(isRevertError(new Error("VM Exception: Reverted with reason"))).toBe(true);
    expect(isRevertError(new Error("fetch failed"))).toBe(false);
    const result = await readAllUsers(async (i) => (i < 2 ? `0x${i}` : Promise.reject(new Error("call REVERT exception"))));
    expect(result).toMatchObject({ complete: true, warning: "" });
  });
  test("an RPC error is not the end: the list is flagged incomplete", async () => {
    const result = await readAllUsers(async (i) => (i < 4 ? `0x${i}` : Promise.reject(new Error("fetch failed"))));
    expect(result.addresses).toHaveLength(4);
    expect(result.complete).toBe(false);
    expect(result.warning).toMatch(/Error while reading user #4/);
  });
  test("an unfamiliar error message is never treated as end-of-list", async () => {
    const result = await readAllUsers(async (i) => (i < 3 ? `0x${i}` : Promise.reject(new Error("Returned values aren't valid, did it run Out of Gas?"))));
    expect(result.addresses).toHaveLength(3);
    expect(result.complete).toBe(false);
    expect(result.warning).toMatch(/Out of Gas/);
    const odd = await readAllUsers(async () => Promise.reject({ weird: true }));
    expect(odd.complete).toBe(false);
    expect(odd.warning).not.toBe("");
  });
  test("warns when the cap is reached", async () => {
    const result = await readAllUsers(async (i) => `0x${i}`, { cap: 25 });
    expect(result.addresses).toHaveLength(25);
    expect(result.complete).toBe(false);
    expect(result.warning).toMatch(/25-user read cap/);
  });
});

describe("transaction hash matching for the per-auction CSV", () => {
  const A = "0xAbC0000000000000000000000000000000000001";
  const B = "0xdef0000000000000000000000000000000000002";
  const row = (bidderAddress, cumulativeBid, time) => ({ bidderAddress, cumulativeBid: String(cumulativeBid), time: String(time), value: "1" });
  const log = (bidder, cumulativeBid, time, transactionHash) => ({ bidder: bidder.toLowerCase(), cumulativeBid: String(cumulativeBid), time: String(time), amount: "1", transactionHash });
  const rows = [row(A, 10, 100), row(B, 20, 110), row(A, 30, 120)];

  test("matches by bidder + new total + time, regardless of order or case", () => {
    const { hashes, note } = alignBidHashes(rows, [log(A, 30, 120, "c"), log(A, 10, 100, "a"), log(B, 20, 110, "b")]);
    expect(hashes).toEqual(["a", "b", "c"]);
    expect(note).toBe("");
  });
  test("older bids outside the window get blank hashes and a note, never a wrong hash", () => {
    const { hashes, note } = alignBidHashes(rows, [log(B, 20, 110, "b"), log(A, 30, 120, "c")]);
    expect(hashes).toEqual(["", "b", "c"]);
    expect(note).toMatch(/1 of 3 bids have no matching log/);
  });
  test("a mismatching log (different total or time) is not used", () => {
    const { hashes, note } = alignBidHashes(rows, [log(A, 11, 100, "x"), log(B, 20, 111, "y")]);
    expect(hashes).toEqual(["", "", ""]);
    expect(note).toMatch(/No BidRecorded log matched/);
  });
  test("each log is used at most once", () => {
    const twins = [row(A, 10, 100), row(A, 10, 100)];
    expect(alignBidHashes(twins, [log(A, 10, 100, "only")]).hashes).toEqual(["only", ""]);
  });
  test("legacy rows without a cumulative total match on bidder, amount and time", () => {
    const legacy = [{ bidderAddress: A, value: "1", time: "100" }];
    expect(alignBidHashes(legacy, [log(A, 10, 100, "a")]).hashes).toEqual(["a"]);
  });
  test("no logs: blank hashes with an explanation", () => {
    const { hashes, note } = alignBidHashes(rows, []);
    expect(hashes).toEqual(["", "", ""]);
    expect(note).toMatch(/No BidRecorded logs found/);
  });
});
