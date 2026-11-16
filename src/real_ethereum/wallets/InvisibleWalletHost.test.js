import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import WalletModePanel from "./WalletModePanel";
import { __resetAutoClaimForTests } from "./autoClaim.mjs";
import { WALLET_OVERRIDE_KEY, WALLET_SCOPE_OVERRIDE_KEY } from "./walletMode.mjs";
import { getModeProvider, setModeProvider } from "./modeProvider";

const mockAdmin = { value: false };
jest.mock("./useIsAdminWallet", () => ({ useIsAdminWallet: () => ({ account: "0xadmin", isAdmin: mockAdmin.value }) }));

const mockWallets = [];
const mockBehavior = { open: "created" };
const mockAddress = `0x${"a".repeat(40)}`;
const ADDRESS = mockAddress;
jest.mock("./localWallet.mjs", () => ({
  createIndexedDbStorage: () => ({}),
  createLocalProvider: () => ({ request: jest.fn(async ({ method }) => (method === "eth_getBalance" ? "0x0" : [])) }),
  createLocalWallet: (options) => {
    const subscribers = new Set();
    const state = { address: "" };
    const emit = () => subscribers.forEach((listener) => listener());
    const wallet = {
      options,
      get address() { return state.address; },
      isUnlocked: () => Boolean(state.address),
      subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); },
      openSilent: jest.fn(async () => {
        if (mockBehavior.open !== "needs-migration") { state.address = mockAddress; emit(); }
        return mockBehavior.open;
      }),
      openEphemeral: jest.fn(() => { state.address = mockAddress; emit(); }),
      unlock: jest.fn(async () => { state.address = mockAddress; emit(); }),
      migrateToSilent: jest.fn(async () => {}),
      exportBackup: jest.fn(async () => "{}"),
      restoreBackupSilent: jest.fn(async () => mockAddress),
    };
    mockWallets.push(wallet);
    return wallet;
  },
}));

const PID = "5f1a2b3c4d5e6f7a8b9c0d1e";
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
let claimCalls;
const useFaucet = ({ claim = reply(200, { status: "paid" }) } = {}) => {
  claimCalls = [];
  global.fetch = jest.fn(async (url, init) => {
    if (url.endsWith("/status")) return reply(200, { open: true, updatedAt: null, pidMode: "prolific" });
    claimCalls.push(JSON.parse(init.body));
    return claim;
  });
};

beforeEach(() => {
  process.env.REACT_APP_WALLET_MODE = "local";
  process.env.REACT_APP_FAUCET_URL = "https://faucet.example";
  mockAdmin.value = false;
  mockBehavior.open = "created";
  mockWallets.length = 0;
  __resetAutoClaimForTests();
  window.sessionStorage.clear();
  window.history.pushState({}, "", `/?pid=${PID}`);
  useFaucet();
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};
});
afterEach(() => {
  delete process.env.REACT_APP_WALLET_MODE;
  delete process.env.REACT_APP_FAUCET_URL;
  window.sessionStorage.clear();
  setModeProvider(null);
  jest.restoreAllMocks();
});

