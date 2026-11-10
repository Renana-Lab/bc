import React from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { getRemainingBudget } from "../AuctionsList/AuctionsListPage";
import { campaignSocket } from "../../real_ethereum/socketFactory";
import ShowAuctionPage from "./ShowAuctionPage";
import { readOnlyCall } from "../../real_ethereum/readOnly";
import { getEthereumAccounts, waitForEthereumProvider } from "../../real_ethereum/ethereumProvider";

jest.mock("../../components/Layout", () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock("../../components/ContributeForm", () => ({ __esModule: true, default: () => <div>Bid form</div> }));
jest.mock("../AuctionsList/AuctionsListPage", () => ({
  getRemainingBudget: jest.fn(), invalidateRemainingBudgetCache: jest.fn(), setRemainingBudgetCache: jest.fn(),
}));
jest.mock("../../real_ethereum/campaign", () => ({ __esModule: true, default: () => ({ methods: {} }) }));
jest.mock("../../real_ethereum/confidentialData", () => ({ readWinnerData: jest.fn(async () => "") }));
jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn() }));
jest.mock("../../real_ethereum/socketFactory", () => ({ campaignSocket: jest.fn(() => { throw new Error("no sockets"); }) }));
jest.mock("../../real_ethereum/marketConfig", () => ({ getActiveFactoryAddress: jest.fn() }));
jest.mock("../../real_ethereum/budget", () => ({ notifyBudgetChanged: jest.fn() }));
jest.mock("../../real_ethereum/activeAuctionRegistry", () => ({ markAuctionClosed: jest.fn() }));
jest.mock("../../real_ethereum/ethereumProvider", () => ({
  getEthereumAccounts: jest.fn(), waitForEthereumProvider: jest.fn(),
}));

const manager = "0x00000000000000000000000000000000000000aa";
const visitor = "0x00000000000000000000000000000000000000bb";
const flush = async () => { await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }); };

// getListSummary: [min, _, approvers, manager, highestBid, desc, highestBidder, endTime, closed]
const summary = (endTime, closed) => ["1", "0", "0", manager, "0", "desc", "0x0000000000000000000000000000000000000000", String(endTime), closed];
const mockChain = (endTime, closed = false) => {
  readOnlyCall.mockImplementation(async (fn) => {
    const name = [];
    const proxy = (path) => new Proxy(() => {}, {
      get: (_, key) => proxy([...path, key]),
      apply: () => ({ path }),
    });
    const spec = fn({ campaign: () => ({ methods: new Proxy({}, { get: (_, method) => () => ({ method }) }) }) });
    const method = spec?.method; name.push(method);
    if (method === "getListSummary") return summary(endTime, closed);
    if (method === "getTransactions") return [];
    if (method === "getUserAuctionStatus") return [false, "0", false];
    return null;
  });
};
const renderPage = () => render(
  <MemoryRouter initialEntries={["/auction/0xabc"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Routes><Route path="/auction/:address" element={<ShowAuctionPage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  getEthereumAccounts.mockResolvedValue([visitor]);
  waitForEthereumProvider.mockResolvedValue({});
  getRemainingBudget.mockResolvedValue("1000");
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { jest.useRealTimers(); });

test("the bid form disappears when the end time passes while the page is open", async () => {
  const endTime = Math.floor(Date.now() / 1000) + 5;
  mockChain(endTime);
  renderPage(); await flush();
  expect(screen.getByText("Bid form")).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(6000); });
  expect(screen.queryByText("Bid form")).toBeNull();
});

test("a non-participant sees that the auction ended and awaits finalization", async () => {
  mockChain(Math.floor(Date.now() / 1000) - 60, false);
  renderPage(); await flush();
  expect(screen.queryByText("Bid form")).toBeNull();
  expect(screen.getByText("This auction has ended and is awaiting finalization.")).toBeTruthy();
});

test("a non-participant sees a plain ended message once the auction is closed", async () => {
  mockChain(Math.floor(Date.now() / 1000) - 60, true);
  renderPage(); await flush();
  expect(screen.getByText("This auction has ended.")).toBeTruthy();
});
