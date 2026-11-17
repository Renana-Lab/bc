import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ShowAuctionPage from "./ShowAuctionPage";
import { readOnlyCall } from "../../real_ethereum/readOnly";
import { getEthereumAccounts, waitForEthereumProvider } from "../../real_ethereum/ethereumProvider";
import { scanParticipantView } from "../../tests/participantWording";

jest.mock("../../components/Layout", () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock("../../components/ContributeForm", () => ({ __esModule: true, default: () => <div>Bid form</div> }));
jest.mock("../AuctionsList/AuctionsListPage", () => ({
  getRemainingBudget: jest.fn(async () => "1000"), invalidateRemainingBudgetCache: jest.fn(), setRemainingBudgetCache: jest.fn(),
}));
jest.mock("../../real_ethereum/campaign", () => ({
  __esModule: true,
  default: () => ({ methods: { withdrawRefund: () => ({ send: async () => ({}) }) } }),
}));
jest.mock("../../real_ethereum/confidentialData", () => ({ readWinnerData: jest.fn(async () => "my secret"), clearWinnerDataCooldown: jest.fn() }));
jest.mock("../../real_ethereum/autoFinalize", () => ({ finalizeAuctionIfReady: jest.fn(async () => ({ finalized: true })) }));
jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn() }));
jest.mock("../../real_ethereum/socketFactory", () => ({ campaignSocket: jest.fn(() => { throw new Error("no sockets"); }) }));
jest.mock("../../real_ethereum/marketConfig", () => ({ getActiveFactoryAddress: jest.fn() }));
jest.mock("../../real_ethereum/budget", () => ({ notifyBudgetChanged: jest.fn() }));
jest.mock("../../real_ethereum/activeAuctionRegistry", () => ({ markAuctionClosed: jest.fn() }));
jest.mock("../../real_ethereum/ethereumProvider", () => ({ getEthereumAccounts: jest.fn(), waitForEthereumProvider: jest.fn() }));

const AUCTION = "0x00000000000000000000000000000000000000d1";
const seller = "0x00000000000000000000000000000000000000aa";
const me = "0x00000000000000000000000000000000000000bb";
const other = "0x00000000000000000000000000000000000000cc";
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }); };
const methodCalls = [];

// getListSummary: [min, _, approvers, manager, highestBid, desc, highestBidder, endTime, closed]
const mockChain = ({ endOffsetSec = 600, closed = false, highestBidder = other, highestBid = "50", transactions = [], fail = false }) => {
  const endTime = Math.floor(Date.now() / 1000) + endOffsetSec;
  methodCalls.length = 0;
  readOnlyCall.mockImplementation(async (fn) => {
    if (fail) throw new Error("rpc down");
    const spec = fn({ campaign: () => ({ methods: new Proxy({}, { get: (_, method) => () => ({ method }) }) }) });
    methodCalls.push(spec.method);
    if (spec.method === "getListSummary") return ["10", "0", "2", seller, highestBid, "shoe size", highestBidder, String(endTime), closed];
    if (spec.method === "getTransactions") return transactions;
    if (spec.method === "getUserAuctionStatus") return [false, "0", false];
    return null;
  });
};
const renderPage = () => render(
  <MemoryRouter initialEntries={[`/auction/${AUCTION}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Routes>
      <Route path="/auction/:address" element={<ShowAuctionPage />} />
      <Route path="/auctions-list" element={<h1>List page</h1>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.sessionStorage.clear();
  process.env.REACT_APP_WALLET_MODE = "local";
  waitForEthereumProvider.mockResolvedValue({});
  getEthereumAccounts.mockResolvedValue([me]);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); delete process.env.REACT_APP_WALLET_MODE; });

const TX = [{ bidderAddress: other, value: "50", time: "1700000000" }];

describe("heading and details (both modes)", () => {
  test("h1 is the description, the address is a small subtitle", async () => {
    mockChain({});
    const { container } = renderPage(); await flush();
    expect(container.querySelector("h1").textContent).toBe("shoe size");
    expect(container.querySelector("h1").textContent).not.toMatch(/0x/);
    const subtitle = screen.getByText(/^Auction #/);
    expect(subtitle.textContent).toBe("Auction # 0x0000...00d1"); // shortened in local mode
    expect(subtitle.querySelector("[title]").getAttribute("title")).toBe(AUCTION);
  });

  test("time left stays visible after the end and shows the Closed pill", async () => {
    mockChain({ endOffsetSec: -60, closed: true });
    renderPage(); await flush();
    expect(screen.getByText("Time left:")).toBeTruthy();
    expect(screen.getByText("Closed")).toBeTruthy();
  });
});

describe("market wording in local mode", () => {
  test.each([
    ["open, leading", { highestBidder: me }],
    ["open, outbid", {}],
    ["won", { endOffsetSec: -60, closed: true, highestBidder: me }],
  ])("%s: market labels, no unit hint, nothing forbidden, no full address", async (_name, chain) => {
    mockChain(chain);
    const { container } = renderPage(); await flush();
    for (const label of ["Seller identifier:", "Minimum bid required:", "Highest bid recorded:"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText("(?)")).toBeNull();
    expect(scanParticipantView(container)).toEqual({ words: [], addresses: [] });
    const seller$ = screen.getByTitle(seller);
    expect(seller$.textContent).toBe("0x0000...00aa");
  });

  test("the seller of a closed auction (own closed) sees no forbidden wording either", async () => {
    getEthereumAccounts.mockResolvedValue([seller]);
    mockChain({ endOffsetSec: -60, closed: true, transactions: TX });
    const { container } = renderPage(); await flush();
    expect(screen.getByRole("button", { name: "Display Bidding History" })).toBeTruthy();
    expect(scanParticipantView(container)).toEqual({ words: [], addresses: [] });
  });

  test("MetaMask mode keeps the original labels and the full address", async () => {
    process.env.REACT_APP_WALLET_MODE = "metamask";
    mockChain({});
    renderPage(); await flush();
    for (const label of ["Seller address:", "Minimum bid:", "Highest bid:"]) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(`Auction # ${AUCTION}`)).toBeTruthy();
    expect(screen.getAllByText("(?)").length).toBeGreaterThan(0);
  });
});

