import { __resetParticipantAuctionsForTests, loadParticipantAuctions } from "./participantAuctions";
import { readOnlyBatchCall, readOnlyCall } from "../readOnly";

jest.mock("../readOnly", () => ({ readOnlyBatchCall: jest.fn(), readOnlyCall: jest.fn() }));
jest.mock("../marketConfig", () => ({ getActiveFactoryAddress: () => "0xfactory" }));

const ME = `0x${"1".repeat(40)}`;
const OTHER = `0x${"2".repeat(40)}`;
const addr = (n) => `0x${String(n).repeat(40)}`;
// getListSummary: [min, balance, approvers, manager, highestBid, desc, highestBidder, endTime, closed]
const summary = ({ manager = OTHER, highestBidder = OTHER, closed = true } = {}) => [0, 0, 0, manager, 0, "", highestBidder, 0, closed];
// getUserAuctionStatus: [participated, bid, refunded, isManager, isHighestBidder]
const status = (participated, refunded = false, isManager = false) => [participated, 0, refunded, isManager, false];

// A fake chain. `fail.<kind>[address]` = how many reads of that kind still fail (Infinity = always).
const world = ({ summaries, statuses = {}, fail = {}, listFails = 0 }) => {
  const left = { summary: { ...(fail.summary || {}) }, status: { ...(fail.status || {}) }, direct: { ...(fail.direct || {}) }, list: listFails };
  const take = (kind, address) => { if ((left[kind][address] || 0) > 0) { left[kind][address] -= 1; return true; } return false; };
  const reads = { summary: [], status: [] };
  readOnlyCall.mockImplementation(async (createCall) => {
    const call = createCall({
      factory: { methods: { getDeployedCampaigns: () => ({ kind: "list" }) } },
      campaign: (address) => ({ methods: { getUserAuctionStatus: () => ({ kind: "direct", address }) } }),
    });
    if (call.kind === "list") { if (left.list > 0) { left.list -= 1; throw new Error("rpc down"); } return Object.keys(summaries); }
    if (take("direct", call.address)) throw new Error("rpc down");
    return statuses[call.address];
  });
  readOnlyBatchCall.mockImplementation(async (createCalls) => {
    const calls = createCalls({ campaign: (address) => ({ methods: {
      getListSummary: () => ({ kind: "summary", address }), getUserAuctionStatus: () => ({ kind: "status", address }),
    } }) });
    return calls.map((call) => {
      reads[call.kind].push(call.address);
      if (take(call.kind, call.address)) return { status: "rejected", reason: new Error("rate limited") };
      return { status: "fulfilled", value: call.kind === "summary" ? summaries[call.address] : statuses[call.address] };
    });
  });
  return reads;
};
const sleep = jest.fn(async () => {});

beforeEach(() => { __resetParticipantAuctionsForTests(); sleep.mockClear(); });
afterEach(() => jest.resetAllMocks());
const load = () => loadParticipantAuctions({ account: ME, sleep });

test("returns only closed auctions that concern the participant, with list-style fields; reads like the list does", async () => {
  world({
    summaries: {
      [addr(1)]: summary(), [addr(2)]: summary({ closed: false }), [addr(3)]: summary(),
      [addr(4)]: summary({ manager: ME }), [addr(5)]: summary({ highestBidder: ME }),
    },
    statuses: { [addr(1)]: status(true), [addr(3)]: status(false), [addr(4)]: status(false), [addr(5)]: status(false) },
  });
  const result = await load();
  expect(result.map((a) => a.address)).toEqual([addr(1), addr(4), addr(5)]);
  expect(result[0]).toMatchObject({ closed: true, manager: OTHER, addresses: [ME], isRefunded: false });
  expect(readOnlyCall).toHaveBeenCalledWith(expect.any(Function), undefined, { factoryAddress: "0xfactory", preferInjected: false, allowInjectedFallback: true });
  expect(readOnlyBatchCall.mock.calls[0][2]).toEqual({ factoryAddress: "0xfactory", preferInjected: false, allowInjectedFallback: true });
  expect(sleep).not.toHaveBeenCalled();
});

