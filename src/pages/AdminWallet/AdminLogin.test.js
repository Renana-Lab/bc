import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Wallet } from "ethers";
import AdminLoginPage from "./AdminLoginPage";
import { connectAdminWithMetaMask } from "./adminLogin";
import { AdminSessionControls } from "../ManageBudget/AdminGasCards";
import {
  WALLET_OVERRIDE_KEY, WALLET_SCOPE_OVERRIDE_KEY, clearWalletOverrides, getWalletMode, getWalletModeOverride, hasWalletOverride,
  setWalletModeOverride,
} from "../../real_ethereum/wallets/walletMode.mjs";
import { getWalletCopy } from "../../real_ethereum/wallets/walletCopy";

const mockAccess = { account: "" };
jest.mock("../../real_ethereum/walletAccess", () => ({
  ...jest.requireActual("../../real_ethereum/walletAccess"),
  getWalletAccess: () => ({ status: mockAccess.account ? "connected" : "unavailable", account: mockAccess.account }),
  subscribeWalletAccess: () => () => {},
}));
jest.mock("../../real_ethereum/sapphireNetworks", () => ({ ...jest.requireActual("../../real_ethereum/sapphireNetworks"), ensureTargetChain: jest.fn(async () => ({})) }));

const ADMIN = `0x${"e".repeat(40)}`;
const OTHER = `0x${"1".repeat(40)}`;
const metaMask = (account, { reject = false } = {}) => ({
  isMetaMask: true,
  request: jest.fn(async ({ method }) => {
    if (reject) throw Object.assign(new Error("rejected"), { code: 4001 });
    return method === "eth_requestAccounts" ? [account] : null;
  }),
});

beforeEach(() => {
  process.env.REACT_APP_WALLET_MODE = "local";
  process.env.REACT_APP_ADMIN_ADDRESSES = ADMIN;
  window.sessionStorage.clear();
  mockAccess.account = "";
});
afterEach(() => { delete process.env.REACT_APP_WALLET_MODE; delete process.env.REACT_APP_ADMIN_ADDRESSES; window.sessionStorage.clear(); });

describe("wallet mode override", () => {
  test("local build without override stays local; participants never get an override", () => {
    expect(getWalletMode()).toBe("local");
    expect(hasWalletOverride()).toBe(false);
  });
  test("only 'metamask' is accepted as an override value", () => {
    window.sessionStorage.setItem(WALLET_OVERRIDE_KEY, "local");
    expect(getWalletModeOverride()).toBe("");
    window.sessionStorage.setItem(WALLET_OVERRIDE_KEY, "apillon");
    expect(getWalletMode()).toBe("local");
    window.sessionStorage.setItem(WALLET_OVERRIDE_KEY, "metamask");
    expect(getWalletMode()).toBe("metamask");
    expect(getWalletCopy().walletName).toBe("MetaMask");
  });
  test("MetaMask-mode builds are unchanged (the env value still decides, no override needed)", () => {
    process.env.REACT_APP_WALLET_MODE = "metamask";
    expect(getWalletMode()).toBe("metamask");
    expect(getWalletCopy().verifying).toBe("Verifying your MetaMask connection");
    expect(hasWalletOverride()).toBe(false);
  });
});

describe("MetaMask admin sign-in", () => {
  test("an admin address sets the override and goes to the Admin Zone", async () => {
    const redirect = jest.fn();
    render(<AdminLoginPage findProvider={async () => metaMask(ADMIN)} redirect={redirect} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect MetaMask" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("/manage-budget"));
    expect(window.sessionStorage.getItem(WALLET_OVERRIDE_KEY)).toBe("metamask");
    expect(getWalletMode()).toBe("metamask");
  });

  test("the admin match ignores address case", async () => {
    const result = await connectAdminWithMetaMask({ findProvider: async () => metaMask(`0x${"E".repeat(40)}`) });
    expect(result.ok).toBe(true);
  });

  test("a non-admin MetaMask account is rejected and the override is NOT set", async () => {
    const redirect = jest.fn();
    render(<AdminLoginPage findProvider={async () => metaMask(OTHER)} redirect={redirect} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect MetaMask" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This account is not an admin.");
    expect(redirect).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(WALLET_OVERRIDE_KEY)).toBeNull();
    expect(getWalletMode()).toBe("local");
  });

  test("an extra on-chain admin check can admit an account that is not in the env list", async () => {
    const extraAdminCheck = jest.fn(async (account) => account === OTHER);
    expect((await connectAdminWithMetaMask({ findProvider: async () => metaMask(OTHER), extraAdminCheck })).ok).toBe(true);
    clearWalletOverrides();
    expect((await connectAdminWithMetaMask({ findProvider: async () => metaMask(`0x${"2".repeat(40)}`), extraAdminCheck })).ok).toBe(false);
  });

  test("no MetaMask, or a rejected connection, leaves the override unset", async () => {
    expect(await connectAdminWithMetaMask({ findProvider: async () => null })).toMatchObject({ ok: false, message: expect.stringMatching(/not detected/) });
    expect(await connectAdminWithMetaMask({ findProvider: async () => metaMask(ADMIN, { reject: true }) })).toMatchObject({ ok: false, message: expect.stringMatching(/rejected/) });
    expect(hasWalletOverride()).toBe(false);
  });

  test("the sign-in page switches to the configured Sapphire network after requesting accounts", async () => {
    const { ensureTargetChain } = require("../../real_ethereum/sapphireNetworks");
    ensureTargetChain.mockClear();
    const provider = metaMask(ADMIN);
    await connectAdminWithMetaMask({ findProvider: async () => provider });
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(ensureTargetChain).toHaveBeenCalledWith(provider);
  });
});

