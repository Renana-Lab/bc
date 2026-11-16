import { loadParticipantAuctions } from "./participantAuctions";
import { readOnlyBatchCall, readOnlyCall } from "../readOnly";

jest.mock("../readOnly", () => ({ readOnlyBatchCall: jest.fn(), readOnlyCall: jest.fn() }));
jest.mock("../marketConfig", () => ({ getActiveFactoryAddress: () => "0xfactory" }));

const ME = `0x${"1".repeat(40)}`;
const OTHER = `0x${"2".repeat(40)}`;
const addr = (n) => `0x${String(n).repeat(40)}`;
// getListSummary: [min, balance, approvers, manager, highestBid, desc, highestBidder, endTime, closed]
const summary = ({ manager = OTHER, highestBidder = OTHER, closed = true } = {}) => [0, 0, 0, manager, 0, "", highestBidder, 0, closed];
const status = (participated, refunded = false) => [participated, 0, refunded, false, false];

// The fake reads whatever the calls ask for, by name.
const world = ({ summaries, statuses }) => {
  readOnlyCall.mockResolvedValue(Object.keys(summaries));
  readOnlyBatchCall.mockImplementation(async (createCalls) => {
    const calls = createCalls({ campaign: (address) => ({ methods: {
      getListSummary: () => ({ kind: "summary", address }),
      getUserAuctionStatus: () => ({ kind: "status", address }),
    } }) });
    return calls.map((call) => {
      const value = call.kind === "summary" ? summaries[call.address] : statuses[call.address];
      return value instanceof Error ? { status: "rejected", reason: value } : { status: "fulfilled", value };
    });
  });
};

afterEach(() => jest.resetAllMocks());

test("returns only closed auctions that concern the participant, with list-style fields", async () => {
  world({
    summaries: {
      [addr(1)]: summary(), // closed, participated
      [addr(2)]: summary({ closed: false }), // open
      [addr(3)]: summary(), // closed, not involved
      [addr(4)]: summary({ manager: ME }), // closed, mine
      [addr(5)]: summary({ highestBidder: ME }), // closed, leading
    },
    statuses: { [addr(1)]: status(true), [addr(3)]: status(false), [addr(4)]: status(false), [addr(5)]: status(false) },
  });
  const result = await loadParticipantAuctions({ account: ME });
  expect(result.map((a) => a.address)).toEqual([addr(1), addr(4), addr(5)]);
  expect(result[0]).toMatchObject({ closed: true, manager: OTHER, addresses: [ME], isRefunded: false });
  expect(readOnlyCall).toHaveBeenCalledWith(expect.any(Function), undefined, { factoryAddress: "0xfactory" });
});

test("reads in chunks and THROWS when any read failed (an incomplete answer is never 'nothing pending')", async () => {
  const summaries = {};
  for (let n = 0; n < 40; n += 1) summaries[`0x${String(n).padStart(40, "0")}`] = summary({ closed: false });
  world({ summaries, statuses: {} });
  await loadParticipantAuctions({ account: ME });
  expect(readOnlyBatchCall).toHaveBeenCalledTimes(3); // 15 + 15 + 10
  world({ summaries: { [addr(1)]: summary(), [addr(2)]: summary() }, statuses: { [addr(1)]: status(true), [addr(2)]: new Error("rate limited") } });
  await expect(loadParticipantAuctions({ account: ME })).rejects.toThrow(/failed/);
  world({ summaries: { [addr(1)]: new Error("down") }, statuses: {} });
  await expect(loadParticipantAuctions({ account: ME })).rejects.toThrow(/failed/);
});

test("no account, nothing to read", async () => {
  expect(await loadParticipantAuctions({ account: "" })).toEqual([]);
  expect(readOnlyCall).not.toHaveBeenCalled();
});
