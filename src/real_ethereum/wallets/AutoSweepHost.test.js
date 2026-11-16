import React from "react";
import { act, render } from "@testing-library/react";
import { Wallet } from "ethers";
import Campaign from "../campaign";
import AutoSweepHost from "./AutoSweepHost";
import { emitBalanceEvent } from "./balanceEvents.mjs";
import { observeAuctions } from "../auctionObserver.mjs";
import { WALLET_SCOPE_OVERRIDE_KEY } from "./walletMode.mjs";
import { fetchSweepConfig, postSweep } from "./sweepClient.mjs";

jest.mock("../campaign", () => jest.fn());
jest.mock("./sweepClient.mjs", () => ({
  ...jest.requireActual("./sweepClient.mjs"),
  fetchSweepConfig: jest.fn(), postSweep: jest.fn(), beaconSweep: jest.fn(),
  pidHashFor: () => "ab".repeat(32), // ethers' sha256 needs a real Uint8Array realm (covered in sweepClient.test.js, node env)
}));

const flush = async () => { for (let i = 0; i < 40; i += 1) await act(async () => { await Promise.resolve(); }); };
const SWEEP_TO = `0x${"c".repeat(40)}`;
const PID = "5f1a2b3c4d5e6f7a8b9c0d1e";
const AUCTION = `0x${"a".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;
const signer = new Wallet(`0x${"1".repeat(64)}`); // fixed test key: random generation does not work under jsdom
const chain = { balance: 10n ** 18n, nonce: 0 };
let refundSends;
let sellerSends;
let wallet;
let provider;

const auctionStub = (state) => ({
  methods: {
    getStatus: () => ({ call: async () => state.closed }), cancelled: () => ({ call: async () => false }), manager: () => ({ call: async () => OTHER }),
    getUserAuctionStatus: () => ({ call: async () => [true, "5", false, false, false] }), sellerOwed: () => ({ call: async () => state.sellerOwed || "0" }),
    withdrawRefund: () => ({ send: async () => { refundSends.push(1); chain.balance += 5n; emitBalanceEvent("tx-mined"); } }),
    withdrawSellerPayment: () => ({ send: async () => { sellerSends.push(1); chain.balance += 7n * 10n ** 16n; emitBalanceEvent("tx-mined"); } }),
  },
});

const mount = (props = {}) => render(<AutoSweepHost wallet={wallet} provider={provider} address={signer.address} faucetUrl="https://faucet.example" strictPid={PID} openPid={PID} {...props} />);
const arms = () => postSweep.mock.calls.filter(([args]) => args.path === "/sweep/arm").map(([args]) => args.payload);

beforeEach(() => {
  jest.useFakeTimers();
  process.env.REACT_APP_WALLET_MODE = "local";
  delete process.env.REACT_APP_LOCAL_WALLET_PASSPHRASE;
  window.sessionStorage.clear();
  chain.balance = 10n ** 18n; chain.nonce = 0;
  refundSends = []; sellerSends = [];
  Campaign.mockImplementation(() => auctionStub({ closed: true }));
  fetchSweepConfig.mockResolvedValue({ sweepAddress: SWEEP_TO, chainId: 23295, pidMode: "prolific" });
  postSweep.mockResolvedValue({ status: 200, body: { status: "armed" } });
  wallet = { signTransaction: jest.fn((request) => signer.signTransaction(request)), signMessage: jest.fn((message) => signer.signMessage(message)) };
  provider = {
    request: jest.fn(async ({ method }) => {
      if (method === "eth_getBalance") return `0x${chain.balance.toString(16)}`;
      if (method === "eth_getTransactionCount") return `0x${chain.nonce.toString(16)}`;
      if (method === "eth_gasPrice") return `0x${(100n * 10n ** 9n).toString(16)}`;
      return null;
    }),
  };
});
afterEach(() => { jest.useRealTimers(); delete process.env.REACT_APP_WALLET_MODE; });

test("participants see nothing: the host renders no markup and no wallet wording", async () => {
  const { container } = mount();
  await flush();
  expect(container.innerHTML).toBe("");
});

test("every balance-changing event re-signs once after the debounce; an auction close withdraws and re-signs", async () => {
  mount();
  await flush();
  // No auction list has been seen yet: the first signature waits (bounded to 20 s) so pending refunds are withdrawn first.
  act(() => { jest.advanceTimersByTime(5000); });
  await flush();
  expect(arms()).toHaveLength(0);
  act(() => { jest.advanceTimersByTime(20_000); });
  await flush();
  expect(arms()).toHaveLength(1);
  expect(arms()[0].pidHash).toMatch(/^[0-9a-f]{64}$/);
  expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
  // An auction closes: the refund is withdrawn automatically, the (fake) wallet announces the balance change.
  await act(async () => { observeAuctions([{ address: AUCTION, closed: true, manager: OTHER, highestBidder: OTHER, addresses: [signer.address] }], signer.address); });
  await flush();
  expect(refundSends).toHaveLength(1);
  act(() => { jest.advanceTimersByTime(5000); });
  await flush();
  expect(arms()).toHaveLength(2);
  // A seller payment, then an admin top-up noticed by the poll.
  Campaign.mockImplementation(() => auctionStub({ closed: true, sellerOwed: "5" }));
  chain.nonce += 1;
  emitBalanceEvent("tx-sent");
  act(() => { jest.advanceTimersByTime(5000); });
  await flush();
  expect(arms()).toHaveLength(3);
  chain.balance += 10n ** 17n;
  act(() => { jest.advanceTimersByTime(20_000); });
  await flush();
  act(() => { jest.advanceTimersByTime(5000); });
  await flush();
  expect(arms()).toHaveLength(4);
});

test("auto-withdraw runs once per closed auction, even when the list reports it again and again", async () => {
  mount();
  await flush();
  const list = [{ address: AUCTION, closed: true, manager: OTHER, highestBidder: OTHER, addresses: [signer.address] }];
  for (let i = 0; i < 4; i += 1) await act(async () => { observeAuctions(list, signer.address); });
  await flush();
  expect(refundSends).toHaveLength(1);
});

test("MetaMask mode: no withdraw, no signing, no server calls", async () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  mount();
  await flush();
  await act(async () => { observeAuctions([{ address: AUCTION, closed: true, probe: true }], signer.address); });
  emitBalanceEvent("tx-sent");
  act(() => { jest.advanceTimersByTime(60_000); });
  await flush();
  expect(Campaign).not.toHaveBeenCalled();
  expect(fetchSweepConfig).not.toHaveBeenCalled();
  expect(wallet.signTransaction).not.toHaveBeenCalled();
  expect(postSweep).not.toHaveBeenCalled();
});

test("admin override (admin key slot or admin address): no withdraw, no signing, no server calls", async () => {
  window.sessionStorage.setItem(WALLET_SCOPE_OVERRIDE_KEY, "admin");
  const slot = mount();
  await flush();
  await act(async () => { observeAuctions([{ address: AUCTION, closed: true, probe: true }], signer.address); });
  act(() => { jest.advanceTimersByTime(60_000); });
  await flush();
  slot.unmount();
  window.sessionStorage.clear();
  mount({ isAdmin: true });
  await flush();
  await act(async () => { observeAuctions([{ address: AUCTION, closed: true, probe: true }], signer.address); });
  act(() => { jest.advanceTimersByTime(60_000); });
  await flush();
  expect(Campaign).not.toHaveBeenCalled();
  expect(fetchSweepConfig).not.toHaveBeenCalled();
  expect(postSweep).not.toHaveBeenCalled();
});

test("without a faucet or a participant id there is no auto-return, but refunds are still withdrawn", async () => {
  mount({ faucetUrl: "", strictPid: "", openPid: "" });
  await flush();
  await act(async () => { observeAuctions([{ address: AUCTION, closed: true, probe: true }], signer.address); });
  await flush();
  expect(fetchSweepConfig).not.toHaveBeenCalled();
  expect(refundSends).toHaveLength(1);
});

test("a server for another chain, or an unreachable one, is ignored silently", async () => {
  fetchSweepConfig.mockResolvedValueOnce({ sweepAddress: SWEEP_TO, chainId: 1, pidMode: "prolific" });
  mount();
  await flush();
  act(() => { jest.advanceTimersByTime(10_000); });
  await flush();
  expect(arms()).toHaveLength(0);
});

test("unmounting stops the listeners and timers", async () => {
  const view = mount();
  await flush();
  view.unmount();
  await act(async () => { observeAuctions([{ address: AUCTION, closed: true, probe: true }], signer.address); });
  emitBalanceEvent("tx-sent");
  act(() => { jest.advanceTimersByTime(600_000); });
  await flush();
  expect(refundSends).toHaveLength(0);
  expect(arms()).toHaveLength(0);
});

test("a pending refund is withdrawn BEFORE the first sweep is signed; a refund that cannot be withdrawn blocks the sweep", async () => {
  mount();
  await flush();
  await act(async () => { observeAuctions([{ address: AUCTION, closed: true, manager: OTHER, highestBidder: OTHER, addresses: [signer.address] }], signer.address); });
  await flush();
  act(() => { jest.advanceTimersByTime(5000); });
  await flush();
  expect(refundSends).toHaveLength(1);
  expect(arms()).toHaveLength(1);
  expect(arms()[0].rawTx).toBeTruthy(); // armed after the refund went out, with the refunded balance
});

test("a refund that fails to withdraw (no gas) means a cancel, never a sweep", async () => {
  Campaign.mockImplementation(() => {
    const stub = auctionStub({ closed: true });
    stub.methods.withdrawRefund = () => ({ send: async () => { throw new Error("insufficient funds"); } });
    return stub;
  });
  mount();
  await flush();
  await act(async () => { observeAuctions([{ address: AUCTION, closed: true, manager: OTHER, highestBidder: OTHER, addresses: [signer.address] }], signer.address); });
  await flush();
  act(() => { jest.advanceTimersByTime(5000); });
  await flush();
  expect(arms()).toHaveLength(1);
  expect(arms()[0].cancel).toBe(true);
  expect(arms()[0].rawTx).toBeUndefined();
});
