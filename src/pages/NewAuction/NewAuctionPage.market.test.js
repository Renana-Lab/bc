import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NewAuctionPage from "./NewAuctionPage";
import { readOnlyCall } from "../../real_ethereum/readOnly";
import { scanParticipantView } from "../../tests/participantWording";

jest.mock("../../components/Layout", () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock("../ManageBudget/useAdminAccess", () => ({ useAdminAccess: () => ({ isAdmin: false }) }));
jest.mock("../../real_ethereum/factory", () => ({ __esModule: true, default: { methods: {} } }));
jest.mock("../../real_ethereum/web3", () => ({ __esModule: true, default: { eth: { getAccounts: async () => [] } } }));
jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn() }));
jest.mock("../../real_ethereum/ethereumProvider", () => ({
  requestEthereumAccounts: async () => [],
  waitForEthereumProvider: async () => ({}),
}));
jest.mock("../../real_ethereum/activeAuctionRegistry", () => ({ registerCreatedAuctionReceipt: jest.fn(), getCreatedAuctionAddress: () => "" }));
jest.mock("../../real_ethereum/marketConfig", () => ({
  getActiveMarket: () => ({ address: "0xfactory00000000000000000000000000000001", label: "Test market" }),
  getMarketOptions: () => [],
  subscribeToMarketChanges: () => () => {},
}));

const renderPage = async () => {
  const view = render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><NewAuctionPage /></MemoryRouter>);
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
  return view;
};
const openMinBidHelp = () => fireEvent.click(screen.getByRole("button", { name: "Info about Minimum Bid" }));
afterEach(() => { delete process.env.REACT_APP_WALLET_MODE; });

test.each([
  [true, "The lowest price you are willing to accept for selling your information (in cents). You can change this price at any time before the first bid is placed."],
  [false, "The lowest price you are willing to accept for selling your information (in cents)."],
])("local mode, allowSellerEdit=%s: market tooltip with cents", async (allowed, text) => {
  process.env.REACT_APP_WALLET_MODE = "local";
  readOnlyCall.mockResolvedValue(allowed);
  const { container } = await renderPage();
  openMinBidHelp();
  expect(screen.getByText(text)).toBeTruthy();
  expect(screen.getByAltText("Create a data auction")).toBeTruthy();
  expect(scanParticipantView(container)).toEqual({ words: [], addresses: [] });
});

test("local mode: a failed allowSellerEdit read leaves out the edit sentence", async () => {
  process.env.REACT_APP_WALLET_MODE = "local";
  readOnlyCall.mockRejectedValue(new Error("rpc"));
  await renderPage();
  openMinBidHelp();
  expect(screen.getByText("The lowest price you are willing to accept for selling your information (in cents).")).toBeTruthy();
});

test("local mode: the byte counter under Data For Sell is unchanged", async () => {
  process.env.REACT_APP_WALLET_MODE = "local";
  readOnlyCall.mockResolvedValue(false);
  await renderPage();
  expect(screen.getByText(/^0 \/ \d+ bytes$/)).toBeTruthy();
});

test("MetaMask mode keeps the original tooltip and alt text and never reads the factory flag", async () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  readOnlyCall.mockClear();
  await renderPage();
  openMinBidHelp();
  expect(screen.getByText("The lowest price you are willing to accept for selling your information (in wei).")).toBeTruthy();
  expect(screen.getByAltText("Create a blockchain data auction")).toBeTruthy();
  expect(readOnlyCall).not.toHaveBeenCalled();
});
