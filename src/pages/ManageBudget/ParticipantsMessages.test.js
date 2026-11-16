import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parseNative } from "../../real_ethereum/wallets/nativeBalance";
import ParticipantsGasCard from "./ParticipantsGasCard";
import { clearSessionPassword, getSessionPassword, setSessionPassword } from "./faucetSessionPassword";

const mockAccess = { account: "" };
jest.mock("../../real_ethereum/walletAccess", () => ({
  getWalletAccess: () => ({ status: mockAccess.account ? "connected" : "unavailable", account: mockAccess.account }),
  subscribeWalletAccess: () => () => {},
}));
jest.mock("./participantsGasReaders", () => ({ readNativeBalances: jest.fn(), readBudgets: jest.fn(), readParticipantSources: jest.fn() }));
jest.mock("./adminTransfer", () => ({ sendNativeFromAdmin: jest.fn(), waitForReceipt: jest.fn(), readAdminBalance: jest.fn(), explorerTxUrl: (hash) => `https://explorer/tx/${hash}` }));

const a = (n) => `0x${String(n).repeat(40)}`;
const ADMIN = a("e");
const HASH_1 = "11".repeat(32);
const HASH_2 = "22".repeat(32);
const sweep = (n, pidHash) => ({ address: a(n), pidHash, lastSeen: null, armedValue: "0", status: "none", txHash: null, returnedWei: "0" });

const makeDeps = (messages) => ({
  readSources: jest.fn(async () => ({ users: [a(1), a(2), a(3)], events: [], latestBlock: 100, warning: "" })),
  readBalances: jest.fn(async (addresses) => Object.fromEntries(addresses.map((address) => [address, parseNative("1")]))),
  readBudgets: jest.fn(async (addresses) => Object.fromEntries(addresses.map((address) => [address, "1000"]))),
  send: jest.fn(), waitFor: jest.fn(), readAdminBalance: jest.fn(async () => parseNative("10")),
  autoReturn: { fetchSweeps: jest.fn(async () => ({ idleMinutes: 30, sweeps: [sweep(1, HASH_1), sweep(2, HASH_2)] })), saveSweepIdleMinutes: jest.fn() },
  messages,
});
const rowFor = (address) => screen.getAllByTestId("participant-row").find((row) => row.textContent.includes(address));
const messageApi = (extra = {}) => ({
  fetchAdminMessages: jest.fn(async () => ({ broadcasts: [], participants: [{ pidHash: HASH_1, messages: [] }] })),
  sendAdminMessage: jest.fn(async () => ({ id: "m1" })),
  ...extra,
});

beforeEach(() => {
  process.env.REACT_APP_ADMIN_ADDRESSES = ADMIN;
  process.env.REACT_APP_FAUCET_URL = "https://faucet.example";
  mockAccess.account = ADMIN;
  window.localStorage.clear();
  clearSessionPassword();
});
afterEach(() => { delete process.env.REACT_APP_ADMIN_ADDRESSES; delete process.env.REACT_APP_FAUCET_URL; });

