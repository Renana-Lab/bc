import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AuctionListHistoryCard from "./AuctionListHistoryCard";
import { buildListState, findBlockAtOrBefore, readAuctionListState } from "./auctionListHistory";

jest.mock("../../real_ethereum/marketConfig", () => ({ getActiveFactoryAddress: () => "0x00000000000000000000000000000000000000f0" }));
jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyExecute: jest.fn(), readOnlyCall: jest.fn() }));

const F = "0x00000000000000000000000000000000000000f0";
const C1 = "0x00000000000000000000000000000000000000c1";
const C2 = "0x00000000000000000000000000000000000000c2";
const C3 = "0x00000000000000000000000000000000000000c3";
const U = "0x0000000000000000000000000000000000000001";
const ADMIN = "0x00000000000000000000000000000000000000aa";

// block n happens at time 1000 + 10 * n
const ts = (block) => 1000 + 10 * block;
let nonce = 0;
const log = (event, address, blockNumber, returnValues) => ({ event, address, blockNumber, logIndex: 0, transactionHash: `0x${++nonce}`, returnValues });

const factoryLogs = [
  log("AuctionCreatedDetailed", F, 10, { campaignAddress: C1, seller: U, minimum: "5", endTime: String(ts(60)), dataDescription: "First" }),
  log("AuctionCreatedDetailed", F, 20, { campaignAddress: C2, seller: U, minimum: "7", endTime: String(ts(200)), dataDescription: "Second" }),
  log("AuctionCreatedDetailed", F, 30, { campaignAddress: C3, seller: U, minimum: "9", endTime: String(ts(300)), dataDescription: "Third" }),
  log("AuctionClosedEarly", F, 40, { campaign: C2, by: ADMIN }),
  log("AuctionCancelled", F, 50, { campaign: C3, by: ADMIN, note: "", fundsReleased: true }),
];
const bidLogs = [
  log("BidRecorded", C1, 12, { bidder: U, amount: "6", cumulativeBid: "6", budgetBefore: "9", budgetAfter: "3", time: String(ts(12)), previousHighestBidder: U, previousHighestBid: "0" }),
  log("BidRecorded", C1, 15, { bidder: U, amount: "9", cumulativeBid: "15", budgetBefore: "3", budgetAfter: "0", time: String(ts(15)), previousHighestBidder: U, previousHighestBid: "6" }),
  log("BidRecorded", C2, 25, { bidder: U, amount: "8", cumulativeBid: "8", budgetBefore: "9", budgetAfter: "1", time: String(ts(25)), previousHighestBidder: U, previousHighestBid: "0" }),
];
const fakeReader = ({ latest = 100, firstBlockTime = ts(0) } = {}) => ({
  getLatestBlock: async () => latest,
  getBlockTimestamp: async (block) => (block === 0 ? firstBlockTime : ts(block)),
  readLogs: async ({ kind, address, names, from, to }) => {
    const addresses = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
    const source = kind === "factory" ? factoryLogs : bidLogs;
    return source.filter((entry) => names.includes(entry.event) && addresses.includes(entry.address.toLowerCase()) && entry.blockNumber >= from && entry.blockNumber <= to);
  },
});

test("findBlockAtOrBefore binary-searches block timestamps", async () => {
  const getBlockTimestamp = async (block) => ts(block);
  expect(await findBlockAtOrBefore({ atSec: ts(37) + 3, from: 0, latest: 100, getBlockTimestamp })).toBe(37);
  expect(await findBlockAtOrBefore({ atSec: ts(500), from: 0, latest: 100, getBlockTimestamp })).toBe(100);
  expect(await findBlockAtOrBefore({ atSec: ts(0) - 1, from: 0, latest: 100, getBlockTimestamp })).toBeNull();
});

test("lists the auctions active at the chosen time with the highest bid then", async () => {
  // at block 35: C1 (ends 60) and C2 (ends 200) are active, C3 is created at 30 and still active; no one closed yet
  const state = await readAuctionListState({ atSec: ts(35), factoryAddress: F, reader: fakeReader(), lookback: 100 });
  expect(state.rows.map((row) => [row.description, row.highestBid])).toEqual([["First", "15"], ["Second", "8"], ["Third", "0"]]);
  expect(state.healthNote).toBe("");
});

test("auctions that ended, were closed early or cancelled before the time are excluded, later bids are ignored", async () => {
  const afterEnd = await readAuctionListState({ atSec: ts(70), factoryAddress: F, reader: fakeReader(), lookback: 100 });
  expect(afterEnd.rows).toEqual([]); // First ended at block 60, Second was closed early at 40, Third cancelled at 50
  const afterClose = await readAuctionListState({ atSec: ts(45), factoryAddress: F, reader: fakeReader(), lookback: 100 });
  expect(afterClose.rows.map((row) => row.description)).toEqual(["First", "Third"]); // Second closed early at 40
  const afterCancel = await readAuctionListState({ atSec: ts(55), factoryAddress: F, reader: fakeReader(), lookback: 100 });
  expect(afterCancel.rows.map((row) => row.description)).toEqual(["First"]);
  const early = await readAuctionListState({ atSec: ts(13), factoryAddress: F, reader: fakeReader(), lookback: 100 });
  expect(early.rows.map((row) => [row.description, row.highestBid])).toEqual([["First", "6"]]); // 2nd bid at block 15 is later; C2 not created
});

test("a time older than the loaded range is reported instead of guessed", async () => {
  const state = await readAuctionListState({ atSec: ts(0) - 500, factoryAddress: F, reader: fakeReader({ latest: 100 }), lookback: 50 });
  expect(state.outOfRange).toBe(true);
  expect(state.rows).toEqual([]);
});

test("buildListState needs a block; incomplete reads add a note", async () => {
  expect(buildListState({ atSec: 1, blockAtT: null })).toEqual([]);
  const reader = fakeReader();
  const failing = { ...reader, readLogs: async (args) => { if (args.from <= 20 && args.to >= 20) throw new Error("range failed"); return reader.readLogs(args); } };
  const state = await readAuctionListState({ atSec: ts(35), factoryAddress: F, reader: failing, lookback: 100 });
  expect(state.healthNote).toMatch(/ranges failed/);
});

test("the card takes a date-time, shows the table and the range note", async () => {
  const readState = jest.fn(async () => ({
    rows: [{ address: C1, description: "First", highestBid: "15", endTimeSec: 1700000000, minimum: "5" }],
    healthNote: "1 of 3 ranges failed", outOfRange: false, from: 1, latest: 9, lookback: 9, blockAtT: 5,
  }));
  render(<AuctionListHistoryCard defaultOpen readState={readState} createReader={() => ({})} />);
  expect(screen.getByRole("button", { name: "Inspect state" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/State at/), { target: { value: "2026-01-02T10:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect state" }));
  await waitFor(() => expect(screen.getByText("First", { exact: false })).toBeInTheDocument());
  expect(readState).toHaveBeenCalledWith(expect.objectContaining({ atSec: Math.floor(new Date("2026-01-02T10:30").getTime() / 1000) }));
  expect(screen.getByText("15")).toBeInTheDocument();
  expect(screen.getByTestId("history-incomplete")).toHaveTextContent("1 of 3 ranges failed");
  for (const header of ["Auction", "Highest bid", "End time"]) expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
});
