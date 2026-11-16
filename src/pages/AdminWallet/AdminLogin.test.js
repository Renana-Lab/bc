import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Wallet, encryptKeystoreJson } from "ethers";
import AdminLoginPage from "./AdminLoginPage";
import { connectAdminWithMetaMask, importAdminKey, normalizePrivateKey, readOnChainAdminRole } from "./adminLogin";
import { restoreAdminBackup } from "../../real_ethereum/wallets/adminSlot";
import { AdminWalletRestore } from "../../real_ethereum/wallets/AdminWalletPanel";
import { AdminSessionControls } from "../ManageBudget/AdminGasCards";
import {
  WALLET_OVERRIDE_KEY, WALLET_SCOPE_OVERRIDE_KEY, clearWalletOverrides, getWalletMode, getWalletModeOverride, hasWalletOverride,
  setWalletModeOverride,
} from "../../real_ethereum/wallets/walletMode.mjs";
import { getWalletCopy } from "../../real_ethereum/wallets/walletCopy";

const mockChain = { admin: new Set(), owner: "" };
jest.mock("../../real_ethereum/adminChain", () => ({
  readIsFactoryAdmin: async (account) => mockChain.admin.has(String(account).toLowerCase()), // plain functions: CRA resets jest.fn implementations
  readFactoryOwner: async () => mockChain.owner,
}));
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

  test("/admin-login wires the on-chain admin role (factory.isAdmin) and the owner by default", async () => {
    mockChain.admin = new Set([OTHER]);
    const redirect = jest.fn();
    render(<AdminLoginPage findProvider={async () => metaMask(OTHER)} redirect={redirect} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect MetaMask" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("/manage-budget"));
    expect(window.sessionStorage.getItem(WALLET_OVERRIDE_KEY)).toBe("metamask");
    clearWalletOverrides();
    mockChain.admin = new Set();
    mockChain.owner = OTHER;
    const ownerRedirect = jest.fn();
    render(<AdminLoginPage findProvider={async () => metaMask(OTHER)} redirect={ownerRedirect} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Connect MetaMask" })[1]);
    await waitFor(() => expect(ownerRedirect).toHaveBeenCalled());
    mockChain.owner = "";
  });

  test("a chain account that is neither admin nor owner, or a failing chain read, is rejected", async () => {
    mockChain.admin = new Set(); mockChain.owner = `0x${"9".repeat(40)}`;
    expect((await connectAdminWithMetaMask({ findProvider: async () => metaMask(OTHER), extraAdminCheck: readOnChainAdminRole })).ok).toBe(false);
    expect(await readOnChainAdminRole(OTHER, { readIsAdmin: async () => { throw new Error("rpc"); }, readOwner: async () => { throw new Error("rpc"); } })).toBe(false);
    expect(hasWalletOverride()).toBe(false);
    mockChain.owner = "";
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
    expect([...storage.map.keys()]).toEqual(["wallet:admin"]); // one record: key + iv + ciphertext
    expect(storage.map.get("wallet:admin").key.extractable).toBe(false);
    expect(JSON.stringify(Array.from(storage.map.get("wallet:admin").ciphertext))).not.toContain(adminWallet.privateKey.slice(2));
    expect(window.sessionStorage.getItem(WALLET_SCOPE_OVERRIDE_KEY)).toBe("admin");
    expect(getWalletMode()).toBe("local"); // the mode itself is untouched; only the wallet slot changes
    expect(screen.getByLabelText("Admin private key").value).toBe("");
  });
});