test("Send message is always visible and enabled on every row, even before the auto-return list is loaded", async () => {
  render(<ParticipantsGasCard defaultOpen deps={makeDeps({})} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  for (const row of screen.getAllByTestId("participant-row")) expect(within(row).getByRole("button", { name: "Send message" }).disabled).toBe(false);
});

test("without a session password the dialog shows the single password field and resolves the pid hash itself", async () => {
  const messages = messageApi();
  const deps = makeDeps(messages);
  render(<ParticipantsGasCard defaultOpen deps={deps} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.click(within(rowFor(a(1))).getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByTestId("send-message-dialog");
  expect(deps.autoReturn.fetchSweeps).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("button", { name: "Send" }).disabled).toBe(true);
  fireEvent.change(within(dialog).getByLabelText("Message admin password"), { target: { value: "pw2" } });
  fireEvent.change(within(dialog).getByLabelText("Message text"), { target: { value: "  Hello  " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(messages.sendAdminMessage).toHaveBeenCalledWith(expect.objectContaining({ password: "pw2", pidHash: HASH_1, all: false, body: "Hello" })));
  expect(deps.autoReturn.fetchSweeps).toHaveBeenCalledWith(expect.objectContaining({ password: "pw2" }));
  await waitFor(() => expect(within(dialog).getByText("Message sent.")).toBeTruthy());
  expect(getSessionPassword()).toBe("pw2");
  // The password is asked once: a second message needs no field and no typing.
  expect(within(dialog).queryByLabelText("Message admin password")).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("Message text"), { target: { value: "Again" } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Send" }).disabled).toBe(false));
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(messages.sendAdminMessage).toHaveBeenLastCalledWith(expect.objectContaining({ password: "pw2", body: "Again" })));
});

test("with a session password, clicking Send message loads the pid hash silently and opens a dialog without a password field", async () => {
  setSessionPassword("pw-session");
  const messages = messageApi({
    fetchAdminMessages: jest.fn(async () => ({
      broadcasts: [{ id: "b1", body: "Break at noon", createdAt: "2026-01-01T10:00:00.000Z", read: true }],
      participants: [{ pidHash: HASH_1, messages: [{ id: "m1", body: "Hello there", createdAt: "2026-01-01T11:00:00.000Z", readAt: null }] }],
    })),
  });
  const deps = makeDeps(messages);
  render(<ParticipantsGasCard defaultOpen deps={deps} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.click(within(rowFor(a(1))).getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByTestId("send-message-dialog");
  expect(deps.autoReturn.fetchSweeps).toHaveBeenCalledWith(expect.objectContaining({ password: "pw-session" }));
  expect(within(dialog).queryByLabelText("Message admin password")).toBeNull();
  await waitFor(() => expect(within(dialog).getAllByTestId("message-history-entry")).toHaveLength(2));
  expect(messages.fetchAdminMessages).toHaveBeenCalledWith(expect.objectContaining({ password: "pw-session", pidHash: HASH_1 }));
  const entries = within(dialog).getAllByTestId("message-history-entry").map((entry) => entry.textContent);
  expect(entries[0]).toContain("unread");
  expect(entries[1]).toContain("read (sent to all)");

  fireEvent.change(within(dialog).getByLabelText("Message text"), { target: { value: "Second" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(messages.sendAdminMessage).toHaveBeenCalledWith(expect.objectContaining({ password: "pw-session", pidHash: HASH_1, body: "Second" })));
  await waitFor(() => expect(within(dialog).getByText("Message sent.")).toBeTruthy());
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByTestId("send-message-dialog")).toBeNull());
});

test("a participant the faucet does not know yet reports it instead of sending", async () => {
  setSessionPassword("pw-session");
  const messages = messageApi();
  render(<ParticipantsGasCard defaultOpen deps={makeDeps(messages)} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.click(within(rowFor(a(3))).getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByTestId("send-message-dialog");
  expect((await within(dialog).findByRole("alert")).textContent).toBe("This participant is not known to the faucet yet.");
  expect(messages.sendAdminMessage).not.toHaveBeenCalled();
});

test("the dialog tells admins when participants see the message", async () => {
  render(<ParticipantsGasCard defaultOpen deps={makeDeps(messageApi())} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.click(screen.getByRole("button", { name: "Message all participants" }));
  expect(await screen.findByText(/within about 5 seconds/)).toBeTruthy();
});

test("Message all participants sends a broadcast and shows how many read each one; errors are reported", async () => {
  const messages = {
    fetchAdminMessages: jest.fn(async () => ({ broadcasts: [{ id: "b1", body: "Break at noon", createdAt: "2026-01-01T10:00:00.000Z", readCount: 3 }], participants: [] })),
    sendAdminMessage: jest.fn().mockRejectedValueOnce(Object.assign(new Error("Wrong password."), { code: "unauthorized" })).mockResolvedValue({ id: "b2" }),
  };
  render(<ParticipantsGasCard defaultOpen deps={makeDeps(messages)} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  fireEvent.click(screen.getByRole("button", { name: "Message all participants" }));
  const dialog = await screen.findByTestId("send-message-dialog");
  expect(within(dialog).getByText("Message all participants", { selector: "h2" })).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Message admin password"), { target: { value: "bad" } });
  fireEvent.change(within(dialog).getByLabelText("Message text"), { target: { value: "Lunch is ready" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("Wrong password.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(messages.sendAdminMessage).toHaveBeenLastCalledWith(expect.objectContaining({ all: true, pidHash: undefined, body: "Lunch is ready" })));
  const entry = await within(dialog).findByTestId("message-history-entry");
  expect(entry.textContent).toContain("Break at noon");
  expect(entry.textContent).toContain("read by 3");
});

test("without a faucet URL there is no messaging", async () => {
  delete process.env.REACT_APP_FAUCET_URL;
  render(<ParticipantsGasCard defaultOpen deps={makeDeps({})} />);
  await waitFor(() => expect(screen.getAllByTestId("participant-row")).toHaveLength(3));
  expect(screen.queryByRole("button", { name: "Message all participants" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
});