describe("participant", () => {
  test("never sees a wallet panel, address, balance, backup, faucet button or wallet/TEST/gas wording", async () => {
    const view = render(<WalletModePanel />);
    await waitFor(() => expect(claimCalls).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("preparing-session")).toBeNull());
    expect(view.container.textContent).toBe("");
    expect(screen.queryByTestId("local-wallet-panel")).toBeNull();
    expect(screen.queryByTestId("admin-wallet-panel")).toBeNull();
    for (const text of [/wallet/i, /TEST/, /gas/i, /staff/i, /backup/i, /request test funds/i, ADDRESS]) {
      expect(document.body.textContent).not.toMatch(text);
    }
    expect(screen.queryByPlaceholderText(/passphrase/i)).toBeNull();
  });

  test("first visit and reload: the wallet opens silently, no passphrase field, no unlock state", async () => {
    const first = render(<WalletModePanel />);
    await waitFor(() => expect(mockWallets[0].openSilent).toHaveBeenCalled());
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
    first.unmount();
    mockBehavior.open = "opened";
    render(<WalletModePanel />);
    await waitFor(() => expect(mockWallets[1].openSilent).toHaveBeenCalled());
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
    expect(screen.queryByTestId("wallet-migration")).toBeNull();
    // The provider reports the session as unlocked once the silent open finished (RequireWallet never redirects).
    await waitFor(() => expect(getModeProvider()).not.toBeNull());
    expect(await getModeProvider().isUnlocked()).toBe(true);
  });

  test("the wallet is scoped to the pid (no raw pid in the scope)", async () => {
    render(<WalletModePanel />);
    await waitFor(() => expect(mockWallets).toHaveLength(1));
    expect(mockWallets[0].options.scope).toMatch(/^pid-[0-9a-f]{32}$/);
    expect(mockWallets[0].options.scope).not.toContain(PID);
  });

  test("shows 'Preparing your session...' until funded, claims once with the pid and address, then hides it", async () => {
    let release;
    global.fetch = jest.fn(async (url, init) => {
      if (url.endsWith("/status")) return reply(200, { open: true, updatedAt: null, pidMode: "prolific" });
      claimCalls.push(JSON.parse(init.body));
      await new Promise((resolve) => { release = resolve; });
      return reply(200, { status: "paid" });
    });
    render(<WalletModePanel />);
    expect((await screen.findByTestId("preparing-session")).textContent).toBe("Preparing your session...");
    await waitFor(() => expect(claimCalls).toHaveLength(1));
    expect(claimCalls[0]).toEqual({ pid: PID, address: ADDRESS });
    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByTestId("preparing-session")).toBeNull());
  });

  test("a failed claim ends the banner silently; a re-render does not claim again", async () => {
    useFaucet({ claim: reply(403, { error: "budget_exhausted" }) });
    const view = render(<WalletModePanel />);
    await waitFor(() => expect(claimCalls).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("preparing-session")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<WalletModePanel />);
    view.unmount();
    render(<WalletModePanel />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(claimCalls).toHaveLength(1);
  });

  test("without a pid nothing is claimed", async () => {
    window.history.pushState({}, "", "/");
    render(<WalletModePanel />);
    await waitFor(() => expect(mockWallets[0].openSilent).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(claimCalls).toHaveLength(0);
  });

  test("an old passphrase keystore shows the existing unlock step once, then re-saves silently", async () => {
    mockBehavior.open = "needs-migration";
    render(<WalletModePanel />);
    const card = await screen.findByTestId("wallet-migration");
    expect(card.textContent).not.toMatch(ADDRESS);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "an old passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(mockWallets[0].migrateToSilent).toHaveBeenCalled());
    expect(mockWallets[0].unlock).toHaveBeenCalledWith("an old passphrase");
    await waitFor(() => expect(screen.queryByTestId("wallet-migration")).toBeNull());
  });
});

describe("admin", () => {
  beforeEach(() => { mockAdmin.value = true; });

  test("sees the wallet panel with full address, TEST balance, encrypted backup and Request test funds", async () => {
    render(<WalletModePanel />);
    expect(await screen.findByTestId("admin-wallet-panel")).toBeTruthy();
    expect(screen.getByTestId("admin-wallet-address").textContent).toBe(ADDRESS);
    await waitFor(() => expect(screen.getByTestId("admin-wallet-balance").textContent).toMatch(/TEST balance: 0\.0000/));
    expect(screen.getByRole("button", { name: "Download encrypted backup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request test funds" })).toBeTruthy();
  });

  test("the backup needs a passphrase and downloads the passphrase-encrypted file", async () => {
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<WalletModePanel />);
    await screen.findByTestId("admin-wallet-panel");
    fireEvent.change(screen.getByPlaceholderText("Passphrase (12+ chars)"), { target: { value: "a long passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Download encrypted backup" }));
    await waitFor(() => expect(mockWallets[0].exportBackup).toHaveBeenCalledWith("a long passphrase"));
  });
});

describe("session overrides", () => {
  test("a MetaMask override renders nothing: no wallet is created or opened, no faucet claim", async () => {
    window.sessionStorage.setItem(WALLET_OVERRIDE_KEY, "metamask");
    const view = render(<WalletModePanel />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(view.container.textContent).toBe("");
    expect(mockWallets).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(getModeProvider()).toBeNull();
  });

  test("an imported admin key uses the separate 'admin' slot and never auto-claims", async () => {
    window.sessionStorage.setItem(WALLET_SCOPE_OVERRIDE_KEY, "admin");
    render(<WalletModePanel />);
    await waitFor(() => expect(mockWallets[0].openSilent).toHaveBeenCalled());
    expect(mockWallets[0].options.scope).toBe("admin");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(claimCalls).toHaveLength(0);
  });

  test("any other override value is ignored: participants still get the local wallet", async () => {
    window.sessionStorage.setItem(WALLET_OVERRIDE_KEY, "local");
    render(<WalletModePanel />);
    await waitFor(() => expect(mockWallets[0].openSilent).toHaveBeenCalled());
  });
});

test("MetaMask mode renders nothing and creates no wallet", async () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  const view = render(<WalletModePanel />);
  expect(view.container.textContent).toBe("");
  expect(mockWallets).toHaveLength(0);
  expect(global.fetch).not.toHaveBeenCalled();
});
