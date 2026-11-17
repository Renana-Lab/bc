import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parseNative } from "../../real_ethereum/wallets/nativeBalance";
import ParticipantsGasCard from "./ParticipantsGasCard";

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

const makeDeps = ({ adminBalance = T("10"), balances } = {}) => {
  const state = { admin: adminBalance };
  const deps = {
    readSources: jest.fn(async () => ({ users: [a(1), a(2), a(3)], events: [{ actor: a(2), blockNumber: 90, args: {} }], latestBlock: 100, warning: "" })),
    readBalances: jest.fn(async (addresses) => Object.fromEntries(addresses.map((address) => [address, (balances || { [a(1)]: T("0.02"), [a(2)]: T("0.5"), [a(3)]: T("0.09") })[address] ?? T("1")]))),
    readBudgets: jest.fn(async (addresses) => Object.fromEntries(addresses.map((address) => [address, "1000"]))),
    send: jest.fn(async (to, amount) => { state.admin -= amount; return `0x${to.slice(2, 8)}`; }),
    waitFor: jest.fn(async () => true),
    readAdminBalance: jest.fn(async () => state.admin),
  };
  return deps;
};
const rowFor = (address) => screen.getAllByTestId("participant-row").find((row) => row.textContent.includes(address));

beforeEach(() => {
  process.env.REACT_APP_ADMIN_ADDRESSES = ADMIN;
  mockAccess.account = ADMIN;
  window.localStorage.clear();
});
afterEach(() => { delete process.env.REACT_APP_ADMIN_ADDRESSES; });

test("a non-admin (or no wallet) never sees the card", () => {
  mockAccess.account = a(9);
  const deps = makeDeps();
  const view = render(<ParticipantsGasCard defaultOpen deps={deps} />);
  expect(view.container.textContent).toBe("");
  expect(deps.readSources).not.toHaveBeenCalled();
  view.unmount();
  mockAccess.account = "";
  expect(render(<ParticipantsGasCard defaultOpen deps={deps} />).container.textContent).toBe("");
});

