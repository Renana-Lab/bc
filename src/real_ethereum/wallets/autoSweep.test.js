/** @jest-environment node */
import { Transaction, Wallet, verifyMessage } from "ethers";
import { SWEEP_GAS_LIMIT, computeSweepValue, createSweepController, sweepFee, sweepMessage } from "./autoSweep.mjs";
import { emitBalanceEvent } from "./balanceEvents.mjs";
import { createLocalWallet, createMemoryStorage } from "./localWallet.mjs";

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const GAS_PRICE = 100n * 10n ** 9n;
const SWEEP_TO = Wallet.createRandom().address;
const PID_HASH = "ab".repeat(32);
const ADDRESS = Wallet.createRandom().address;

const fakeWin = new EventTarget();
const fakeDoc = new EventTarget();

// A fake chain + faucet around the controller.
const setup = (overrides = {}) => {
  const chain = { balance: 10n ** 18n, nonce: 0 };
  const posts = [];
  const signer = Wallet.createRandom();
  const controller = createSweepController({
    address: signer.address, sweepAddress: SWEEP_TO, chainId: 23295, pidHash: PID_HASH,
    readBalance: async () => chain.balance, readNonce: async () => chain.nonce, readGasPrice: async () => GAS_PRICE,
    signTransfer: (request) => signer.signTransaction(request), signMessage: (message) => signer.signMessage(message),
    post: async (path, payload) => { posts.push({ path, payload }); return { status: 200, body: { status: "armed" } }; },
    isVisible: () => true, win: fakeWin, doc: fakeDoc, ...overrides,
  });
  const arms = () => posts.filter((p) => p.path === "/sweep/arm");
  return { chain, posts, arms, controller, signer };
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("the signed value is balance minus 1.2 x gasLimit x gasPrice, a plain transfer to the sweep address on the configured chain", async () => {
  const t = setup();
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(1);
  const tx = Transaction.from(t.arms()[0].payload.rawTx);
  expect(tx.to).toBe(SWEEP_TO);
  expect(tx.data).toBe("0x");
  expect(tx.chainId).toBe(23295n);
  expect(tx.nonce).toBe(0);
  expect(tx.gasLimit).toBe(SWEEP_GAS_LIMIT);
  expect(tx.value).toBe(t.chain.balance - (SWEEP_GAS_LIMIT * GAS_PRICE * 12n) / 10n);
  expect(tx.value).toBe(computeSweepValue({ balance: t.chain.balance, gasPrice: GAS_PRICE }));
  expect(sweepFee(GAS_PRICE)).toBe((SWEEP_GAS_LIMIT * GAS_PRICE * 12n) / 10n);
  expect(t.arms()[0].payload).toMatchObject({ pidHash: PID_HASH, address: t.signer.address });
  t.controller.dispose();
});

test("a burst of events is debounced into ONE signature (about 5 seconds after the last event)", async () => {
  const t = setup();
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(1);
  t.chain.balance -= 10n ** 17n; t.chain.nonce += 1;
  for (let i = 0; i < 6; i += 1) { emitBalanceEvent("tx-sent"); jest.advanceTimersByTime(1000); }
  expect(t.arms()).toHaveLength(1);
  jest.advanceTimersByTime(3000); // 4 s since the last event
  await flush();
  expect(t.arms()).toHaveLength(1);
  jest.advanceTimersByTime(1000); // 5 s
  await flush();
  expect(t.arms()).toHaveLength(2);
  t.controller.dispose();
});

test.each([
  ["a bid", "tx-sent"], ["creating an auction", "tx-sent"], ["a finalize", "tx-mined"], ["an auction close followed by a refund withdraw", "tx-mined"],
  ["a seller payment withdraw", "tx-mined"],
])("re-signs after %s changed the balance", async (_name, reason) => {
  const t = setup();
  jest.advanceTimersByTime(5000);
  await flush();
  const before = Transaction.from(t.arms()[0].payload.rawTx).value;
  t.chain.balance += 3n * 10n ** 17n; // e.g. a refund or the seller payment arrived
  t.chain.nonce += 1;
  emitBalanceEvent(reason);
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(2);
  expect(Transaction.from(t.arms()[1].payload.rawTx).value).toBe(before + 3n * 10n ** 17n);
  expect(Transaction.from(t.arms()[1].payload.rawTx).nonce).toBe(1);
  t.controller.dispose();
});

test("a top-up or faucet claim is noticed by the balance poll even without any local event", async () => {
  const t = setup({ pollMs: 20_000 });
  jest.advanceTimersByTime(5000);
  await flush();
  t.chain.balance += 5n * 10n ** 17n; // admin top-up: no transaction of ours
  jest.advanceTimersByTime(20_000);
  await flush();
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(2);
  expect(Transaction.from(t.arms()[1].payload.rawTx).value > Transaction.from(t.arms()[0].payload.rawTx).value).toBe(true);
  // An unchanged balance causes nothing.
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(t.arms()).toHaveLength(2);
  t.controller.dispose();
});

test("a remainder <= 0 sends a cancel instead of a transfer, once", async () => {
  const t = setup();
  t.chain.balance = sweepFee(GAS_PRICE); // exactly the reserve: nothing worth returning
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(1);
  expect(t.arms()[0].payload).toMatchObject({ pidHash: PID_HASH, address: t.signer.address, cancel: true });
  expect(t.arms()[0].payload.rawTx).toBeUndefined();
  const { signedAt, sig } = t.arms()[0].payload;
  expect(verifyMessage(sweepMessage("cancel", t.signer.address, PID_HASH, signedAt), sig)).toBe(t.signer.address);
  t.chain.balance = 0n;
  emitBalanceEvent("tx-mined");
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(1);
  // Funds arrive again: arm.
  t.chain.balance = 10n ** 18n;
  emitBalanceEvent("tx-mined");
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(2);
  expect(t.arms()[1].payload.rawTx).toBeTruthy();
  t.controller.dispose();
});

test("heartbeat every 2 minutes while visible, none while hidden; a stale answer triggers a fresh signature", async () => {
  let visible = true;
  const answers = { status: "armed" };
  const posts = [];
  const t = setup({
    isVisible: () => visible,
    post: async (path, payload) => { posts.push({ path, payload }); return { status: 200, body: { status: path === "/sweep/heartbeat" ? answers.status : "armed" } }; },
  });
  jest.advanceTimersByTime(5000);
  await flush();
  const heartbeats = () => posts.filter((p) => p.path === "/sweep/heartbeat");
  jest.advanceTimersByTime(120_000);
  await flush();
  expect(heartbeats()).toHaveLength(1);
  const beat = heartbeats()[0].payload;
  expect(beat).toMatchObject({ pidHash: PID_HASH, address: t.signer.address });
  expect(verifyMessage(sweepMessage("heartbeat", t.signer.address, PID_HASH, beat.ts), beat.sig)).toBe(t.signer.address);
  visible = false;
  jest.advanceTimersByTime(120_000);
  await flush();
  expect(heartbeats()).toHaveLength(1);
  visible = true;
  answers.status = "stale";
  const armsBefore = posts.filter((p) => p.path === "/sweep/arm").length;
  jest.advanceTimersByTime(120_000);
  await flush();
  expect(posts.filter((p) => p.path === "/sweep/arm").length).toBe(armsBefore + 1);
  t.controller.dispose();
});

test("pagehide sends the last signature as a best-effort beacon; failures are silent", async () => {
  const beacon = jest.fn(() => true);
  const t = setup({ beacon });
  jest.advanceTimersByTime(5000);
  await flush();
  fakeWin.dispatchEvent(new Event("pagehide"));
  expect(beacon).toHaveBeenCalledWith("/sweep/arm", expect.objectContaining({ pidHash: PID_HASH, rawTx: expect.stringMatching(/^0x/) }));
  t.controller.dispose();
  const failing = setup({ post: async () => { throw new Error("offline"); }, readGasPrice: async () => { throw new Error("rpc"); } });
  jest.advanceTimersByTime(5000);
  await expect(failing.controller.idle()).resolves.toBeUndefined();
  failing.controller.dispose();
});

test("every 10 minutes an armed transfer is signed again, so a gas price change cannot leave a stale one", async () => {
  let gasPrice = GAS_PRICE;
  const t = setup({ readGasPrice: async () => gasPrice, heartbeatMs: 10 ** 9, pollMs: 10 ** 9 });
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(1);
  gasPrice = GAS_PRICE * 2n; // no balance change, no event
  jest.advanceTimersByTime(600_000);
  await flush();
  expect(t.arms()).toHaveLength(2);
  expect(Transaction.from(t.arms()[1].payload.rawTx).gasPrice).toBe(GAS_PRICE * 2n);
  expect(Transaction.from(t.arms()[1].payload.rawTx).value).toBe(t.chain.balance - sweepFee(GAS_PRICE * 2n));
  t.controller.dispose();
});

test("the periodic re-sign never creates a transfer when none is armed (remainder <= 0)", async () => {
  const t = setup({ heartbeatMs: 10 ** 9, pollMs: 10 ** 9 });
  t.chain.balance = 0n;
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(1); // the cancel
  jest.advanceTimersByTime(1_200_000);
  await flush();
  expect(t.arms()).toHaveLength(1);
  t.controller.dispose();
});

test("a pending refund is withdrawn before signing; while one is stuck a cancel is sent instead of a sweep", async () => {
  let safe = false;
  const order = [];
  const t = setup({ beforeSign: async () => { order.push("beforeSign"); return safe; } });
  jest.advanceTimersByTime(5000);
  await flush();
  expect(order).toEqual(["beforeSign"]);
  expect(t.arms()).toHaveLength(1);
  expect(t.arms()[0].payload.cancel).toBe(true);
  safe = true;
  t.chain.balance += 10n ** 17n;
  emitBalanceEvent("tx-mined");
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(2);
  expect(t.arms()[1].payload.rawTx).toBeTruthy();
  t.controller.dispose();
});

test("held back by a failed withdrawal: the 10-minute timer retries beforeSign and arms once it succeeds", async () => {
  let safe = false;
  const calls = [];
  const t = setup({ beforeSign: async () => { calls.push(safe); return safe; }, heartbeatMs: 10 ** 9, pollMs: 10 ** 9 });
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms().map((a) => Boolean(a.payload.cancel))).toEqual([true]);
  // Still blocked after 10 minutes: asked again, but no new message (the cancel stays).
  jest.advanceTimersByTime(600_000);
  await flush();
  expect(calls).toEqual([false, false]);
  expect(t.arms()).toHaveLength(1);
  // The withdrawal works now: the next 10-minute tick arms the sweep.
  safe = true;
  jest.advanceTimersByTime(600_000);
  await flush();
  expect(t.arms()).toHaveLength(2);
  expect(t.arms()[1].payload.rawTx).toBeTruthy();
  // And from then on it is an ordinary armed transfer that is refreshed.
  jest.advanceTimersByTime(600_000);
  await flush();
  expect(t.arms()).toHaveLength(3);
  t.controller.dispose();
});

