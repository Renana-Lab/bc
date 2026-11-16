import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import ShowAuctionPage from "./ShowAuctionPage";
import { readOnlyCall } from "../../real_ethereum/readOnly";
import { getEthereumAccounts, waitForEthereumProvider } from "../../real_ethereum/ethereumProvider";
import { finalizeAuctionIfReady } from "../../real_ethereum/autoFinalize";
import { readWinnerData, clearWinnerDataCooldown } from "../../real_ethereum/confidentialData";

const mockWithdraw = jest.fn();
jest.mock("../../components/Layout", () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock("../../components/ContributeForm", () => ({ __esModule: true, default: () => <div>Bid form</div> }));
jest.mock("../AuctionsList/AuctionsListPage", () => ({
  getRemainingBudget: jest.fn(async () => "1000"), invalidateRemainingBudgetCache: jest.fn(), setRemainingBudgetCache: jest.fn(),
}));
jest.mock("../../real_ethereum/campaign", () => ({
  __esModule: true,
  default: () => ({ methods: { withdrawRefund: () => ({ send: (...args) => mockWithdraw(...args) }) } }),
}));
jest.mock("../../real_ethereum/confidentialData", () => ({ readWinnerData: jest.fn(), clearWinnerDataCooldown: jest.fn() }));
jest.mock("../../real_ethereum/autoFinalize", () => ({ finalizeAuctionIfReady: jest.fn() }));
jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn() }));
jest.mock("../../real_ethereum/socketFactory", () => ({ campaignSocket: jest.fn(() => { throw new Error("no sockets"); }) }));
jest.mock("../../real_ethereum/marketConfig", () => ({ getActiveFactoryAddress: jest.fn() }));
jest.mock("../../real_ethereum/budget", () => ({ notifyBudgetChanged: jest.fn() }));
jest.mock("../../real_ethereum/activeAuctionRegistry", () => ({ markAuctionClosed: jest.fn() }));
jest.mock("../../real_ethereum/ethereumProvider", () => ({
  getEthereumAccounts: jest.fn(), waitForEthereumProvider: jest.fn(),
}));

const DONE = { finalized: true, reason: "finalized" };
const seller = "0x00000000000000000000000000000000000000aa";
const winner = "0x00000000000000000000000000000000000000bb";
const loser = "0x00000000000000000000000000000000000000cc";
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }); };

const mockChain = ({ endOffsetSec, closed = false, userBid = "0", refunded = false, participated = true }) => {
  const endTime = Math.floor(Date.now() / 1000) + endOffsetSec;
  readOnlyCall.mockImplementation(async (fn) => {
    const spec = fn({ campaign: () => ({ methods: new Proxy({}, { get: (_, method) => () => ({ method }) }) }) });
    if (spec.method === "getListSummary") {
      return ["1", "0", "2", seller, "50", "desc", winner, String(endTime), typeof closed === "function" ? closed() : closed];
    }
    if (spec.method === "getTransactions") return [];
    if (spec.method === "getUserAuctionStatus") return [participated, userBid, refunded];
    return null;
  });
};
const NavSwitch = () => { const navigate = useNavigate(); return <button onClick={() => navigate("/auction/0xdef")}>to-other</button>; };
const renderPage = () => render(
  <MemoryRouter initialEntries={["/auction/0xabc"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Routes><Route path="/auction/:address" element={<ShowAuctionPage />} /></Routes>
  </MemoryRouter>,
);
const advance = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms); }); await flush(); };

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  waitForEthereumProvider.mockResolvedValue({});
  finalizeAuctionIfReady.mockReset().mockResolvedValue(DONE);
  readWinnerData.mockReset();
  clearWinnerDataCooldown.mockReset();
  mockWithdraw.mockReset().mockResolvedValue({});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test.each([["winner", winner], ["loser", loser], ["seller", seller]])(
  "an ended, not-yet-closed auction is finalized exactly once for the %s",
  async (_role, account) => {
    getEthereumAccounts.mockResolvedValue([account]);
    mockChain({ endOffsetSec: -60, userBid: "10" });
    renderPage(); await flush();
    expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(1);
    expect(finalizeAuctionIfReady).toHaveBeenCalledWith("0xabc", account);
    // Polling keeps refetching; it must never re-trigger finalize.
    await advance(120000);
    expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(1);
  },
);