describe("private key format and /admin/wallet restore", () => {
  const memoryStorage = () => {
    const map = new Map();
    return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
  };
  beforeAll(() => {
    const { webcrypto } = require("crypto");
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  });
  const admin = new Wallet(`0x${"11".repeat(32)}`);
  const ALLOW = [admin.address.toLowerCase()];

  test("a private key without the 0x prefix (as exported by MetaMask) is accepted, with or without surrounding spaces", async () => {
    expect(normalizePrivateKey(`  ${"11".repeat(32)} `)).toBe(`0x${"11".repeat(32)}`);
    expect(normalizePrivateKey(`0x${"11".repeat(32)}`)).toBe(`0x${"11".repeat(32)}`);
    expect(normalizePrivateKey("nonsense")).toBe("nonsense");
    const storage = memoryStorage();
    const result = await importAdminKey({ privateKey: "11".repeat(32), allowlist: [admin.address.toLowerCase()], silentStorage: storage });
    expect(result).toEqual({ ok: true, account: admin.address });
    expect(storage.map.has("wallet:admin")).toBe(true);
    expect(window.sessionStorage.getItem(WALLET_SCOPE_OVERRIDE_KEY)).toBe("admin");
  });
  test("a malformed key is still rejected", async () => {
    expect(await importAdminKey({ privateKey: "11".repeat(31), allowlist: [admin.address.toLowerCase()], silentStorage: memoryStorage() })).toEqual({ ok: false, message: "That is not a valid private key." });
  });

  const backupJson = () => encryptKeystoreJson({ address: admin.address, privateKey: admin.privateKey }, "a long passphrase!", { scrypt: { N: 2 ** 4 } });

  test("restore goes into the 'admin' slot, sets walletScopeOverride=admin and never touches the participant slot", async () => {
    const storage = memoryStorage();
    storage.map.set("wallet:pid-participant", { v: 2, marker: "keep" });
    const result = await restoreAdminBackup({ json: await backupJson(), passphrase: "a long passphrase!", allowlist: ALLOW, silentStorage: storage });
    expect(result).toEqual({ ok: true, account: admin.address });
    expect([...storage.map.keys()].sort()).toEqual(["wallet:admin", "wallet:pid-participant"]);
    expect(storage.map.get("wallet:pid-participant")).toEqual({ v: 2, marker: "keep" });
    expect(window.sessionStorage.getItem(WALLET_SCOPE_OVERRIDE_KEY)).toBe("admin");
  });
  test("an existing admin wallet is replaced only after confirmation; declining keeps it and the override unset", async () => {
    const storage = memoryStorage();
    await restoreAdminBackup({ json: await backupJson(), passphrase: "a long passphrase!", allowlist: ALLOW, silentStorage: storage });
    const before = storage.map.get("wallet:admin");
    window.sessionStorage.clear();
    const confirmReplace = jest.fn(async () => false);
    const declined = await restoreAdminBackup({ json: await backupJson(), passphrase: "a long passphrase!", allowlist: ALLOW, silentStorage: storage, confirmReplace });
    expect(confirmReplace).toHaveBeenCalledTimes(1);
    expect(declined).toMatchObject({ ok: false, cancelled: true });
    expect(storage.map.get("wallet:admin")).toBe(before);
    expect(window.sessionStorage.getItem(WALLET_SCOPE_OVERRIDE_KEY)).toBeNull();
    const accepted = await restoreAdminBackup({ json: await backupJson(), passphrase: "a long passphrase!", allowlist: ALLOW, silentStorage: storage, confirmReplace: async () => true });
    expect(accepted.ok).toBe(true);
    expect(storage.map.get("wallet:admin")).not.toBe(before);
  });
  test("a backup of a non-admin address is rejected like a non-admin key: nothing stored, no override", async () => {
    const storage = memoryStorage();
    const stranger = new Wallet(`0x${"22".repeat(32)}`);
    const json = await encryptKeystoreJson({ address: stranger.address, privateKey: stranger.privateKey }, "a long passphrase!", { scrypt: { N: 2 ** 4 } });
    const result = await restoreAdminBackup({ json, passphrase: "a long passphrase!", allowlist: ALLOW, silentStorage: storage });
    expect(result).toEqual({ ok: false, message: "This account is not an admin." });
    expect(storage.map.size).toBe(0);
    expect(window.sessionStorage.getItem(WALLET_SCOPE_OVERRIDE_KEY)).toBeNull();
  });
  test("no confirmation is asked on a first restore; a wrong passphrase stores nothing", async () => {
    const storage = memoryStorage();
    const confirmReplace = jest.fn(async () => true);
    await expect(restoreAdminBackup({ json: await backupJson(), passphrase: "wrong passphrase!!", allowlist: ALLOW, silentStorage: storage, confirmReplace })).rejects.toThrow(/could not be decrypted/);
    expect(storage.map.size).toBe(0);
    await restoreAdminBackup({ json: await backupJson(), passphrase: "a long passphrase!", allowlist: ALLOW, silentStorage: storage, confirmReplace });
    expect(confirmReplace).not.toHaveBeenCalled();
  });
  test("the restore control asks window confirmation before replacing and reports the result", async () => {
    const restore = jest.fn(async ({ confirmReplace }) => { await confirmReplace(); return { ok: true, account: admin.address }; });
    const confirm = jest.fn(() => true);
    const onRestored = jest.fn();
    render(<AdminWalletRestore restore={restore} confirm={confirm} onRestored={onRestored} />);
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "a long passphrase!" } });
    const file = new File(["{}"], "backup.json", { type: "application/json" });
    file.text = async () => "{}";
    fireEvent.change(screen.getByTestId("admin-wallet-restore-file"), { target: { files: [file] } });
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(admin.address));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Replace/));
    expect(screen.getByRole("status").textContent).toBe(`Restored ${admin.address}.`);
    expect(screen.getByLabelText("Backup passphrase").value).toBe("");
  });
  test("a cancelled restore shows the message and does not report success", async () => {
    const onRestored = jest.fn();
    render(<AdminWalletRestore restore={async () => ({ ok: false, cancelled: true, message: "Restore cancelled. The current admin wallet was kept." })} onRestored={onRestored} />);
    const file = new File(["{}"], "backup.json"); file.text = async () => "{}";
    fireEvent.change(screen.getByTestId("admin-wallet-restore-file"), { target: { files: [file] } });
    expect((await screen.findByRole("status")).textContent).toMatch(/cancelled/);
    expect(onRestored).not.toHaveBeenCalled();
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

  test("it shows whenever an override is active, also for an account that is not on the env allowlist (admitted on-chain only)", () => {
    const reload = jest.fn();
    setWalletModeOverride();
    mockAccess.account = OTHER;
    render(<AdminSessionControls reload={reload} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch back to participant wallet" }));
    expect(hasWalletOverride()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  test("without an override nobody sees it", () => {
    mockAccess.account = OTHER;
    expect(render(<AdminSessionControls reload={jest.fn()} />).container.textContent).toBe("");
  });
});
