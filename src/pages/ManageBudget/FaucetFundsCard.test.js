import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { parseNative } from "../../real_ethereum/wallets/nativeBalance";
import FaucetFundsCard, { FaucetFundsCardBody, payoutWarnings, remainingPayouts } from "./FaucetFundsCard";
import { clearSessionPassword, getSessionPassword } from "./faucetSessionPassword";

const mockAccess = { account: "" };
jest.mock("../../real_ethereum/walletAccess", () => ({
  getWalletAccess: () => ({ status: mockAccess.account ? "connected" : "unavailable", account: mockAccess.account }),
  subscribeWalletAccess: () => () => {},
}));
jest.mock("./participantsGasReaders", () => ({ readNativeBalances: jest.fn() }));
jest.mock("./adminTransfer", () => ({
  sendNativeFromAdmin: jest.fn(), waitForReceipt: jest.fn(), readAdminBalance: jest.fn(),
  explorerTxUrl: (hash) => `https://explorer.oasis.io/testnet/sapphire/tx/${hash}`,
  explorerAddressUrl: (address) => `https://explorer.oasis.io/testnet/sapphire/address/${address}`,
}));

const FAUCET = `0x${"f".repeat(40)}`;
const ADMIN = `0x${"e".repeat(40)}`;
const T = (text) => parseNative(text);
const PAYOUT = T("0.1");

const makeDeps = ({ faucetBalance = T("20"), adminBalance = T("50"), status } = {}) => ({
  readBalances: jest.fn(async () => ({ [FAUCET]: faucetBalance })),
  fetchStatus: jest.fn(async () => status || { payoutsUsed: 40, maxPayouts: 50, faucetAddress: FAUCET, payoutAmount: PAYOUT.toString(), open: true }),
  setMax: jest.fn(async ({ value }) => ({ payoutsUsed: 40, maxPayouts: value })),
  send: jest.fn(async () => "0xabc123"),
  waitFor: jest.fn(async () => true),
  readAdminBalance: jest.fn(async () => adminBalance),
});
const body = (deps, props = {}) => render(<FaucetFundsCardBody faucetUrl="https://faucet.example" envAddress={FAUCET} adminAccount={ADMIN} deps={deps} {...props} />);

beforeEach(() => {
  process.env.REACT_APP_ADMIN_ADDRESSES = ADMIN;
  process.env.REACT_APP_FAUCET_URL = "https://faucet.example";
  process.env.REACT_APP_FAUCET_ADDRESS = FAUCET;
  mockAccess.account = ADMIN;
});
afterEach(() => { delete process.env.REACT_APP_ADMIN_ADDRESSES; delete process.env.REACT_APP_FAUCET_URL; delete process.env.REACT_APP_FAUCET_ADDRESS; });

describe("helpers", () => {
  test("remaining payouts = floor(balance / payout amount); unknown inputs give null", () => {
    expect(remainingPayouts(T("1.05"), T("0.1"))).toBe(10n);
    expect(remainingPayouts(null, T("0.1"))).toBeNull();
    expect(remainingPayouts(T("1"), null)).toBeNull();
  });
  test("warnings: fewer than 5 payouts left, or balance below left * payout amount", () => {
    const status = (used, max) => ({ payoutsUsed: used, maxPayouts: max, payoutAmount: PAYOUT.toString() });
    expect(payoutWarnings({ status: status(0, 100), balanceWei: T("100") })).toEqual([]);
    expect(payoutWarnings({ status: status(97, 100), balanceWei: T("100") })[0]).toMatch(/Only 3 payouts left/);
    expect(payoutWarnings({ status: status(0, 100), balanceWei: T("9.9") })[0]).toMatch(/does not cover the remaining payouts/);
    expect(payoutWarnings({ status: { payoutsUsed: 0, maxPayouts: null }, balanceWei: 0n })).toEqual([]);
  });
});