test("reads in chunks of 15", async () => {
  const summaries = {};
  for (let n = 0; n < 40; n += 1) summaries[`0x${String(n).padStart(40, "0")}`] = summary({ closed: false });
  world({ summaries });
  await load();
  expect(readOnlyBatchCall).toHaveBeenCalledTimes(3); // 15 + 15 + 10
});

test("a transient failure of one address is retried with backoff and does not hold anything back", async () => {
  world({
    summaries: { [addr(1)]: summary(), [addr(2)]: summary() },
    statuses: { [addr(1)]: status(true), [addr(2)]: status(false) },
    fail: { summary: { [addr(1)]: 1 }, status: { [addr(2)]: 2 } },
  });
  const result = await load();
  expect(result.map((a) => a.address)).toEqual([addr(1)]);
  expect(result.some((a) => a.probe)).toBe(false);
  expect(sleep).toHaveBeenCalledWith(2000);
});

test("an address whose summary keeps failing is read directly: involved => a probe, not involved => dropped, unreadable => a probe", async () => {
  world({
    summaries: { [addr(1)]: summary(), [addr(2)]: summary(), [addr(3)]: summary(), [addr(4)]: summary() },
    statuses: { [addr(1)]: status(true), [addr(2)]: status(false), [addr(3)]: status(false, false, true), [addr(4)]: status(true) },
    fail: { summary: { [addr(1)]: Infinity, [addr(2)]: Infinity, [addr(3)]: Infinity, [addr(4)]: Infinity }, status: { [addr(4)]: Infinity }, direct: { [addr(4)]: Infinity } },
  });
  const result = await load();
  expect(result).toEqual(expect.arrayContaining([
    { address: addr(1), closed: true, probe: true }, // participated, closed state unknown
    { address: addr(3), closed: true, probe: true }, // the seller
    { address: addr(4), closed: true, probe: true }, // nothing readable at all
  ]));
  expect(result.map((a) => a.address)).not.toContain(addr(2)); // provably not involved
  expect(result).toHaveLength(3);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 4000, 2000, 4000]); // summaries, then statuses: three attempts each, no more
});

test("a closed auction whose status read keeps failing becomes a probe (never silently dropped)", async () => {
  world({ summaries: { [addr(1)]: summary() }, statuses: { [addr(1)]: status(true) }, fail: { status: { [addr(1)]: Infinity }, direct: { [addr(1)]: 1 } } });
  // the direct fallback succeeds on its second... first read fails once, so the load still resolves it
  expect((await load()).map((a) => a.address)).toEqual([addr(1)]);
  __resetParticipantAuctionsForTests();
  world({ summaries: { [addr(1)]: summary() }, statuses: { [addr(1)]: status(true) }, fail: { status: { [addr(1)]: Infinity }, direct: { [addr(1)]: Infinity } } });
  expect(await load()).toEqual([{ address: addr(1), closed: true, probe: true }]);
});

test("closed auctions already checked with nothing due are not read again", async () => {
  const reads = world({
    summaries: { [addr(1)]: summary(), [addr(2)]: summary({ closed: false }), [addr(3)]: summary() },
    statuses: { [addr(1)]: status(false), [addr(3)]: status(true) },
  });
  await load();
  expect(reads.summary.sort()).toEqual([addr(1), addr(2), addr(3)]);
  reads.summary.length = 0; reads.status.length = 0;
  const second = await load();
  expect(reads.summary.sort()).toEqual([addr(2), addr(3)]); // addr(1): closed, nothing due, cached. Open and involved ones are looked at again
  expect(reads.status).toEqual([addr(3)]);
  expect(second.map((a) => a.address)).toEqual([addr(3)]);
});

test("only a failure to list the auctions at all rejects, after 3 attempts", async () => {
  world({ summaries: {}, listFails: 5 });
  await expect(load()).rejects.toThrow(/rpc down/);
  expect(readOnlyCall).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledTimes(2);
  world({ summaries: { [addr(1)]: summary({ closed: false }) }, listFails: 2 });
  expect(await load()).toEqual([]);
});

test("no account, nothing to read", async () => {
  expect(await loadParticipantAuctions({ account: "", sleep })).toEqual([]);
  expect(readOnlyCall).not.toHaveBeenCalled();
});
