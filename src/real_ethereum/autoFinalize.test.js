import { finalizeAuctionIfReady } from "./autoFinalize";

const mockSend = jest.fn();
let mockState;
jest.mock("./campaign", () => () => ({
  methods: {
    getSummary: () => ({ call: async () => mockState.summary }),
    getStatus: () => ({ call: async () => mockState.closed }),
    finalizeAuctionIfNeeded: () => ({ send: (...a) => mockSend(...a) }),
  },
}));
jest.mock("./chainClock", () => ({ chainNowMs: () => 1_000_000_000 }));

const summary = (endSec) => { const s = []; s[6] = "0x0000000000000000000000000000000000000000"; s[8] = String(endSec); return s; };
beforeEach(() => { mockSend.mockReset().mockResolvedValue({}); });

test("finalizes an ended, open auction", async () => {
  mockState = { closed: false, summary: summary(999_999) };
  await expect(finalizeAuctionIfReady("0xa", "0xb")).resolves.toEqual({ finalized: true, reason: "finalized" });
  expect(mockSend).toHaveBeenCalledWith({ from: "0xb" });
});

test("reports not-ended when the chain clock says the auction is still running", async () => {
  mockState = { closed: false, summary: summary(1_000_001) };
  await expect(finalizeAuctionIfReady("0xa", "0xb")).resolves.toEqual({ finalized: false, reason: "not-ended" });
  expect(mockSend).not.toHaveBeenCalled();
});

test("reports already-closed without sending", async () => {
  mockState = { closed: true, summary: summary(999_999) };
  await expect(finalizeAuctionIfReady("0xa", "0xb")).resolves.toEqual({ finalized: false, reason: "already-closed" });
  expect(mockSend).not.toHaveBeenCalled();
});
