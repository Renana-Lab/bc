import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parseNative } from "../../real_ethereum/wallets/nativeBalance";
import ParticipantsGasCard from "./ParticipantsGasCard";
import { clearSessionPassword } from "./faucetSessionPassword";

const mockAccess = { account: "" };
jest.mock("../../real_ethereum/walletAccess", () => ({
  getWalletAccess: () => ({ status: mockAccess.account ? "connected" : "unavailable", account: mockAccess.account }),
  subscribeWalletAccess: () => () => {},
}));
jest.mock("./participantsGasReaders", () => ({ readNativeBalances: jest.fn(), readBudgets: jest.fn(), readParticipantSources: jest.fn() }));
jest.mock("./adminTransfer", () => ({ sendNativeFromAdmin: jest.fn(), waitForReceipt: jest.fn(), readAdminBalance: jest.fn(), explorerTxUrl: (hash) => `https://explorer/tx/${hash}` }));

const a = (n) => `0x${String(n).repeat(40)}`;
const ADMIN = a("e");
const T = (text) => parseNative(text);
const sweep = (n, fields) => ({ address: a(n), pidHash: "ab".repeat(32), lastSeen: "2026-01-01T00:00:00.000Z", armedValue: "0", status: "none", txHash: null, returnedWei: "0", ...fields });

const makeDeps = (autoReturn) => ({
  readSources: jest.fn(async () => ({ users: [a(1), a(2), a(3)], events: [], latestBlock: 100, warning: "" })),
  readBalances: jest.fn(async (addresses) => Object.fromEntries(addresses.map((address) => [address, T("1")]))),
  readBudgets: jest.fn(async (addresses) => Object.fromEntries(addresses.map((address) => [address, "1000"]))),
  send: jest.fn(), waitFor: jest.fn(), readAdminBalance: jest.fn(async () => T("10")),
  autoReturn,
});
const rowFor = (address) => screen.getAllByTestId("participant-row").find((row) => row.textContent.includes(address));

beforeEach(() => {
  process.env.REACT_APP_ADMIN_ADDRESSES = ADMIN;
  process.env.REACT_APP_FAUCET_URL = "https://faucet.example";
  mockAccess.account = ADMIN;
  window.localStorage.clear();
  clearSessionPassword();
});
afterEach(() => { delete process.env.REACT_APP_ADMIN_ADDRESSES; delete process.env.REACT_APP_FAUCET_URL; });

test("the card has Auto-return and Returned columns, 'none' until the list is loaded with the faucet password", async () => {
  const fetchSweeps = jest.fn(async () => ({
    idleMinutes: 45,
    sweeps: [
      sweep(1, { status: "armed", armedValue: T("0.4").toString() }),
      sweep(2, { status: "sent", txHash: `0x${"1".repeat(64)}`, returnedWei: T("0.25").toString() }),
      sweep(3, { status: "stale" }),
    ],
  }));
  render(<ParticipantsGasCard defaultOpen deps={makeDeps({ fetchSweeps })} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  expect(screen.getByText("Auto-return")).toBeTruthy();
  expect(screen.getByText("Returned")).toBeTruthy();
  for (const row of screen.getAllByTestId("participant-row")) expect(within(row).getByTestId("auto-return-status").textContent).toBe("none");

  const password = screen.getByLabelText("Auto-return admin password");
  expect(screen.getByRole("button", { name: "Load auto-return" }).disabled).toBe(true);
  fireEvent.change(password, { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: "Load auto-return" }));
  await waitFor(() => expect(within(rowFor(a(1))).getByTestId("auto-return-status").textContent).toMatch(/^armed \(0\.4000 TEST\)/));
  expect(fetchSweeps).toHaveBeenCalledWith(expect.objectContaining({ password: "pw" }));
  expect(screen.queryByLabelText("Auto-return admin password")).toBeNull(); // remembered for the session: no field any more
  expect(password.isConnected).toBe(false);
  expect(within(rowFor(a(2))).getByTestId("auto-return-status").textContent).toBe("sent");
  expect(within(rowFor(a(2))).getByTestId("auto-return-returned").textContent).toBe("0.2500 TEST");
  expect(within(rowFor(a(3))).getByTestId("auto-return-status").textContent).toBe("stale");
  expect(within(rowFor(a(1))).getByTestId("auto-return-returned").textContent).toBe("—");
  expect(screen.getByLabelText("Idle minutes").value).toBe("45");
});

test("the idle minutes can be changed with the password; a wrong password is reported", async () => {
  const saveSweepIdleMinutes = jest.fn(async ({ idleMinutes }) => idleMinutes);
  const fetchSweeps = jest.fn(async () => ({ idleMinutes: 30, sweeps: [] }));
  render(<ParticipantsGasCard defaultOpen deps={makeDeps({ fetchSweeps, saveSweepIdleMinutes })} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.change(screen.getByLabelText("Auto-return admin password"), { target: { value: "pw" } });
  fireEvent.change(screen.getByLabelText("Idle minutes"), { target: { value: "90" } });
  fireEvent.click(screen.getByRole("button", { name: "Save idle time" }));
  await waitFor(() => expect(saveSweepIdleMinutes).toHaveBeenCalledWith(expect.objectContaining({ idleMinutes: 90, password: "pw" })));
  await waitFor(() => expect(screen.getByLabelText("Idle minutes").value).toBe("90"));

  // The save worked, so the password is remembered; a refusal drops it and the field comes back.
  fetchSweeps.mockRejectedValueOnce(Object.assign(new Error("Wrong password."), { code: "unauthorized" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Load auto-return" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Load auto-return" }));
  await waitFor(() => expect(screen.getByText("Wrong password.")).toBeTruthy());
  expect(screen.getByLabelText("Auto-return admin password")).toBeTruthy();
});

test("without a faucet URL the auto-return controls stay hidden but the card still works", async () => {
  delete process.env.REACT_APP_FAUCET_URL;
  render(<ParticipantsGasCard defaultOpen deps={makeDeps({})} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  expect(screen.queryByTestId("auto-return-controls")).toBeNull();
});
