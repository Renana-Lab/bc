// Admin wallet proof on the faucet calls: the header helper, the three clients, the shared credential hook and the cards.
import React from "react";
import { webcrypto } from "crypto";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { Wallet, id } from "ethers";
import { utf8ToHex } from "../../real_ethereum/siwe.mjs";
import { getExpectedGateContext, clearAdminProof, getAdminProofHeader, requestAdminProof, saveAdminProof } from "./adminGate";
import { clearSessionPassword, getSessionPassword, setSessionPassword, useFaucetSessionPassword } from "./faucetSessionPassword";
import { fetchFaucetAdminStatus, setFaucetMaxPayouts, setFaucetState } from "../../real_ethereum/wallets/faucetClient.mjs";
import { fetchAdminMessages, sendAdminMessage } from "../../real_ethereum/wallets/inboxClient.mjs";
import { fetchSweeps, saveSweepIdleMinutes } from "../../real_ethereum/wallets/sweepClient.mjs";
import { FaucetFundsCardBody } from "./FaucetFundsCard";
import { AutoReturnControls, useAutoReturn } from "./ParticipantsAutoReturn";

if (!globalThis.crypto?.getRandomValues) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const mockAccess = { account: "" };
jest.mock("../../real_ethereum/walletAccess", () => ({
  getWalletAccess: () => ({ status: mockAccess.account ? "connected" : "unavailable", account: mockAccess.account }),
  subscribeWalletAccess: () => () => {},
}));
jest.mock("./participantsGasReaders", () => ({ readNativeBalances: jest.fn(async () => ({})) }));
jest.mock("./adminTransfer", () => ({
  sendNativeFromAdmin: jest.fn(), waitForReceipt: jest.fn(), readAdminBalance: jest.fn(),
  explorerTxUrl: () => "", explorerAddressUrl: () => "",
}));

const admin = new Wallet(id("admin-wallet-proof-test"));
const FAUCET = `0x${"f".repeat(40)}`;
const URL_BASE = "https://faucet.example";
const decode = (header) => JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
const provider = { request: async ({ params }) => admin.signMessage(Buffer.from(params[0].slice(2), "hex").toString("utf8")) };
const signIn = async () => {
  const ctx = getExpectedGateContext();
  return requestAdminProof({ provider, account: admin.address, ...ctx, allowlist: [admin.address.toLowerCase()] });
};
const jsonResponse = (status, body) => ({ status, ok: status < 300, json: async () => body });

beforeEach(() => {
  process.env.REACT_APP_ADMIN_ADDRESSES = admin.address;
  mockAccess.account = admin.address;
  clearAdminProof();
  clearSessionPassword();
});
afterEach(() => { delete process.env.REACT_APP_ADMIN_ADDRESSES; });

describe("getAdminProofHeader", () => {
  test("null without a proof or for another account", async () => {
    expect(getAdminProofHeader(admin.address)).toBeNull();
    const proof = await signIn();
    expect(getAdminProofHeader(`0x${"1".repeat(40)}`)).toBeNull();
    expect(getAdminProofHeader(admin.address)).not.toBeNull();
    expect(proof.address).toBe(admin.address);
  });
  test("is base64url JSON { address, message, signature } with no padding or url-unsafe characters", async () => {
    const proof = await signIn();
    const header = getAdminProofHeader(admin.address.toLowerCase());
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decode(header)).toEqual({ address: proof.address, message: proof.message, signature: proof.signature });
  });
  test("null once the proof has expired", async () => {
    await signIn();
    expect(getAdminProofHeader(admin.address, { now: Date.now() + 61 * 60_000 })).toBeNull();
  });
  test("null when the stored proof was tampered with", async () => {
    const proof = await signIn();
    saveAdminProof({ ...proof, signature: await new Wallet(id("someone-else")).signMessage(proof.message) });
    expect(getAdminProofHeader(admin.address)).toBeNull();
  });
});

