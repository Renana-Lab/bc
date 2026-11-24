// Test doubles for the seller job: an in-memory chain with a mempool, receipts and nonces, plus config helpers.
import { createRequire } from "node:module";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";

const require = createRequire(import.meta.url);
const { createMemorySellerStore } = require("../../infrastructure/faucet/sellerStore.js");

export const NOW = 1_700_000_000_000;
export const PAYLOAD = "TOP-SECRET-PAYLOAD-7f3a91c2-do-not-leak";
export const KEYS = { "bot-1": Wallet.createRandom().privateKey, "bot-2": Wallet.createRandom().privateKey, "bot-3": Wallet.createRandom().privateKey };
export const ADDRESS = Object.fromEntries(Object.entries(KEYS).map(([id, key]) => [id, new Wallet(key).address]));

export const createFakeChain = () => {
  const state = {
    mined: new Map(), mempool: new Map(), balances: new Map(), nonces: new Map(), auctions: new Map(), signed: new Map(),
    plaintext: false, autoMine: true, sendFailure: null, created: [], finalizeTxs: 0, counter: 0, rpcFailure: false, chainNow: () => NOW,
  };
  const nonceOf = (address) => state.nonces.get(address.toLowerCase()) || 0;
  const mine = (raw) => {
    const tx = state.signed.get(raw);
    state.mempool.delete(tx.txHash);
    state.nonces.set(tx.from.toLowerCase(), tx.nonce + 1);
    let receipt = { status: 1, logs: [] };
    if (tx.kind === "create") {
      const auction = `0x${(1000 + state.created.length).toString(16).padStart(40, "0")}`;
      const endTime = Math.floor(state.chainNow() / 1000) + tx.duration * 60;
      state.auctions.set(auction, { closed: false, endTime });
      state.created.push({ ...tx, auction });
      receipt = { status: 1, logs: [], created: { auction, endTime } };
    } else {
      state.auctions.get(tx.auction).closed = true;
      state.finalizeTxs += 1;
    }
    state.mined.set(tx.txHash, receipt);
  };
  const chain = {
    state,
    addressOf: (key) => new Wallet(key).address,
    getBalance: async (address) => { if (state.rpcFailure) throw new Error("ECONNRESET"); return state.balances.get(address.toLowerCase()) ?? 5n * 10n ** 18n; },
    getNonce: async (address, tag = "pending") => nonceOf(address) + (tag === "pending" ? [...state.mempool.values()].filter((tx) => tx.from.toLowerCase() === address.toLowerCase()).length : 0),
    getGasPrice: async () => 10n ** 11n,
    getReceipt: async (hash) => state.mined.get(hash) || null,
    getTransaction: async (hash) => state.mempool.get(hash) || (state.mined.has(hash) ? { hash } : null),
    sendRaw: async (raw) => {
      if (state.sendFailure) { const { when, error } = state.sendFailure; state.sendFailure = null; if (when === "before") throw new Error(error); state.pendingError = error; }
      const tx = state.signed.get(raw);
      state.mempool.set(tx.txHash, tx);
      if (state.autoMine) mine(raw);
      if (state.pendingError) { const error = state.pendingError; state.pendingError = null; throw new Error(error); }
    },
    mineAll: () => { for (const tx of [...state.mempool.values()]) mine(tx.raw); },
    async signCreate(request) {
      state.counter += 1;
      const txHash = keccak256(toUtf8Bytes(`create-${state.counter}`));
      const raw = `raw-${state.counter}`;
      state.signed.set(raw, { raw, txHash, kind: "create", from: new Wallet(request.key).address, nonce: request.nonce, duration: request.duration, minimum: request.minimum, payload: request.dataSell, description: request.dataDesc });
      return { rawTx: raw, txHash, enveloped: !state.plaintext };
    },
    async signFinalize(request) {
      state.counter += 1;
      const txHash = keccak256(toUtf8Bytes(`finalize-${state.counter}`));
      const raw = `raw-${state.counter}`;
      state.signed.set(raw, { raw, txHash, kind: "finalize", from: new Wallet(request.key).address, nonce: request.nonce, auction: request.auction });
      return { rawTx: raw, txHash };
    },
    parseCreated: (receipt) => receipt.created || null,
    getAuction: async (address) => ({ closed: state.auctions.get(address)?.closed === true }),
  };
  return chain;
};

export const makeItem = (over = {}) => ({ slot: 1, description: "public description", payload: PAYLOAD, minimumBid: 5, durationMinutes: 2, quantity: 3, seqBase: 0, ...over });
export const makeBot = (over = {}) => ({ id: "bot-1", running: true, maxConcurrentOpen: 1, spacingSeconds: 60, minNativeBalance: 0.1, items: [makeItem()], ...over });
export const makeConfig = (over = {}) => ({
  enabled: true, presenceMode: "sweep", minActiveParticipants: 1, activeWindowMinutes: 5, idleGraceMinutes: 5,
  allowBuyerBotsOnSellerAuctions: false, nextSlot: 2, bots: [makeBot()], ...over,
});

// A job environment: store, chain, clock, captured logs, and run().
export const createEnv = ({ config = makeConfig(), participants = 2 } = {}) => {
  const { runSellerJob } = require("../../infrastructure/faucet/sellerJob.js");
  const store = createMemorySellerStore();
  const chain = createFakeChain();
  const clock = { ms: NOW };
  chain.state.chainNow = () => clock.ms;
  const logs = [];
  const secretReads = { count: 0 };
  store.state.config = structuredClone(config);
  store.state.version = 1;
  const seen = (n) => { store.state.sweepSeen.clear(); for (let i = 0; i < n; i += 1) store.state.sweepSeen.set(`0x${(i + 1).toString(16).padStart(40, "0")}`, Math.floor(clock.ms / 1000) - 30); };
  seen(participants);
  const env = {
    store, chain, clock, logs, secretReads, seen,
    events: () => logs.map((line) => JSON.parse(line)),
    run: (extra = {}) => runSellerJob({
      store, chain, now: () => clock.ms, log: (line) => logs.push(line),
      getSecret: async () => { secretReads.count += 1; return { bots: Object.entries(KEYS).map(([id, privateKey]) => ({ id, privateKey })) }; },
      settings: { sleep: async () => { clock.ms += 1000; }, ...extra.settings }, holder: extra.holder,
    }),
    advance: (seconds) => { clock.ms += seconds * 1000; },
    records: () => [...store.state.records.values()],
    setConfig: (next) => { store.state.config = structuredClone(next); store.state.version += 1; },
  };
  return env;
};