describe("Import admin key (fallback)", () => {
  const memoryStorage = () => {
    const map = new Map();
    return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
  };
  beforeAll(() => {
    const { webcrypto } = require("crypto");
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  });

  test("warns that it is for testnet keys only", () => {
    render(<AdminLoginPage />);
    expect(screen.getByRole("note").textContent).toMatch(/Testnet keys only/);
  });

  test("a non-admin key is rejected and nothing is stored", async () => {
    const storage = memoryStorage();
    const redirect = jest.fn();
    const stranger = new Wallet(`0x${"22".repeat(32)}`); // fixed keys: Wallet.createRandom needs a real-realm Uint8Array (see silentWallet.test.js)
    render(<AdminLoginPage silentStorage={storage} redirect={redirect} />);
    fireEvent.change(screen.getByLabelText("Admin private key"), { target: { value: stranger.privateKey } });
    fireEvent.click(screen.getByRole("button", { name: "Import admin key" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This account is not an admin.");
    expect(storage.map.size).toBe(0);
    expect(redirect).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(WALLET_SCOPE_OVERRIDE_KEY)).toBeNull();
  });

  test("an admin key is sealed (non-extractable key + ciphertext) in the separate 'admin' slot and the scope override is set", async () => {
    const adminWallet = new Wallet(`0x${"11".repeat(32)}`);
    process.env.REACT_APP_ADMIN_ADDRESSES = adminWallet.address;
    const storage = memoryStorage();
    const redirect = jest.fn();
    render(<AdminLoginPage silentStorage={storage} redirect={redirect} />);
    fireEvent.change(screen.getByLabelText("Admin private key"), { target: { value: adminWallet.privateKey } });
    fireEvent.click(screen.getByRole("button", { name: "Import admin key" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("/manage-budget"));
    expect([...storage.map.keys()].sort()).toEqual(["key:admin", "wallet:admin"]);
    expect(storage.map.get("key:admin").extractable).toBe(false);
    expect(JSON.stringify(Array.from(storage.map.get("wallet:admin").ciphertext))).not.toContain(adminWallet.privateKey.slice(2));
    expect(window.sessionStorage.getItem(WALLET_SCOPE_OVERRIDE_KEY)).toBe("admin");
    expect(getWalletMode()).toBe("local"); // the mode itself is untouched; only the wallet slot changes
    expect(screen.getByLabelText("Admin private key").value).toBe("");
  });
});

describe("switch back", () => {
  test("the button clears the override and reloads; it only shows to an admin while an override is active", () => {
    const reload = jest.fn();
    mockAccess.account = ADMIN;
    const idle = render(<AdminSessionControls reload={reload} />);
    expect(idle.container.textContent).toBe(""); // no override: nothing to switch back from
    idle.unmount();

    setWalletModeOverride();
    expect(getWalletMode()).toBe("metamask");
    render(<AdminSessionControls reload={reload} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch back to participant wallet" }));
    expect(window.sessionStorage.getItem(WALLET_OVERRIDE_KEY)).toBeNull();
    expect(getWalletMode()).toBe("local");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a non-admin never sees it", () => {
    setWalletModeOverride();
    mockAccess.account = OTHER;
    expect(render(<AdminSessionControls reload={jest.fn()} />).container.textContent).toBe("");
  });
});
