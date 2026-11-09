"use strict";
// Protected faucet Lambda: pays a fixed amount ONCE to a participant code (pid) on the allowlist.
//
// Guarantees
//  * Only pids whose SHA-256 digest is in the table can claim; raw pids are never stored or logged.
//  * Exactly-once per pid, also under parallel requests: a conditional DynamoDB update (a lease)
//    lets one request win; the signed transaction is stored BEFORE it is broadcast, so a retry
//    after a crash re-broadcasts the same transaction (same nonce) instead of paying twice.
//  * Rate limit per caller (hashed IP) and globally, evaluated BEFORE the pid lookup so guessing
//    codes is throttled too.
//  * The faucet key is read from AWS Secrets Manager only, held in memory, never logged.
//  * Logs contain only event names, an 8-char pid digest prefix and scrubbed error text.
const crypto = require("crypto");
const { Wallet, Transaction, getAddress, isAddress } = require("ethers");

const PID_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9]{8,24}$/; // same rule as src/real_ethereum/wallets/participantId.mjs
const SAPPHIRE_CHAIN_IDS = new Set([23293, 23295]); // localnet, testnet. Mainnet (23294) is deliberately refused.
const MAX_BODY_BYTES = 2000;
// Sapphire needs a little more than the 21000 of a plain transfer (measured: 22132 used, 21000 reverts).
const TRANSFER_GAS = 60000n;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const json = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  body: JSON.stringify(body),
});

// Removes anything that could be key material or raw transactions from text before it is logged.
const scrub = (value) =>
  String(value ?? "")
    .replace(/0x[0-9a-fA-F]{40,}/g, "[hex]")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[hex]")
    .slice(0, 200);

const loadConfig = (env = process.env) => {
  const chainId = Number(env.CHAIN_ID || 23295);
  if (!SAPPHIRE_CHAIN_IDS.has(chainId)) throw new Error("CHAIN_ID must be a Sapphire testnet or localnet id");
  const amountWei = BigInt(env.FAUCET_AMOUNT_WEI || "0");
  if (amountWei <= 0n) throw new Error("FAUCET_AMOUNT_WEI must be set to a positive amount");
  return {
    chainId,
    amountWei,
    rateLimit: Number(env.RATE_LIMIT_PER_WINDOW || 20),
    globalRateLimit: Number(env.GLOBAL_RATE_LIMIT_PER_WINDOW || 600),
    rateWindowSeconds: Number(env.RATE_WINDOW_SECONDS || 600),
    leaseSeconds: Number(env.LEASE_SECONDS || 60),
    confirmTimeoutMs: Number(env.CONFIRM_TIMEOUT_MS || 20000),
  };
};