describe("clients send the proof header, never in the URL or the body", () => {
  const PROOF = "cHJvb2Y"; // opaque to the clients
  const expectProofOnly = (call) => {
    const [url, init] = call;
    expect(String(url)).not.toContain(PROOF);
    expect(init.headers["x-admin-proof"]).toBe(PROOF);
    expect(init.headers["x-admin-password"]).toBeUndefined();
    expect(String(init.body ?? "")).not.toMatch(/password|cHJvb2Y/);
  };
  test("faucetClient", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { open: true, maxPayouts: 5, payoutsUsed: 1 }));
    await fetchFaucetAdminStatus({ faucetUrl: URL_BASE, proof: PROOF, fetchImpl });
    await setFaucetState({ faucetUrl: URL_BASE, open: false, proof: PROOF, fetchImpl });
    await setFaucetMaxPayouts({ faucetUrl: URL_BASE, value: 5, proof: PROOF, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    fetchImpl.mock.calls.forEach(expectProofOnly);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ open: false });
  });
  test("inboxClient", async () => {
    const fetchImpl = jest.fn(async (url, init) => jsonResponse(200, init.method === "POST" ? { id: "m1" } : { broadcasts: [], participants: [] }));
    await sendAdminMessage({ faucetUrl: URL_BASE, proof: PROOF, all: true, body: "hi", fetchImpl });
    await fetchAdminMessages({ faucetUrl: URL_BASE, proof: PROOF, pidHash: "a".repeat(64), fetchImpl });
    fetchImpl.mock.calls.forEach(expectProofOnly);
  });
  test("sweepClient", async () => {
    const fetchImpl = jest.fn(async (url, init) => jsonResponse(200, init.method === "POST" ? { idleMinutes: 20 } : { sweeps: [] }));
    await fetchSweeps({ faucetUrl: URL_BASE, proof: PROOF, fetchImpl });
    await saveSweepIdleMinutes({ faucetUrl: URL_BASE, proof: PROOF, idleMinutes: 20, fetchImpl });
    fetchImpl.mock.calls.forEach(expectProofOnly);
  });
  test("a password still works and a refused proof is reported as such", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { open: true }));
    await fetchFaucetAdminStatus({ faucetUrl: URL_BASE, password: "pw", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ "x-admin-password": "pw" });
    const refused = async (status) => fetchFaucetAdminStatus({ faucetUrl: URL_BASE, proof: PROOF, fetchImpl: async () => jsonResponse(status, {}) }).catch((error) => error);
    expect((await refused(401)).code).toBe("unauthorized");
    expect((await refused(401)).message).toMatch(/admin wallet/);
    expect((await refused(503)).code).toBe("unavailable");
  });
});

describe("useFaucetSessionPassword", () => {
  test("uses the wallet proof when there is one, and no password is needed", async () => {
    await signIn();
    const { result } = renderHook(() => useFaucetSessionPassword());
    expect(result.current.usesWallet).toBe(true);
    expect(result.current.hasCredential).toBe(true);
    const action = jest.fn(async () => "ok");
    await act(async () => { await result.current.run("", action); });
    expect(action).toHaveBeenCalledWith({ proof: getAdminProofHeader(admin.address) });
  });
  test("a typed password beats the proof", async () => {
    await signIn();
    const { result } = renderHook(() => useFaucetSessionPassword());
    const action = jest.fn(async () => "ok");
    await act(async () => { await result.current.run("typed", action); });
    expect(action).toHaveBeenCalledWith({ password: "typed" });
  });
  test("a refused proof shows the password path and is not retried; a session password is used as the fallback", async () => {
    await signIn();
    const { result } = renderHook(() => useFaucetSessionPassword());
    const refuse = jest.fn(async ({ proof }) => { if (proof) throw Object.assign(new Error("no"), { code: "unauthorized" }); return "ok"; });
    await act(async () => { await expect(result.current.run("", refuse)).rejects.toThrow(/did not accept your admin wallet/); });
    expect(result.current.usesWallet).toBe(false);
    expect(result.current.hasCredential).toBe(false);
    await act(async () => { await result.current.run("pw", refuse); });
    expect(refuse).toHaveBeenLastCalledWith({ password: "pw" });
    expect(refuse).toHaveBeenCalledTimes(2);
    expect(getSessionPassword()).toBe("pw");
  });
  test("a 503 also falls back, with a retry hint", async () => {
    await signIn();
    setSessionPassword("saved");
    const { result } = renderHook(() => useFaucetSessionPassword());
    const action = jest.fn(async ({ proof }) => { if (proof) throw Object.assign(new Error("down"), { code: "unavailable" }); return "ok"; });
    await act(async () => { expect(await result.current.run("", action)).toBe("ok"); });
    expect(action).toHaveBeenLastCalledWith({ password: "saved" });
  });
});