describe("balance", () => {
  test("shows the live balance from the faucet address, and the remaining payouts once the payout amount is known", async () => {
    const deps = makeDeps();
    body(deps);
    await waitFor(() => expect(screen.getByTestId("faucet-balance").textContent).toMatch(/20\.0000 TEST/));
    expect(deps.readBalances).toHaveBeenCalledWith([FAUCET]);
    expect(screen.queryByTestId("faucet-low-badge")).toBeNull();
    expect(screen.queryByTestId("faucet-remaining")).toBeNull(); // amount unknown until the admin status is loaded
    fireEvent.change(screen.getByLabelText("Faucet admin password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Load status" }));
    expect((await screen.findByTestId("faucet-remaining")).textContent).toMatch(/: 200$/);
  });

  test("a warning badge appears below 5 TEST", async () => {
    body(makeDeps({ faucetBalance: T("4.9999") }));
    expect(await screen.findByTestId("faucet-low-badge")).toBeTruthy();
    expect(screen.getByTestId("faucet-balance").textContent).toMatch(/4\.9999 TEST/);
  });

  test("exactly 5 TEST is not low; the balance refreshes every 60 s while visible", async () => {
    jest.useFakeTimers("modern");
    try {
      const deps = makeDeps({ faucetBalance: T("5") });
      body(deps);
      await waitFor(() => expect(deps.readBalances).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("faucet-low-badge")).toBeNull();
      await act(async () => { jest.advanceTimersByTime(60_000); });
      await waitFor(() => expect(deps.readBalances).toHaveBeenCalledTimes(2));
    } finally { jest.useRealTimers(); }
  });
});

beforeEach(() => clearSessionPassword());

describe("payout limit", () => {
  const load = async (deps) => {
    body(deps);
    fireEvent.change(screen.getByLabelText("Faucet admin password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Load status" }));
    await screen.findByTestId("faucet-payouts");
  };

  test("shows 'X of Y payouts used, Z left' and remembers the password for the session instead of showing the field", async () => {
    const deps = makeDeps();
    await load(deps);
    expect(screen.getByTestId("faucet-payouts").textContent).toBe("40 of 50 payouts used, 10 left");
    expect(deps.fetchStatus).toHaveBeenCalledWith(expect.objectContaining({ password: "pw" }));
    expect(screen.queryByLabelText("Faucet admin password")).toBeNull();
    expect(getSessionPassword()).toBe("pw");
    expect(window.localStorage.length).toBe(0); // never localStorage
  });

  test("+10 asks for a confirmation, then saves limit + 10 without asking for the password again", async () => {
    const deps = makeDeps();
    await load(deps);
    fireEvent.click(screen.getByRole("button", { name: "+10" }));
    expect((await screen.findByTestId("add-confirm-text")).textContent).toMatch(/from 50 to 60 \(\+10\)/);
    expect(deps.setMax).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Confirm faucet admin password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(deps.setMax).toHaveBeenCalledWith(expect.objectContaining({ value: 60, password: "pw" })));
    await waitFor(() => expect(screen.getByTestId("faucet-payouts").textContent).toBe("40 of 60 payouts used, 20 left"));
  });

  test("after Forget the Add payouts dialog asks for the password inside the dialog", async () => {
    const deps = makeDeps();
    await load(deps);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    fireEvent.click(screen.getByRole("button", { name: "+50" }));
    await screen.findByTestId("add-confirm-text");
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm.disabled).toBe(true); // no password yet
    fireEvent.change(screen.getByLabelText("Confirm faucet admin password"), { target: { value: "pw3" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(deps.setMax).toHaveBeenCalledWith(expect.objectContaining({ value: 100, password: "pw3" })));
    await waitFor(() => expect(screen.queryByTestId("add-confirm-text")).toBeNull());
  });

  test("cancelling the dialog discards the typed password", async () => {
    const deps = makeDeps();
    await load(deps);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    fireEvent.click(screen.getByRole("button", { name: "+10" }));
    fireEvent.change(await screen.findByLabelText("Confirm faucet admin password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("add-confirm-text")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "+10" }));
    expect((await screen.findByLabelText("Confirm faucet admin password")).value).toBe("");
    expect(deps.setMax).not.toHaveBeenCalled();
  });

  test("custom amounts must be whole numbers", async () => {
    const deps = makeDeps();
    await load(deps);
    const add = screen.getByRole("button", { name: "Add payouts" });
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Custom payouts"), { target: { value: "2.5" } });
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Custom payouts"), { target: { value: "7" } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect((await screen.findByTestId("add-confirm-text")).textContent).toMatch(/to 57 \(\+7\)/);
  });

  test("warns when fewer than 5 payouts are left or the balance cannot cover them", async () => {
    await load(makeDeps({ status: { payoutsUsed: 48, maxPayouts: 50, faucetAddress: FAUCET, payoutAmount: PAYOUT.toString(), open: true }, faucetBalance: T("0.1") }));
    const warnings = screen.getAllByTestId("faucet-warning").map((node) => node.textContent);
    expect(warnings).toEqual(["Only 2 payouts left.", "The faucet balance does not cover the remaining payouts."]);
  });

  test("a wrong password shows the error and keeps nothing", async () => {
    const deps = makeDeps();
    deps.fetchStatus.mockRejectedValue(new Error("Wrong password."));
    body(deps);
    fireEvent.change(screen.getByLabelText("Faucet admin password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Load status" }));
    expect((await screen.findByRole("status")).textContent).toBe("Wrong password.");
    expect(screen.getByLabelText("Faucet admin password").value).toBe("");
    expect(getSessionPassword()).toBe(""); // a refused password is not remembered
  });
});