test("returning to the tab retries a held-back sweep at once", async () => {
  let safe = false;
  const t = setup({ beforeSign: async () => safe, heartbeatMs: 10 ** 9, pollMs: 10 ** 9 });
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(1);
  safe = true;
  fakeDoc.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(t.arms()).toHaveLength(2);
  expect(t.arms()[1].payload.rawTx).toBeTruthy();
  t.controller.dispose();
});

test("a beforeSign that throws is treated as unsafe (cancel), never as permission to sweep", async () => {
  const t = setup({ beforeSign: async () => { throw new Error("rpc down"); } });
  jest.advanceTimersByTime(5000);
  await flush();
  expect(t.arms()).toHaveLength(1);
  expect(t.arms()[0].payload.cancel).toBe(true);
  t.controller.dispose();
});

test("signature timestamps and signedAt come from the injected (server-offset) clock", async () => {
  const t = setup({ now: () => Date.now() + 45 * 60_000 }); // the server's clock is 45 minutes ahead of the participant's
  jest.advanceTimersByTime(5000);
  await flush();
  expect(Math.abs(t.arms()[0].payload.signedAt - (Date.now() + 45 * 60_000))).toBeLessThan(10_000);
  t.controller.dispose();
});

test("disposing stops everything", async () => {
  const t = setup();
  t.controller.dispose();
  emitBalanceEvent("tx-sent");
  jest.advanceTimersByTime(600_000);
  await flush();
  expect(t.posts).toHaveLength(0);
});

describe("local wallet support", () => {
  test("signTransaction pre-signs a plain transfer (not broadcast) and refuses calldata or a locked wallet", async () => {
    const wallet = createLocalWallet({ storage: createMemoryStorage(), scryptN: 2 ** 4 });
    await expect(wallet.signTransaction({ to: SWEEP_TO, value: 1n })).rejects.toThrow(/Unlock/);
    const address = await wallet.create("a long passphrase!");
    const raw = await wallet.signTransaction({ type: 0, chainId: 23295, to: SWEEP_TO, value: 5n, nonce: 2, gasPrice: GAS_PRICE, gasLimit: SWEEP_GAS_LIMIT });
    const tx = Transaction.from(raw);
    expect(tx.from).toBe(address);
    expect(tx.to).toBe(SWEEP_TO);
    expect(tx.value).toBe(5n);
    await expect(wallet.signTransaction({ type: 0, chainId: 23295, to: SWEEP_TO, value: 5n, data: "0x1234", nonce: 2, gasPrice: GAS_PRICE, gasLimit: SWEEP_GAS_LIMIT })).rejects.toThrow(/plain transfers/);
  });
});
