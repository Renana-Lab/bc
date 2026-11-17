import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import AdminMessageHost from "./AdminMessageHost";
import { WALLET_SCOPE_OVERRIDE_KEY } from "./walletMode.mjs";
import { fetchSweepConfig } from "./sweepClient.mjs";
import { ackInbox, fetchInbox } from "./inboxClient.mjs";

jest.mock("./sweepClient.mjs", () => ({ fetchSweepConfig: jest.fn(), pidHashFor: () => "ab".repeat(32) }));
jest.mock("./inboxClient.mjs", () => ({ fetchInbox: jest.fn(), ackInbox: jest.fn() }));

const flush = async () => { for (let i = 0; i < 20; i += 1) await act(async () => { await Promise.resolve(); }); };
const ADDRESS = `0x${"a".repeat(40)}`;
const PID = "5f1a2b3c4d5e6f7a8b9c0d1e";
const msg = (id, body) => ({ id, body, createdAt: 1 });
let wallet;
let hidden;

const mount = (props = {}) => render(<AdminMessageHost wallet={wallet} address={ADDRESS} faucetUrl="https://faucet.example" strictPid={PID} openPid={PID} random={() => 0} {...props} />);
const setHidden = (value) => { hidden = value; document.dispatchEvent(new Event("visibilitychange")); };
const tick = async (ms) => { act(() => { jest.advanceTimersByTime(ms); }); await flush(); };

beforeEach(() => {
  jest.useFakeTimers();
  process.env.REACT_APP_WALLET_MODE = "local";
  delete process.env.REACT_APP_LOCAL_WALLET_PASSPHRASE;
  window.sessionStorage.clear();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  wallet = { signMessage: jest.fn(async () => "0xsig") };
  fetchSweepConfig.mockReset().mockResolvedValue({ chainId: 23295, pidMode: "prolific", serverTime: Date.now() + 90_000 });
  fetchInbox.mockReset().mockResolvedValue({ ok: true, messages: [], serverTime: null });
  ackInbox.mockReset().mockResolvedValue(true);
});
afterEach(() => { jest.useRealTimers(); delete process.env.REACT_APP_WALLET_MODE; });

test("nothing is drawn while there is no message", async () => {
  const { container } = mount();
  await flush();
  expect(fetchInbox).toHaveBeenCalledTimes(1);
  expect(container.innerHTML).toBe("");
});

test("a message opens a blocking popup; Got it acknowledges it and closes it", async () => {
  fetchInbox.mockResolvedValueOnce({ ok: true, messages: [msg("m1-aaaaaaaa", "Please come to the front desk.")], serverTime: null });
  mount();
  await flush();
  expect(screen.getByText("Message from the administrator")).toBeTruthy();
  expect(screen.getByTestId("admin-message-body").textContent).toBe("Please come to the front desk.");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy(); // Escape does not dismiss it
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(ackInbox).toHaveBeenCalledWith(expect.objectContaining({ faucetUrl: "https://faucet.example", address: ADDRESS, pidHash: "ab".repeat(32), ids: ["m1-aaaaaaaa"] }));
});

