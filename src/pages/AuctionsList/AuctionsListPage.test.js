import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AuctionsListPage from "./AuctionsListPage";
import { readOnlyCall, readOnlyBatchCall } from "../../real_ethereum/readOnly";

jest.mock("../../components/Layout", () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn(), readOnlyBatchCall: jest.fn() }));
jest.mock("../../real_ethereum/socketFactory", () => ({
  campaignSocket: jest.fn(() => { throw new Error("no sockets"); }),
  factorySocket: jest.fn(() => { throw new Error("no sockets"); }),
  shouldLimitLiveEventLoad: () => true,
}));
jest.mock("../../real_ethereum/ethereumProvider", () => ({ getEthereumAccounts: jest.fn(async () => []) }));
jest.mock("../../real_ethereum/activeAuctionRegistry", () => ({ publishActiveAuctions: jest.fn() }));

const FACTORY_A = "0x00000000000000000000000000000000000000a1";
const FACTORY_B = "0x00000000000000000000000000000000000000b2";
const LOADING = "Finding the latest auctions";
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }); };
const storage = (key) => window.dispatchEvent(new StorageEvent("storage", { key, newValue: "x" }));
const renderPage = () => render(
  <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuctionsListPage /></MemoryRouter>,
);

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("data-market:factory-address:sapphire-v1", FACTORY_A);
  // An empty market: zero auctions.
  readOnlyCall.mockResolvedValue("0");
  readOnlyBatchCall.mockResolvedValue([]);
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("unrelated storage keys (rpc-health, caches, registry) never reset to the loading state", async () => {
  const view = renderPage();
  await flush();
  expect(screen.queryByText(LOADING)).toBeNull();
  const shell = view.container.querySelector(".MuiTableContainer-root");
  expect(shell).toBeTruthy();
  const calls = readOnlyCall.mock.calls.length;

  for (const key of ["data-market:rpc-health:v1", "data-market:auctions:v5:x", "data-market:active-auctions"]) {
    act(() => storage(key));
    expect(screen.queryByText(LOADING)).toBeNull();
    expect(view.container.querySelector(".MuiTableContainer-root")).toBe(shell); // same node: not remounted
  }
  await flush();
  expect(readOnlyCall.mock.calls.length).toBe(calls);
});

test("two tabs writing rpc-health do not cause repeated reloads", async () => {
  const view = renderPage();
  await flush();
  const shell = view.container.querySelector(".MuiTableContainer-root");
  const calls = readOnlyCall.mock.calls.length;
  for (let i = 0; i < 20; i += 1) {
    act(() => { storage("data-market:rpc-health:v1"); storage("data-market:rpc-health:v1"); });
    await flush();
  }
  expect(screen.queryByText(LOADING)).toBeNull();
  expect(view.container.querySelector(".MuiTableContainer-root")).toBe(shell);
  expect(readOnlyCall.mock.calls.length).toBe(calls);
});

test("a real factory change from another tab still reloads the list", async () => {
  readOnlyCall.mockImplementation(() => new Promise(() => {})); // keep the reload visible
  const view = renderPage();
  await flush();
  readOnlyCall.mockResolvedValue("0");
  window.localStorage.setItem("data-market:factory-address:sapphire-v1", FACTORY_B);
  act(() => storage("data-market:factory-address:sapphire-v1"));
  expect(screen.queryByText(LOADING)).toBeTruthy();
  await flush();
  expect(screen.queryByText(LOADING)).toBeNull();
  view.unmount();
});

test("a label-only market event does not reload", async () => {
  const view = renderPage();
  await flush();
  window.localStorage.setItem("data-market:market-label", "Renamed");
  act(() => storage("data-market:market-label"));
  expect(screen.queryByText(LOADING)).toBeNull();
  view.unmount();
});

test("the table header lists Minimum Bid between Auction Status and Highest Bid", async () => {
  renderPage();
  await flush();
  const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
  expect(headers).toEqual([
    "Description", "End Date", "Auction Status", "Minimum Bid", "Highest Bid",
    "Number Of Bidders", "Payment Status", "",
  ]);
});

test("a row shows the minimum bid with locale grouping and a row tooltip", async () => {
  const { AuctionTableRow } = jest.requireActual("./AuctionsListPage");
  const auction = {
    address: "0xabc", dataDescription: "shoe size", endTime: Date.now() + 600000, minimumContribution: "1234567",
    highestBid: "5000", approversCount: 2, highestBidder: "0x1", manager: "0x2", addresses: [], closed: false,
  };
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <table><tbody><AuctionTableRow auction={auction} currentUserAddress="0x3" boundaryClock={Date.now()} onOpen={() => {}} /></tbody></table>
    </MemoryRouter>,
  );
  const cells = screen.getAllByRole("cell").map((cell) => cell.textContent);
  expect(cells[3]).toBe((1234567).toLocaleString());
  expect(cells[4]).toBe("5000");
  await act(async () => { fireEvent.mouseOver(screen.getByRole("button", { name: "View Auction" })); });
  expect(await screen.findByText(/Review the data description and minimum/)).toBeTruthy();
});