describe("Faucet funds card", () => {
  const statusBody = { payoutsUsed: 1, maxPayouts: 10, faucetAddress: FAUCET, payoutAmount: "100", open: true };
  const render_ = (deps) => render(<FaucetFundsCardBody faucetUrl={URL_BASE} envAddress={FAUCET} adminAccount={admin.address} showStateSwitch allowTopUp={false} deps={deps} />);
  const makeDeps = (extra = {}) => ({
    readBalances: jest.fn(async () => ({})),
    fetchStatus: jest.fn(async () => statusBody),
    fetchPublicStatus: jest.fn(async () => ({ open: true })),
    setState: jest.fn(async ({ open }) => ({ open })),
    setMax: jest.fn(),
    ...extra,
  });

  test("with a wallet proof: no password field, status loads with the proof, and the switch closes the faucet after a confirm", async () => {
    await signIn();
    const proof = getAdminProofHeader(admin.address);
    const deps = makeDeps();
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
    render_(deps);
    await waitFor(() => expect(deps.fetchStatus).toHaveBeenCalledWith(expect.objectContaining({ proof })));
    expect(screen.queryByLabelText("Faucet admin password")).toBeNull();
    expect(screen.getByTestId("wallet-auth-note")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("faucet-state")).toHaveTextContent("Faucet is open."));
    fireEvent.click(screen.getByRole("button", { name: "Close faucet" }));
    expect(confirm).toHaveBeenCalledWith("Close the faucet? New participants will not receive funds.");
    await waitFor(() => expect(deps.setState).toHaveBeenCalledWith(expect.objectContaining({ open: false, proof })));
    expect(deps.setState.mock.calls[0][0].password).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId("faucet-state")).toHaveTextContent("Faucet is closed."));
    confirm.mockRestore();
  });

  test("declining the confirm leaves the faucet open; opening needs no confirm", async () => {
    await signIn();
    const deps = makeDeps({ fetchPublicStatus: jest.fn(async () => ({ open: false })), fetchStatus: jest.fn(async () => ({ ...statusBody, open: false })) });
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
    render_(deps);
    await waitFor(() => expect(screen.getByTestId("faucet-state")).toHaveTextContent("Faucet is closed."));
    fireEvent.click(screen.getByRole("button", { name: "Open faucet" }));
    await waitFor(() => expect(deps.setState).toHaveBeenCalledWith(expect.objectContaining({ open: true })));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockClear();
    fireEvent.click(await screen.findByRole("button", { name: "Close faucet" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deps.setState).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  test("without a proof the password field is shown and used", async () => {
    const deps = makeDeps();
    render_(deps);
    const field = await screen.findByLabelText("Faucet admin password");
    fireEvent.change(field, { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Load status" }));
    await waitFor(() => expect(deps.fetchStatus).toHaveBeenCalledWith(expect.objectContaining({ password: "pw" })));
    expect(deps.fetchStatus.mock.calls[0][0].proof).toBeUndefined();
  });

  test("when the faucet refuses the proof (401) the password field appears", async () => {
    await signIn();
    const deps = makeDeps({ fetchStatus: jest.fn(async ({ proof }) => { if (proof) throw Object.assign(new Error("The faucet did not accept your admin wallet."), { code: "unauthorized" }); return statusBody; }) });
    render_(deps);
    expect(await screen.findByLabelText("Faucet admin password")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/did not accept your admin wallet/);
    expect(screen.queryByTestId("wallet-auth-note")).toBeNull();
    fireEvent.change(screen.getByLabelText("Faucet admin password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Load status" }));
    await waitFor(() => expect(deps.fetchStatus).toHaveBeenLastCalledWith(expect.objectContaining({ password: "pw" })));
  });
});

describe("Auto-return controls", () => {
  test("use the wallet proof and hide the password field; a 401 brings the field back", async () => {
    await signIn();
    const proof = getAdminProofHeader(admin.address);
    const fetchSweeps_ = jest.fn(async ({ proof: p }) => { if (!p) return { sweeps: [], idleMinutes: 30 }; throw Object.assign(new Error("The faucet did not accept your admin wallet."), { code: "unauthorized" }); });
    const Host = ({ okProof }) => {
      const state = useAutoReturn({ faucetUrl: URL_BASE, deps: { fetchSweeps: okProof ? jest.fn(async () => ({ sweeps: [], idleMinutes: 30 })) : fetchSweeps_ } });
      return <AutoReturnControls state={state} />;
    };
    const { unmount } = render(<Host okProof />);
    expect(screen.queryByLabelText("Auto-return admin password")).toBeNull();
    expect(screen.getByTestId("wallet-auth-note")).toBeInTheDocument();
    unmount();
    render(<Host okProof={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Load auto-return" }));
    await waitFor(() => expect(fetchSweeps_).toHaveBeenCalledWith(expect.objectContaining({ proof })));
    expect(await screen.findByLabelText("Auto-return admin password")).toBeInTheDocument();
  });
});

describe("rollout: a faucet that is not redeployed yet rejects x-admin-proof in CORS (network error)", () => {
  const networkError = () => Object.assign(new Error("Could not reach the test-funds service."), { code: "network" });
  const proofOnlyFails = (error) => jest.fn(async ({ proof }) => { if (proof) throw error; return "ok"; });

  test.each([
    ["FaucetError network", networkError],
    ["fetch TypeError", () => new TypeError("Failed to fetch")],
  ])("%s: the proof is treated as refused and the password field appears", async (name, make) => {
    await signIn();
    const { result } = renderHook(() => useFaucetSessionPassword());
    expect(result.current.hasCredential).toBe(true);
    const action = proofOnlyFails(make());
    await act(async () => { await expect(result.current.run("", action)).rejects.toThrow(/did not accept your admin wallet/); });
    expect(result.current.usesWallet).toBe(false);
    expect(result.current.hasCredential).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("with a session password the password request is made right away", async () => {
    await signIn();
    setSessionPassword("saved");
    const { result } = renderHook(() => useFaucetSessionPassword());
    const action = proofOnlyFails(networkError());
    await act(async () => { expect(await result.current.run("", action)).toBe("ok"); });
    expect(action.mock.calls.map(([auth]) => Object.keys(auth)[0])).toEqual(["proof", "password"]);
    expect(action).toHaveBeenLastCalledWith({ password: "saved" });
  });

  test("a later, freshly signed proof is tried again", async () => {
    const first = await signIn();
    const { result } = renderHook(() => useFaucetSessionPassword());
    const action = proofOnlyFails(networkError());
    await act(async () => { await expect(result.current.run("", action)).rejects.toThrow(); });
    await act(async () => { await expect(result.current.run("", action)).rejects.toThrow(/Enter the faucet admin password/); });
    expect(action).toHaveBeenCalledTimes(1); // the refused proof is not sent again
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await signIn();
    expect(second.signature).not.toBe(first.signature);
    await act(async () => { await expect(result.current.run("", action)).rejects.toThrow(); });
    expect(action).toHaveBeenCalledTimes(2);
    expect(action.mock.calls[1][0].proof).toBe(getAdminProofHeader(admin.address));
  });

  test("Faucet funds auto-load on mount: the network error shows the password field instead of a stuck error", async () => {
    await signIn();
    const deps = {
      readBalances: jest.fn(async () => ({})), fetchPublicStatus: jest.fn(async () => ({ open: true })), setState: jest.fn(), setMax: jest.fn(),
      fetchStatus: jest.fn(async ({ proof, password }) => { if (proof) throw networkError(); return { payoutsUsed: 0, maxPayouts: 5, faucetAddress: FAUCET, payoutAmount: "1", open: true, password }; }),
    };
    render(<FaucetFundsCardBody faucetUrl={URL_BASE} envAddress={FAUCET} adminAccount={admin.address} showStateSwitch deps={deps} />);
    const field = await screen.findByLabelText("Faucet admin password");
    expect(deps.fetchStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("wallet-auth-note")).toBeNull();
    fireEvent.change(field, { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Load status" }));
    await waitFor(() => expect(deps.fetchStatus).toHaveBeenLastCalledWith(expect.objectContaining({ password: "pw" })));
    await waitFor(() => expect(screen.getByTestId("faucet-payouts")).toBeInTheDocument());
  });

  test("with a session password the auto-load falls back to it and shows the status", async () => {
    await signIn();
    setSessionPassword("saved");
    const deps = {
      readBalances: jest.fn(async () => ({})), fetchPublicStatus: jest.fn(async () => ({ open: true })), setState: jest.fn(), setMax: jest.fn(),
      fetchStatus: jest.fn(async ({ proof }) => { if (proof) throw new TypeError("Failed to fetch"); return { payoutsUsed: 2, maxPayouts: 5, faucetAddress: FAUCET, payoutAmount: "1", open: true }; }),
    };
    render(<FaucetFundsCardBody faucetUrl={URL_BASE} envAddress={FAUCET} adminAccount={admin.address} showStateSwitch deps={deps} />);
    expect(await screen.findByTestId("faucet-payouts")).toHaveTextContent("2 of 5 payouts used");
    expect(deps.fetchStatus).toHaveBeenLastCalledWith(expect.objectContaining({ password: "saved" }));
  });
});
