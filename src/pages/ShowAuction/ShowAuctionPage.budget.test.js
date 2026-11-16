import React from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ShowAuctionPage from "./ShowAuctionPage";
import { readOnlyCall } from "../../real_ethereum/readOnly";
import { getEthereumAccounts, waitForEthereumProvider } from "../../real_ethereum/ethereumProvider";
import { getRemainingBudget } from "../AuctionsList/AuctionsListPage";

jest.mock("../../components/Layout", () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock("../../components/ContributeForm", () => ({ __esModule: true, default: (props) => <div>Bid form {props.noBudget ? "blocked" : "open"}</div> }));
jest.mock("../AuctionsList/AuctionsListPage", () => ({ getRemainingBudget: jest.fn(), invalidateRemainingBudgetCache: jest.fn(), setRemainingBudgetCache: jest.fn() }));
jest.mock("../../real_ethereum/campaign", () => ({ __esModule: true, default: () => ({ methods: {} }) }));
jest.mock("../../real_ethereum/confidentialData", () => ({ readWinnerData: jest.fn(), clearWinnerDataCooldown: jest.fn() }));
jest.mock("../../real_ethereum/autoFinalize", () => ({ finalizeAuctionIfReady: jest.fn() }));
jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn() }));
jest.mock("../../real_ethereum/socketFactory", () => ({ campaignSocket: jest.fn(() => { throw new Error("no sockets"); }) }));
jest.mock("../../real_ethereum/marketConfig", () => ({ getActiveFactoryAddress: jest.fn() }));
jest.mock("../../real_ethereum/budget", () => ({ notifyBudgetChanged: jest.fn() }));
jest.mock("../../real_ethereum/activeAuctionRegistry", () => ({ markAuctionClosed: jest.fn() }));
jest.mock("../../real_ethereum/ethereumProvider", () => ({ getEthereumAccounts: jest.fn(), waitForEthereumProvider: jest.fn() }));

const flush = async () => { await act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }); };
const setup = async (budget) => {
  jest.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  getEthereumAccounts.mockResolvedValue(["0x00000000000000000000000000000000000000bb"]);
  waitForEthereumProvider.mockResolvedValue({});
  getRemainingBudget.mockResolvedValue(budget);
  const endTime = Math.floor(Date.now() / 1000) + 600;
  readOnlyCall.mockImplementation(async (fn) => {
    const spec = fn({ campaign: () => ({ methods: new Proxy({}, { get: (_, m) => () => ({ method: m }) }) }) });
    if (spec.method === "getListSummary") return ["1", "0", "0", "0x00000000000000000000000000000000000000aa", "0", "d", "0x0000000000000000000000000000000000000000", String(endTime), false];
    if (spec.method === "getUserAuctionStatus") return [false, "0", false];
    return [];
  });
  render(<MemoryRouter initialEntries={["/auction/0xabc"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Routes><Route path="/auction/:address" element={<ShowAuctionPage />} /></Routes></MemoryRouter>);
  await flush();
};
afterEach(() => { jest.useRealTimers(); });

test("budget 0 is shown as 0 and blocks bidding, never 'Unlimited'", async () => {
  await setup("0");
  expect(screen.getByText(/Remaining Budget:/).textContent).toMatch(/Remaining Budget:\s*0/);
  expect(screen.queryByText(/Unlimited/)).toBeNull();
  expect(screen.getByText("No budget left")).toBeTruthy();
  expect(screen.getByText("Bid form blocked")).toBeTruthy();
});

test("a positive budget is plain and bidding stays open", async () => {
  await setup("500");
  expect(screen.getByText(/Remaining Budget:/).textContent).toMatch(/500/);
  expect(screen.queryByText("No budget left")).toBeNull();
  expect(screen.getByText("Bid form open")).toBeTruthy();
});