test("messages show one at a time in order; the text is plain text, not markup", async () => {
  fetchInbox.mockResolvedValueOnce({ ok: true, messages: [msg("m1-aaaaaaaa", "<b>first</b>"), msg("m2-aaaaaaaa", "second")], serverTime: null });
  const { container } = mount();
  await flush();
  expect(screen.getByTestId("admin-message-body").textContent).toBe("<b>first</b>");
  expect(document.querySelector("[data-testid='admin-message-body'] b")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await flush();
  expect(screen.getByTestId("admin-message-body").textContent).toBe("second");
  expect(ackInbox).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(ackInbox).toHaveBeenCalledTimes(2);
  expect(container.innerHTML).toBe("");
});

test("polls every 30 s while visible, pauses while hidden and checks again when the tab returns", async () => {
  mount();
  await flush();
  expect(fetchInbox).toHaveBeenCalledTimes(1);
  await tick(30_000);
  expect(fetchInbox).toHaveBeenCalledTimes(2);
  setHidden(true);
  await tick(90_000);
  expect(fetchInbox).toHaveBeenCalledTimes(2);
  setHidden(false);
  await flush();
  expect(fetchInbox).toHaveBeenCalledTimes(3);
});

test("a message is never shown twice: the server may repeat it until the acknowledgement lands", async () => {
  const same = { ok: true, messages: [msg("m1-aaaaaaaa", "once")], serverTime: null };
  fetchInbox.mockResolvedValue(same);
  ackInbox.mockResolvedValue(false); // the acknowledgement does not get through
  mount();
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await flush();
  await tick(30_000); // next poll: retries the ack first, and the repeated message is not queued again
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(ackInbox.mock.calls.length).toBeGreaterThanOrEqual(2);
  ackInbox.mockResolvedValue(true);
  await tick(30_000);
  const acks = ackInbox.mock.calls.length;
  await tick(60_000);
  expect(ackInbox.mock.calls.length).toBe(acks); // acknowledged: no more retries
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a new message arriving while one is open waits its turn", async () => {
  fetchInbox.mockResolvedValueOnce({ ok: true, messages: [msg("m1-aaaaaaaa", "one")], serverTime: null });
  mount();
  await flush();
  fetchInbox.mockResolvedValue({ ok: true, messages: [msg("m1-aaaaaaaa", "one"), msg("m2-aaaaaaaa", "two")], serverTime: null });
  await tick(30_000);
  expect(screen.getByTestId("admin-message-body").textContent).toBe("one");
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await flush();
  expect(screen.getByTestId("admin-message-body").textContent).toBe("two");
});

test("signatures use the server's clock", async () => {
  mount();
  await flush();
  const { now } = fetchInbox.mock.calls[0][0];
  expect(Math.abs(now() - (Date.now() + 90_000))).toBeLessThan(2000);
});

test("silent when the server is unreachable or the config cannot be read (it retries the config later)", async () => {
  fetchSweepConfig.mockResolvedValueOnce(null);
  const { container } = mount();
  await flush();
  expect(fetchInbox).not.toHaveBeenCalled();
  await tick(30_000); // the config retry is slower than the inbox poll
  expect(fetchInbox).toHaveBeenCalledTimes(1);
  fetchInbox.mockResolvedValue({ ok: false, messages: [], serverTime: null });
  await tick(30_000);
  expect(container.innerHTML).toBe("");
});

test("never runs for admins, the admin override, MetaMask mode, a missing pid or a missing faucet", async () => {
  const cases = [
    () => mount({ isAdmin: true }),
    () => { window.sessionStorage.setItem(WALLET_SCOPE_OVERRIDE_KEY, "admin"); return mount(); },
    () => { process.env.REACT_APP_WALLET_MODE = "metamask"; return mount(); },
    () => mount({ strictPid: "", openPid: "" }),
    () => mount({ faucetUrl: "" }),
    () => mount({ wallet: null }),
  ];
  for (const run of cases) {
    fetchSweepConfig.mockClear(); fetchInbox.mockClear();
    window.sessionStorage.clear(); process.env.REACT_APP_WALLET_MODE = "local";
    const view = run();
    await flush();
    await tick(60_000);
    expect(fetchSweepConfig).not.toHaveBeenCalled();
    expect(fetchInbox).not.toHaveBeenCalled();
    expect(view.container.innerHTML).toBe("");
    view.unmount();
  }
});

test("stops polling when it unmounts", async () => {
  const view = mount();
  await flush();
  view.unmount();
  await tick(90_000);
  expect(fetchInbox).toHaveBeenCalledTimes(1);
});

test("the first poll waits a random 0-5 s, then polls every 30 s", async () => {
  mount({ random: () => 0.5 }); // 2.5 s
  await flush();
  expect(fetchInbox).not.toHaveBeenCalled();
  await tick(2_499);
  expect(fetchInbox).not.toHaveBeenCalled();
  await tick(1);
  expect(fetchInbox).toHaveBeenCalledTimes(1);
  await tick(29_999);
  expect(fetchInbox).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(fetchInbox).toHaveBeenCalledTimes(2);
});

test("the jitter never exceeds 5 s and returning to the tab still polls immediately", async () => {
  mount({ random: () => 0.999999 });
  await flush();
  await tick(5_000);
  expect(fetchInbox).toHaveBeenCalledTimes(1);
  setHidden(true);
  setHidden(false);
  await flush();
  expect(fetchInbox).toHaveBeenCalledTimes(2);
});