const createFaucetHandler = ({ store, getPrivateKey, chain, config, now = () => Date.now(), log = console.log }) => {
  if (!SAPPHIRE_CHAIN_IDS.has(config.chainId)) throw new Error("Unsupported chain id");
  // One signer per process: signing/nonce selection must not interleave (the stack also sets
  // reserved concurrency 1 so there is a single container).
  let queue = Promise.resolve();
  const exclusive = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const event = (name, fields = {}) => log(JSON.stringify({ event: name, ...fields }));
  let cachedWallet = null;
  const getWallet = async () => {
    if (!cachedWallet) {
      let key;
      try {
        key = await getPrivateKey();
        cachedWallet = new Wallet(key);
      } catch {
        // Never include the underlying error: it could echo the secret value.
        throw Object.assign(new Error("faucet key unavailable"), { code: "KEY_UNAVAILABLE" });
      }
    }
    return cachedWallet;
  };

  const confirm = async (txHash) => {
    const deadline = now() + config.confirmTimeoutMs;
    for (;;) {
      const receipt = await chain.getReceipt(txHash);
      if (receipt) return receipt.status === 1;
      if (now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  // Pays (or finishes paying) for a reserved pid. Returns { txHash } or throws.
  const pay = (pidHash, address, previous) =>
    exclusive(async () => {
      if (previous?.rawTx) {
        // A previous attempt signed (and maybe broadcast) a transaction: never sign a second one
        // while the first could still be mined.
        const known = await chain.getTransaction(previous.txHash);
        if (!known) {
          try {
            await chain.sendRaw(previous.rawTx);
          } catch (error) {
            if (/nonce too low/i.test(String(error?.message)) && !(await chain.getTransaction(previous.txHash))) {
              // Its nonce was taken by another transaction and it was never mined: safe to start over.
              await store.release(pidHash);
              previous = null;
            } else if (!/already known|known transaction|already imported/i.test(String(error?.message))) {
              throw error;
            }
          }
        }
        if (previous) {
          const ok = await confirm(previous.txHash);
          if (ok === true) {
            await store.markPaid(pidHash, { txHash: previous.txHash, amountWei: config.amountWei.toString(), paidAt: Math.floor(now() / 1000) });
            return { txHash: previous.txHash };
          }
          throw Object.assign(new Error("transaction not confirmed yet"), { code: "PENDING" });
        }
        // fell through: released, re-reserve below
        const again = await store.reserve(pidHash, address, Math.floor(now() / 1000), Math.floor(now() / 1000) + config.leaseSeconds);
        if (again.outcome !== "reserved") throw Object.assign(new Error("lost reservation"), { code: "PENDING" });
      }

      const wallet = await getWallet();
      const [balance, gasPrice, nonce] = await Promise.all([
        chain.getBalance(wallet.address),
        chain.getGasPrice(),
        chain.getNonce(wallet.address),
      ]);
      if (balance < config.amountWei + gasPrice * TRANSFER_GAS) {
        await store.release(pidHash); // nothing was broadcast
        throw Object.assign(new Error("faucet balance too low"), { code: "FAUCET_EMPTY" });
      }
      const rawTx = await wallet.signTransaction({
        type: 0, chainId: config.chainId, to: address, value: config.amountWei, nonce, gasPrice, gasLimit: TRANSFER_GAS,
      });
      const txHash = Transaction.from(rawTx).hash;
      await store.savePending(pidHash, { rawTx, txHash }); // persisted before broadcasting
      await chain.sendRaw(rawTx);
      const ok = await confirm(txHash);
      if (ok !== true) throw Object.assign(new Error(ok === false ? "transaction reverted" : "transaction not confirmed yet"), { code: ok === false ? "REVERTED" : "PENDING" });
      await store.markPaid(pidHash, { txHash, amountWei: config.amountWei.toString(), paidAt: Math.floor(now() / 1000) });
      return { txHash };
    });

  return async (request) => {
    const started = now();
    let pidHash = "";
    try {
      if ((request.requestContext?.http?.method || "POST") !== "POST") return json(405, { error: "method_not_allowed" });
      let raw = request.body || "";
      if (request.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { error: "too_large" });

      // 1. Rate limit first (also throttles pid guessing).
      const nowSeconds = Math.floor(now() / 1000);
      const windowId = Math.floor(nowSeconds / config.rateWindowSeconds);
      const expiresAt = (windowId + 2) * config.rateWindowSeconds;
      const caller = sha256(`ip:${request.requestContext?.http?.sourceIp || "unknown"}`).slice(0, 32);
      const [callerCount, globalCount] = await Promise.all([
        store.hit(`ip:${caller}`, windowId, expiresAt),
        store.hit("global", windowId, expiresAt),
      ]);
      if (callerCount > config.rateLimit || globalCount > config.globalRateLimit) {
        event("rate_limited");
        return json(429, { error: "rate_limited" }, { "retry-after": String(config.rateWindowSeconds) });
      }

      // 2. Validate input.
      let body;
      try { body = JSON.parse(raw || "{}"); } catch { return json(400, { error: "bad_request" }); }
      const { pid, address } = body || {};
      if (typeof pid !== "string" || !PID_PATTERN.test(pid) || typeof address !== "string" || !isAddress(address)) {
        return json(400, { error: "bad_request" });
      }
      const to = getAddress(address);
      pidHash = sha256(pid);

      // 3. Reserve (exactly-once gate).
      const reservation = await store.reserve(pidHash, to, nowSeconds, nowSeconds + config.leaseSeconds);
      if (reservation.outcome === "unknown") { event("claim_rejected", { pid: pidHash.slice(0, 8), reason: "unknown" }); return json(403, { error: "not_eligible" }); }
      if (reservation.outcome === "paid") {
        if (reservation.record.address === to.toLowerCase()) return json(200, { status: "already_paid", txHash: reservation.record.txHash });
        event("claim_rejected", { pid: pidHash.slice(0, 8), reason: "used" });
        return json(403, { error: "not_eligible" });
      }
      if (reservation.outcome === "busy") return json(409, { error: "in_progress" }, { "retry-after": String(config.leaseSeconds) });
      if (reservation.previous?.address && reservation.previous.address !== to.toLowerCase()) {
        return json(403, { error: "not_eligible" });
      }

      // 4. Pay.
      const { txHash } = await pay(pidHash, to, reservation.previous);
      event("claim_paid", { pid: pidHash.slice(0, 8), ms: now() - started });
      return json(200, { status: "paid", txHash, amountWei: config.amountWei.toString() });
    } catch (error) {
      const code = error?.code === "FAUCET_EMPTY" ? "faucet_empty" : error?.code === "PENDING" ? "pending" : "internal";
      event("error", { pid: pidHash ? pidHash.slice(0, 8) : undefined, code: scrub(error?.code), message: scrub(error?.message) });
      if (code === "faucet_empty") return json(503, { error: "faucet_empty" });
      if (code === "pending") return json(202, { status: "pending" }, { "retry-after": "5" });
      return json(500, { error: "internal" });
    }
  };
};

const createEthersChain = (provider) => ({
  getBalance: (address) => provider.getBalance(address),
  getNonce: (address) => provider.getTransactionCount(address, "pending"),
  getGasPrice: async () => (await provider.getFeeData()).gasPrice,
  sendRaw: (raw) => provider.broadcastTransaction(raw),
  getReceipt: (hash) => provider.getTransactionReceipt(hash),
  getTransaction: (hash) => provider.getTransaction(hash),
});

// ---- Lambda entry point (real AWS clients, created lazily so tests never load the SDK) ----
let cachedHandler = null;
const handler = async (request) => {
  if (!cachedHandler) {
    const { JsonRpcProvider } = require("ethers");
    const config = loadConfig();
    const provider = new JsonRpcProvider(process.env.RPC_URL, config.chainId, { staticNetwork: true, batchMaxCount: 1 });
    const chain = createEthersChain(provider);
    const { createDynamoStore } = require("./store");
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secrets = new SecretsManagerClient({});
    const getPrivateKey = async () => {
      const value = (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.FAUCET_SECRET_ID }))).SecretString || "";
      try { return JSON.parse(value).privateKey; } catch { return value.trim(); }
    };
    cachedHandler = createFaucetHandler({ store: createDynamoStore({ table: process.env.FAUCET_TABLE }), getPrivateKey, chain, config });
  }
  return cachedHandler(request);
};

module.exports = { createFaucetHandler, createEthersChain, handler, loadConfig, scrub, sha256, PID_PATTERN };