test("no finalize while the auction is still active", async () => {
  getEthereumAccounts.mockResolvedValue([winner]);
  mockChain({ endOffsetSec: 600 });
  renderPage(); await flush();
  await advance(30000);
  expect(finalizeAuctionIfReady).not.toHaveBeenCalled();
});

test("a failed finalize shows a message once and never loops", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  mockChain({ endOffsetSec: -60, userBid: "10" });
  finalizeAuctionIfReady.mockRejectedValue(new Error("insufficient funds for gas"));
  renderPage(); await flush();
  expect(screen.getByRole("alert").textContent).toMatch(/Not enough funds to pay the network fee/);
  expect(screen.queryByText(/insufficient funds for gas/)).toBeNull();
  await advance(120000);
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(1);
});

test("a finalize race (already finalized) stays silent once the refetch shows it closed", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  let closed = false;
  mockChain({ endOffsetSec: -60, userBid: "10", closed: () => closed });
  finalizeAuctionIfReady.mockImplementation(async () => { closed = true; throw new Error("execution reverted: Auction already finalized"); });
  renderPage(); await flush();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
});

test("a race that still reads as not closed after the refetch shows the Finalize button", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  mockChain({ endOffsetSec: -60, userBid: "10" });
  finalizeAuctionIfReady.mockRejectedValue(new Error("Auction already finalized"));
  renderPage(); await flush();
  expect(screen.getByRole("alert").textContent).toMatch(/could not confirm/);
  expect(screen.getByRole("button", { name: "Finalize" })).toBeTruthy();
});

test("a generic EVM revert is not treated as a race: it shows the Finalize button", async () => {
  getEthereumAccounts.mockResolvedValue([winner]);
  mockChain({ endOffsetSec: -60 });
  finalizeAuctionIfReady.mockRejectedValue(new Error("Transaction has been reverted by the EVM"));
  renderPage(); await flush();
  expect(screen.getByRole("alert").textContent).toMatch(/Could not finalize the auction automatically/);
  expect(screen.getByRole("button", { name: "Finalize" })).toBeTruthy();
  await advance(60000);
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(1);
});

test("a not-ended result from the helper (clock ahead of the block) is retried, not treated as success", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  mockChain({ endOffsetSec: -60, userBid: "10" });
  finalizeAuctionIfReady
    .mockResolvedValueOnce({ finalized: false, reason: "not-ended" })
    .mockResolvedValue(DONE);
  renderPage(); await flush();
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Finalizing auction...")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  await advance(1500);
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(2);
});

test("repeated not-ended results stop after 3 attempts and show the Finalize button", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  mockChain({ endOffsetSec: -60, userBid: "10" });
  finalizeAuctionIfReady.mockResolvedValue({ finalized: false, reason: "not-ended" });
  renderPage(); await flush();
  for (let i = 0; i < 6; i += 1) await advance(1500);
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("button", { name: "Finalize" })).toBeTruthy();
});

test("shows a neutral status while finalizing", async () => {
  getEthereumAccounts.mockResolvedValue([winner]);
  mockChain({ endOffsetSec: -60 });
  finalizeAuctionIfReady.mockReturnValue(new Promise(() => {}));
  renderPage(); await flush();
  expect(screen.getByText("Finalizing auction...")).toBeTruthy();
});