describe("Top up faucet (Admin Zone)", () => {
  const renderAdmin = (deps) => render(<FaucetFundsCard defaultOpen deps={deps} />);

  test("a non-admin cannot see the card at all", () => {
    mockAccess.account = `0x${"1".repeat(40)}`;
    const deps = makeDeps();
    const view = renderAdmin(deps);
    expect(view.container.textContent).toBe("");
    expect(deps.readBalances).not.toHaveBeenCalled();
    mockAccess.account = "";
    expect(renderAdmin(deps).container.textContent).toBe("");
  });

  test("the password page version has no wallet top-up", async () => {
    body(makeDeps());
    await screen.findByTestId("faucet-balance");
    expect(screen.queryByRole("button", { name: "Top up faucet" })).toBeNull();
  });

  test("requires a confirmation showing the amount and the admin's own balance; nothing is sent before it", async () => {
    const deps = makeDeps();
    renderAdmin(deps);
    expect(screen.getByLabelText("Top-up amount").value).toBe("10");
    fireEvent.click(await screen.findByRole("button", { name: "Top up faucet" }));
    expect((await screen.findByTestId("topup-confirm-text")).textContent).toBe("Send 10 TEST to the faucet.");
    await waitFor(() => expect(screen.getByTestId("topup-admin-balance").textContent).toBe("Your balance: 50.0000 TEST"));
    expect(deps.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
    await waitFor(() => expect(deps.send).toHaveBeenCalledWith(FAUCET, T("10")));
    const status = await screen.findByText(/Confirmed\./);
    expect(status.parentElement.textContent).toMatch(/View transaction/);
    expect(screen.getByRole("link", { name: "View transaction", hidden: true }).getAttribute("href")).toBe("https://explorer.oasis.io/testnet/sapphire/tx/0xabc123");
  });

  test("blocks the transfer when the admin balance is insufficient", async () => {
    const deps = makeDeps({ adminBalance: T("10") }); // 10 + network fee reserve does not fit
    renderAdmin(deps);
    fireEvent.click(await screen.findByRole("button", { name: "Top up faucet" }));
    expect(await screen.findByTestId("topup-insufficient")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm and send" }).disabled).toBe(true);
    expect(deps.send).not.toHaveBeenCalled();
  });

  test("cancel sends nothing; a failed send shows the error", async () => {
    const deps = makeDeps();
    renderAdmin(deps);
    fireEvent.click(await screen.findByRole("button", { name: "Top up faucet" }));
    await screen.findByTestId("topup-confirm-text");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deps.send).not.toHaveBeenCalled();
    deps.send.mockRejectedValue(new Error("User rejected"));
    await waitFor(() => expect(screen.queryByTestId("topup-confirm-text")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Top up faucet" }));
    await waitFor(() => expect(screen.getByTestId("topup-admin-balance").textContent).toMatch(/50\.0000/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
    await waitFor(() => expect(screen.getByTestId("faucet-topup-status").textContent).toMatch(/Failed: User rejected/));
  });
});

describe("faucet top-up confirmation", () => {
  test("a transfer whose receipt is not seen before the timeout is shown as unconfirmed, not failed", async () => {
    const deps = makeDeps();
    deps.waitFor = jest.fn(async () => null);
    render(<FaucetFundsCardBody faucetUrl="https://faucet.example" envAddress={FAUCET} adminAccount={ADMIN} allowTopUp deps={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Top up faucet" }));
    await waitFor(() => expect(screen.getByTestId("topup-admin-balance").textContent).toMatch(/50\.0000/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
    await waitFor(() => expect(screen.getByTestId("faucet-topup-status").textContent).toMatch(/Unconfirmed \(check explorer\)/));
    expect(screen.getByTestId("faucet-topup-status").textContent).not.toMatch(/Failed/);
  });
});
