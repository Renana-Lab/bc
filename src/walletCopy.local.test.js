import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { getWalletCopy } from "./real_ethereum/wallets/walletCopy";
import { describeBidError } from "./components/ContributeForm";

let mockSession;
jest.mock("./Context/Context", () => ({ useMetaMask: () => mockSession, MetaMaskProvider: ({ children }) => children }));
jest.mock("./botnet/BotnetRuntimeHost", () => () => null);
jest.mock("./telemetry/PresenceCoordinator", () => () => null);
jest.mock("./real_ethereum/wallets/WalletModePanel.js", () => () => <div>wallet panel</div>);
jest.mock("./components/Seo", () => ({ children }) => children);
jest.mock("./components/Layout", () => ({ children }) => <div>{children}</div>);
jest.mock("./pages/MetamaskLogin/MetamaskTutorialPage.js", () => () => <h1>Are you logged in to MetaMask?</h1>);
jest.mock("./pages/AuctionsList/AuctionsListPage.js", () => () => <h1>Protected list</h1>);

const originalMode = process.env.REACT_APP_WALLET_MODE;
beforeEach(() => {
  window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
});
afterEach(() => { process.env.REACT_APP_WALLET_MODE = originalMode; });
const open = (path, state) => render(
  <MemoryRouter initialEntries={[{ pathname: path, state }]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></MemoryRouter>,
);

describe("local wallet mode after a reload (locked wallet)", () => {
  beforeEach(() => { process.env.REACT_APP_WALLET_MODE = "local"; });

  test("the checking fallback has no MetaMask text", () => {
    mockSession = { status: "checking" };
    const view = open("/auctions-list");
    expect(view.container.textContent).toMatch(/Checking your wallet/);
    expect(view.container.textContent).not.toMatch(/metamask/i);
  });

  test("a locked wallet is sent to the unlock screen, which has no MetaMask text", async () => {
    mockSession = { status: "locked", reason: getWalletCopy().reasons.locked };
    const view = open("/auctions-list");
    await screen.findByText("Unlock your wallet");
    expect(view.container.textContent).toMatch(/Unlock your wallet with your passphrase/);
    expect(view.container.textContent).not.toMatch(/metamask/i);
    expect(screen.queryByText("Protected list")).toBeNull();
  });

  test("the legacy /metamask-login link is an alias of the unlock screen", async () => {
    mockSession = { status: "locked", reason: "" };
    const view = open("/metamask-login");
    await screen.findByText("Unlock your wallet");
    expect(view.container.textContent).not.toMatch(/metamask/i);
  });

  test("once unlocked the user returns to the requested route", async () => {
    mockSession = { status: "locked", reason: "" };
    const view = open("/wallet-unlock", { from: "/auctions-list" });
    await screen.findByText("Unlock your wallet");
    mockSession = { status: "connected", account: "0x1" };
    view.unmount();
    open("/wallet-unlock", { from: "/auctions-list" });
    await waitFor(() => expect(screen.getByText("Protected list")).toBeTruthy());
  });

  test("every participant-facing wallet string is MetaMask-free", () => {
    const flat = JSON.stringify({ ...getWalletCopy(), tutorialLink: "" });
    expect(flat).not.toMatch(/metamask|sepolia/i);
    expect(getWalletCopy().showTutorial).toBe(false);
    expect(describeBidError(new Error(getWalletCopy().requireWallet))).not.toMatch(/metamask/i);
    expect(describeBidError({ code: 4001 }, false)).not.toMatch(/metamask/i);
  });
});

describe("MetaMask mode keeps its original strings", () => {
  beforeEach(() => { process.env.REACT_APP_WALLET_MODE = "metamask"; });

  test("copy is unchanged", () => {
    const copy = getWalletCopy();
    expect(copy.verifying).toBe("Verifying your MetaMask connection");
    expect(copy.loginPath).toBe("/metamask-login");
    expect(copy.reasons.locked).toBe("Unlock MetaMask to continue.");
    expect(copy.txRejected).toBe("Transaction rejected in MetaMask.");
    expect(copy.showTutorial).toBe(true);
  });

  test("a locked wallet still goes to the MetaMask login", async () => {
    mockSession = { status: "locked" };
    open("/auctions-list");
    await screen.findByText("Are you logged in to MetaMask?");
  });
});