test("a winner data failure shows an inline error and Try again works", async () => {
  getEthereumAccounts.mockResolvedValue([winner]);
  mockChain({ endOffsetSec: -60, closed: true, userBid: "50" });
  readWinnerData.mockRejectedValueOnce(new Error("Signature rejected"));
  renderPage(); await flush();
  fireEvent.click(screen.getByText("View Data"));
  expect(screen.getByRole("alert").textContent).toMatch(/Signature rejected/);
  readWinnerData.mockResolvedValue("the-secret-data");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await flush(); await advance(1000);
  expect(clearWinnerDataCooldown).toHaveBeenCalledWith("0xabc", winner);
  expect(screen.getByText("the-secret-data")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("the winner sees Preparing your data until the auction is closed", async () => {
  getEthereumAccounts.mockResolvedValue([winner]);
  mockChain({ endOffsetSec: -60, closed: false });
  finalizeAuctionIfReady.mockReturnValue(new Promise(() => {}));
  renderPage(); await flush();
  fireEvent.click(screen.getByText("View Data"));
  expect(screen.getByText("Preparing your data...")).toBeTruthy();
  expect(screen.queryByText("Data acquired:")).toBeNull();
});

test("a loser with a refund sees honest text and a Claim refund button", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  mockChain({ endOffsetSec: -60, closed: true, userBid: "10" });
  mockWithdraw.mockRejectedValue(new Error("boom"));
  renderPage(); await flush();
  expect(screen.getByText(/Your bid can be refunded\. Press Claim refund now\./)).toBeTruthy();
  expect(screen.queryByText(/queued automatically/)).toBeNull();
  expect(screen.getByRole("button", { name: "Claim refund now" })).toBeTruthy();
  // The automatic claim fired once and failed visibly; it does not retry.
  expect(mockWithdraw).toHaveBeenCalledTimes(1);
  await advance(60000);
  expect(mockWithdraw).toHaveBeenCalledTimes(1);
});

test("the loser's refund is claimed automatically once after finalize", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  mockChain({ endOffsetSec: -60, closed: true, userBid: "10" });
  renderPage(); await flush();
  expect(mockWithdraw).toHaveBeenCalledTimes(1);
  expect(mockWithdraw).toHaveBeenCalledWith({ from: loser });
});

test("the winner's data opens in a View Data dialog with the description and a Close button", async () => {
  getEthereumAccounts.mockResolvedValue([winner]);
  mockChain({ endOffsetSec: -60, closed: true, userBid: "50" });
  readWinnerData.mockResolvedValue("the-secret-data");
  renderPage(); await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByText("View Data"));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toMatch(/Data acquired/);
  expect(dialog.textContent).toMatch(/desc/);
  expect(dialog.textContent).toMatch(/the-secret-data/);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(screen.queryByRole("dialog")).toBeNull();
});

const notEnded = () => new Error("execution reverted: Auction not ended yet");

test("a 'not ended yet' revert is retried once at endTime + 3 s chain time and then succeeds", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  // Ended 100 ms ago on our clock, but the chain says it is not over yet.
  const endTime = Math.floor(Date.now() / 1000);
  mockChain({ endOffsetSec: 0, userBid: "10" });
  finalizeAuctionIfReady.mockRejectedValueOnce(notEnded()).mockResolvedValue(DONE);
  renderPage(); await flush();
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Finalizing auction...")).toBeTruthy();
  await advance(500);
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(1); // not before the retry time
  await advance(endTime * 1000 + 3000 - Date.now() + 1500);
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(2);
  await advance(120000);
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(2);
});

test("after 3 failed attempts a Finalize button appears for any participant and works once", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  mockChain({ endOffsetSec: -60, userBid: "10" });
  finalizeAuctionIfReady.mockRejectedValue(notEnded());
  renderPage(); await flush();
  for (let i = 0; i < 6; i += 1) await advance(1500); // each retry is scheduled after the previous one fails
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("alert").textContent).toMatch(/not ready to be finalized yet/);
  await advance(120000);
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(3); // never loops
  finalizeAuctionIfReady.mockResolvedValue(DONE);
  fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
  await flush();
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(4);
});

test("a non-retryable failure offers the Finalize button without retrying", async () => {
  getEthereumAccounts.mockResolvedValue([winner]);
  mockChain({ endOffsetSec: -60 });
  finalizeAuctionIfReady.mockRejectedValue(new Error("insufficient funds for gas"));
  renderPage(); await flush();
  await advance(20000);
  expect(finalizeAuctionIfReady).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Finalize" })).toBeTruthy();
});

test("finalize/refund/winner state does not leak to another auction when the address changes", async () => {
  getEthereumAccounts.mockResolvedValue([loser]);
  mockChain({ endOffsetSec: -60, userBid: "10" });
  finalizeAuctionIfReady.mockRejectedValue(new Error("Transaction has been reverted by the EVM"));
  render(
    <MemoryRouter initialEntries={["/auction/0xabc"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/auction/:address" element={<ShowAuctionPage />} /></Routes>
      <NavSwitch />
    </MemoryRouter>,
  );
  await flush();
  expect(screen.getByRole("button", { name: "Finalize" })).toBeTruthy();
  finalizeAuctionIfReady.mockReturnValue(new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "to-other" }));
  await flush();
  // The old failure banner is gone; the new auction starts its own finalize ("pending").
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Finalizing auction...")).toBeTruthy();
});
