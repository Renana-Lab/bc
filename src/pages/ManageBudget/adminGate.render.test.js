import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Wallet, id } from "ethers";
import { webcrypto } from "crypto";
import { AdminGatePrompt, useAdminAccess } from "./useAdminAccess";
import { clearAdminProof, parseAdminAddresses } from "./adminGate";

// Mutable wallet snapshot standing in for the real wallet layer.
const mockWallet = { snapshot: { status: "checking", account: "", provider: null }, listeners: new Set() };
jest.mock("../../real_ethereum/walletAccess", () => ({
  getWalletAccess: () => mockWallet.snapshot,
  subscribeWalletAccess: (listener) => {
    mockWallet.listeners.add(listener);
    return () => mockWallet.listeners.delete(listener);
  },
  requireWalletAccess: async () => mockWallet.snapshot,
}));

if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

const admin = new Wallet(id("admin-gate-render-admin"));
const outsider = new Wallet(id("admin-gate-render-outsider"));
const allowlist = parseAdminAddresses(admin.address);

const connect = (wallet) => {
  const provider = {
    request: jest.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return "0x5aff"; // Sapphire testnet, the default target
      if (method === "personal_sign") {
        return wallet.signMessage(Buffer.from(params[0].slice(2), "hex").toString("utf8"));
      }
      throw new Error(`unexpected ${method}`);
    }),
  };
  mockWallet.snapshot = { status: "connected", account: wallet.address, provider, verifiedAt: Date.now() };
  return provider;
};
const switchWallet = (wallet) => {
  const provider = connect(wallet);
  act(() => mockWallet.listeners.forEach((listener) => listener()));
  return provider;
};
const signCalls = (provider) => provider.request.mock.calls.filter(([{ method }]) => method === "personal_sign");

const Harness = () => {
  const access = useAdminAccess({ allowlist });
  return access.isAdmin ? <div>ADMIN ZONE</div> : <AdminGatePrompt access={access} />;
};

describe("Admin gate UI", () => {
  beforeEach(() => {
    clearAdminProof();
    mockWallet.listeners.clear();
  });
  afterEach(() => jest.restoreAllMocks());

  test("non-admin wallet: button disabled, never asked to sign", () => {
    const provider = connect(outsider);
    render(<Harness />);
    const button = screen.getByRole("button", { name: /sign to unlock/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.getByText(/not on the admin list/i)).toBeInTheDocument();
    expect(signCalls(provider)).toHaveLength(0);
    expect(screen.queryByText("ADMIN ZONE")).toBeNull();
    expect(screen.getByText(/UI gate only/i)).toBeInTheDocument();
  });

  test("admin wallet signs once and unlocks; switching wallet re-locks", async () => {
    const provider = connect(admin);
    render(<Harness />);
    const button = screen.getByRole("button", { name: /sign to unlock/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("ADMIN ZONE")).toBeInTheDocument());
    expect(signCalls(provider)).toHaveLength(1);
    expect(signCalls(provider)[0][0].params[1]).toBe(admin.address);

    switchWallet(outsider);
    await waitFor(() => expect(screen.queryByText("ADMIN ZONE")).toBeNull());
    expect(screen.getByRole("button", { name: /sign to unlock/i })).toBeDisabled();

    // Switching back does not need a new signature while the proof is still valid.
    switchWallet(admin);
    await waitFor(() => expect(screen.getByText("ADMIN ZONE")).toBeInTheDocument());
  });

  test("an open tab loses admin once the proof expires (re-checked on focus)", async () => {
    connect(admin);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /sign to unlock/i }));
    await waitFor(() => expect(screen.getByText("ADMIN ZONE")).toBeInTheDocument());

    const realNow = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(realNow + 61 * 60 * 1000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.queryByText("ADMIN ZONE")).toBeNull());
  });

  test("unmounting while the wallet is signing does not update state or warn", async () => {
    const provider = connect(admin);
    const original = provider.request.getMockImplementation();
    let release;
    provider.request.mockImplementation(async (args) => {
      if (args.method === "personal_sign") await new Promise((resolve) => (release = resolve));
      return original(args);
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /sign to unlock/i }));
    await waitFor(() => expect(signCalls(provider)).toHaveLength(1));
    unmount();
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("a rejected signature keeps the page locked and shows a message", async () => {
    const provider = connect(admin);
    const original = provider.request.getMockImplementation();
    provider.request.mockImplementation(async (args) => {
      if (args.method === "personal_sign") throw Object.assign(new Error("denied"), { code: 4001 });
      return original(args);
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /sign to unlock/i }));
    await waitFor(() => expect(screen.getByText(/signature request was rejected/i)).toBeInTheDocument());
    expect(screen.queryByText("ADMIN ZONE")).toBeNull();
  });
});
