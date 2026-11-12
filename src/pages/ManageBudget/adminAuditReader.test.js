import {
  AUDIT_CACHE_TTL_MS,
  DEFAULT_AUDIT_LOOKBACK_BLOCKS,
  MAX_AUDIT_LOOKBACK_BLOCKS,
  getAuditLookbackBlocks,
  getAuditSnapshot,
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
  test("failures are not cached", async () => {
    const reader = jest.fn().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValueOnce({ events: [] });
    await expect(getAuditSnapshot("0xF", { reader })).rejects.toThrow("rpc down");
    await expect(getAuditSnapshot("0xF", { reader })).resolves.toEqual({ events: [] });
  });
});

describe("readAllUsers", () => {
  const revert = () => Object.assign(new Error("execution reverted"), { code: 3 });
  const rpcDown = () => Object.assign(new Error("fetch failed"), { rpc: true });
  const isRpcError = (error) => Boolean(error.rpc);

  test("a revert at the end index is the end of the list, not an error", async () => {
    const result = await readAllUsers(async (i) => (i < 13 ? `0x${i}` : Promise.reject(revert())), { isRpcError });
    expect(result.addresses).toHaveLength(13);
    expect(result).toMatchObject({ complete: true, warning: "" });
  });
  test("an RPC error is not treated as the end: the list is flagged incomplete", async () => {
    const result = await readAllUsers(async (i) => (i < 4 ? `0x${i}` : Promise.reject(rpcDown())), { isRpcError });
    expect(result.addresses).toHaveLength(4);
    expect(result.complete).toBe(false);
    expect(result.warning).toMatch(/RPC error while reading user #4/);
  });
  test("warns when the cap is reached", async () => {
    const result = await readAllUsers(async (i) => `0x${i}`, { cap: 25, isRpcError });
    expect(result.addresses).toHaveLength(25);
    expect(result.complete).toBe(false);
    expect(result.warning).toMatch(/25-user read cap/);
  });
});

describe("transaction hash alignment for the per-auction CSV", () => {
  const rows = [{}, {}, {}];
  test("complete window: hashes line up one to one", () => {
    const { hashes, note } = alignBidHashes(rows, [{ transactionHash: "a" }, { transactionHash: "b" }, { transactionHash: "c" }], { complete: true });
    expect(hashes).toEqual(["a", "b", "c"]);
    expect(note).toBe("");
  });
  test("window shorter than the auction: hashes attach to the newest bids with a note", () => {
    const { hashes, note } = alignBidHashes(rows, [{ transactionHash: "b" }, { transactionHash: "c" }], { complete: true });
    expect(hashes).toEqual(["", "b", "c"]);
    expect(note).toMatch(/latest 2 of 3/);
  });
  test("failed ranges: never guess, leave blank and say so", () => {
    const { hashes, note } = alignBidHashes(rows, [{ transactionHash: "c" }], { complete: false });
    expect(hashes).toEqual(["", "", ""]);
    expect(note).toMatch(/incomplete/);
  });
  test("more logs than rows is refused", () => {
    expect(alignBidHashes([{}], [{ transactionHash: "a" }, { transactionHash: "b" }], { complete: true }).hashes).toEqual([""]);
  });
});