describe("bid position marker", () => {
  test("leading while open", async () => {
    mockChain({ highestBidder: me });
    renderPage(); await flush();
    expect(screen.getByText("You are leading")).toBeTruthy();
    expect(screen.queryByText("You won")).toBeNull();
  });
  test("won once closed", async () => {
    mockChain({ endOffsetSec: -60, closed: true, highestBidder: me });
    renderPage(); await flush();
    expect(screen.getByText("You won", { selector: "span[role=status]" })).toBeTruthy();
    expect(screen.queryByText("You are leading")).toBeNull();
  });
  test("neither when somebody else leads", async () => {
    mockChain({ highestBidder: other });
    renderPage(); await flush();
    expect(screen.queryByText("You are leading")).toBeNull();
    expect(screen.queryByText("You won", { selector: "span[role=status]" })).toBeNull();
  });
  test("neither without bids even if the zero address leads", async () => {
    mockChain({ highestBidder: me, highestBid: "0" });
    renderPage(); await flush();
    expect(screen.queryByText("You are leading")).toBeNull();
  });
});

describe("seller bidding history", () => {
  test("the seller opens the history while the auction is still open", async () => {
    getEthereumAccounts.mockResolvedValue([seller]);
    mockChain({ transactions: TX });
    renderPage(); await flush();
    expect(methodCalls).toContain("getTransactions");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Display Bidding History" })); });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Bidding History")).toBeTruthy();
    expect(within(dialog).getAllByText("0x0000...00cc").length).toBeGreaterThan(0); // shortened in local mode
    expect(within(dialog).getByText("Tx Amount")).toBeTruthy();
    expect(within(dialog).getByText("Cumulative Bid")).toBeTruthy();
    expect(scanParticipantView(dialog)).toEqual({ words: [], addresses: [] });
  });

  describe("bidder labels in the history", () => {
    const BOT = "0x00000000000000000000000000000000000000ee";
    const openHistory = async () => {
      getEthereumAccounts.mockResolvedValue([seller]);
      mockChain({ transactions: [{ bidderAddress: BOT, value: "5", time: "1700000000" }, ...TX], highestBidder: BOT });
      renderPage(); await flush();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Display Bidding History" })); });
      return screen.getByRole("dialog");
    };
    afterEach(() => { delete process.env.REACT_APP_BIDDER_NAMES; });

    test("a configured bot name replaces the address, an unnamed bidder is shortened in local mode", async () => {
      process.env.REACT_APP_BIDDER_NAMES = JSON.stringify({ [BOT]: "Bot Alpha" });
      const dialog = await openHistory();
      expect(within(dialog).getAllByText(/Bot Alpha/).length).toBeGreaterThanOrEqual(2); // highest bidder line and table row
      expect(within(dialog).getAllByText("0x0000...00cc").length).toBeGreaterThan(0);
      expect(within(dialog).queryByText(other)).toBeNull();
    });

    test("MetaMask mode shows the full address for an unnamed bidder and still the bot name", async () => {
      process.env.REACT_APP_WALLET_MODE = "metamask";
      process.env.REACT_APP_BIDDER_NAMES = JSON.stringify({ [BOT]: "Bot Alpha" });
      const dialog = await openHistory();
      expect(within(dialog).getAllByText(/Bot Alpha/).length).toBeGreaterThan(0);
      expect(within(dialog).getByText(other)).toBeTruthy();
    });
  });

  test("a bidder never sees the button and the ledger is not read while the auction is open", async () => {
    mockChain({ transactions: TX });
    renderPage(); await flush();
    expect(screen.queryByRole("button", { name: "Display Bidding History" })).toBeNull();
    expect(methodCalls).not.toContain("getTransactions");
  });

  test("a bidder still does not get the button after the auction closed", async () => {
    mockChain({ endOffsetSec: -60, closed: true, transactions: TX });
    renderPage(); await flush();
    expect(screen.queryByRole("button", { name: "Display Bidding History" })).toBeNull();
  });
});

describe("error state", () => {
  test("a failed load shows the message and a way back to the list", async () => {
    mockChain({ fail: true });
    renderPage(); await flush();
    expect(screen.getByRole("alert").textContent).toBe("Error fetching auction data");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Return To Auctions Main Screen" })); });
    expect(screen.getByText("List page")).toBeTruthy();
  });
});