test("lists every participant with full address, balance, budget and last activity; low rows are highlighted", async () => {
  render(<ParticipantsGasCard defaultOpen deps={makeDeps()} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  const rows = screen.getAllByTestId("participant-row");
  expect(rows.map((row) => row.getAttribute("data-low"))).toEqual(["true", "true", "false"]); // sorted by balance: 0.02, 0.09, 0.5
  expect(rowFor(a(1)).textContent).toContain(a(1));
  expect(rowFor(a(1)).textContent).toContain("0.0200");
  expect(rowFor(a(2)).textContent).toContain("block 90 (10 blocks ago)");
  expect(rowFor(a(2)).textContent).toContain("1000");
  expect(within(rowFor(a(1))).getByRole("button", { name: `Copy ${a(1)}` })).toBeTruthy();
});

test("the threshold is editable, re-evaluates highlighting and is saved in localStorage", async () => {
  render(<ParticipantsGasCard defaultOpen deps={makeDeps()} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.change(screen.getByLabelText("Threshold"), { target: { value: "0.6" } });
  expect(screen.getAllByTestId("participant-row").map((row) => row.getAttribute("data-low"))).toEqual(["true", "true", "true"]);
  expect(window.localStorage.getItem("bc:participants-gas:threshold")).toBe("0.6");
});

test("Top up all needs a confirmation dialog first; then it sends exactly the low rows, sequentially, with live statuses", async () => {
  const deps = makeDeps();
  render(<ParticipantsGasCard defaultOpen deps={deps} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.click(screen.getByRole("button", { name: /Top up all below threshold \(2\)/ }));
  const summary = await screen.findByTestId("confirm-summary");
  expect(summary.textContent).toBe("Send 0.5 TEST to 2 addresses. Total: 1.0000 TEST.");
  await waitFor(() => expect(screen.getByTestId("confirm-admin-balance").textContent).toBe("Your balance: 10.0000 TEST"));
  expect(deps.send).not.toHaveBeenCalled(); // nothing is sent before the explicit confirmation

  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await waitFor(() => expect(deps.send).toHaveBeenCalledTimes(2));
  expect(deps.send.mock.calls.map(([to, amount]) => [to, amount])).toEqual([[a(1), T("0.5")], [a(3), T("0.5")]]);
  await waitFor(() => expect(within(rowFor(a(1))).getByTestId("row-status").textContent).toMatch(/Confirmed/));
  expect(within(rowFor(a(3))).getByTestId("row-status").textContent).toMatch(/Confirmed/);
  expect(within(rowFor(a(2))).getByTestId("row-status").textContent).toBe("");
});

test("cancelling the confirmation sends nothing", async () => {
  const deps = makeDeps();
  render(<ParticipantsGasCard defaultOpen deps={deps} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.click(within(rowFor(a(1))).getByRole("button", { name: "Top up" }));
  await screen.findByTestId("confirm-summary");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByTestId("confirm-summary")).toBeNull());
  expect(deps.send).not.toHaveBeenCalled();
});

test("a bulk run stops when the admin balance runs out and marks the rest skipped", async () => {
  const deps = makeDeps({ adminBalance: T("0.6") });
  render(<ParticipantsGasCard defaultOpen deps={deps} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.click(screen.getByRole("button", { name: /Top up all below threshold/ }));
  await screen.findByText(/does not cover every transfer/);
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await waitFor(() => expect(within(rowFor(a(3))).getByTestId("row-status").textContent).toMatch(/Skipped: Admin balance too low/));
  expect(deps.send).toHaveBeenCalledTimes(1);
  expect(within(rowFor(a(1))).getByTestId("row-status").textContent).toMatch(/Confirmed/);
});

test("the top-up amount is editable (default 0.5) and a manually added address (a bot) gets a row", async () => {
  const deps = makeDeps();
  render(<ParticipantsGasCard defaultOpen deps={deps} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  expect(screen.getByLabelText("Top-up amount").value).toBe("0.5");
  fireEvent.change(screen.getByLabelText("Top-up amount"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Add address"), { target: { value: a(7) } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(4));
  expect(rowFor(a(7))).toBeTruthy();
  fireEvent.click(within(rowFor(a(7))).getByRole("button", { name: "Top up" }));
  expect((await screen.findByTestId("confirm-summary")).textContent).toBe("Send 2 TEST to 1 address. Total: 2.0000 TEST.");
});

test("auto-refreshes every 60 s while visible (and not while the tab is hidden)", async () => {
  jest.useFakeTimers("modern");
  try {
    const deps = makeDeps();
    render(<ParticipantsGasCard defaultOpen deps={deps} refreshMs={60_000} />);
    await waitFor(() => expect(deps.readSources).toHaveBeenCalledTimes(1));
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await waitFor(() => expect(deps.readSources).toHaveBeenCalledTimes(2));
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(deps.readSources).toHaveBeenCalledTimes(2);
  } finally {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    jest.useRealTimers();
  }
});

test("bidders and sellers that only appear in events are read, flagged low and included in Top up all", async () => {
  const deps = makeDeps();
  deps.readSources = jest.fn(async () => ({
    users: [a(1)],
    events: [{ actor: a(5), blockNumber: 95, args: {} }, { actor: "", blockNumber: 96, args: { seller: a(6), user: a(1) } }],
    latestBlock: 100, warning: "",
  }));
  deps.readBalances = jest.fn(async (addresses) => Object.fromEntries(addresses.map((address) => [address, address === a(5) ? T("0.01") : T("1")])));
  render(<ParticipantsGasCard defaultOpen deps={deps} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  const requested = deps.readBalances.mock.calls[0][0];
  expect(requested).toEqual(expect.arrayContaining([a(1), a(5), a(6)]));
  expect(deps.readBudgets.mock.calls[0][0]).toEqual(expect.arrayContaining([a(5), a(6)]));
  expect(rowFor(a(5)).getAttribute("data-low")).toBe("true");
  expect(rowFor(a(5)).textContent).toContain("block 95");
  fireEvent.click(screen.getByRole("button", { name: /Top up all below threshold \(1\)/ }));
  await screen.findByTestId("confirm-summary");
  await waitFor(() => expect(screen.getByTestId("confirm-admin-balance").textContent).toMatch(/10\.0000/));
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await waitFor(() => expect(deps.send).toHaveBeenCalledTimes(1));
  expect(deps.send.mock.calls[0][0]).toBe(a(5));
});

test("the connected admin address is excluded from Top up all (but can still be topped up row by row)", async () => {
  const deps = makeDeps({ balances: { [a(1)]: T("0.02"), [a(2)]: T("0.5"), [a(3)]: T("0.09"), [ADMIN]: T("0.01") } });
  deps.readSources = jest.fn(async () => ({ users: [a(1), a(2), a(3), ADMIN], events: [], latestBlock: 100, warning: "" }));
  render(<ParticipantsGasCard defaultOpen deps={deps} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(4));
  expect(rowFor(ADMIN).getAttribute("data-low")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /Top up all below threshold \(2\)/ }));
  await screen.findByTestId("confirm-summary");
  await waitFor(() => expect(screen.getByTestId("confirm-admin-balance").textContent).toMatch(/10\.0000/));
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await waitFor(() => expect(deps.send).toHaveBeenCalledTimes(2));
  expect(deps.send.mock.calls.map(([to]) => to)).toEqual([a(1), a(3)]);
  await waitFor(() => expect(within(rowFor(ADMIN)).getByRole("button", { name: "Top up" }).disabled).toBe(false));
});

test("a confirmation that times out is shown as 'Unconfirmed (check explorer)', not Failed", async () => {
  const deps = makeDeps();
  deps.waitFor = jest.fn(async () => null);
  render(<ParticipantsGasCard defaultOpen deps={deps} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.click(within(rowFor(a(1))).getByRole("button", { name: "Top up" }));
  await screen.findByTestId("confirm-summary");
  await waitFor(() => expect(screen.getByTestId("confirm-admin-balance").textContent).toMatch(/10\.0000/));
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await waitFor(() => expect(within(rowFor(a(1))).getByTestId("row-status").textContent).toMatch(/Unconfirmed \(check explorer\)/));
  expect(within(rowFor(a(1))).getByTestId("row-status").textContent).not.toMatch(/Failed/);
});
