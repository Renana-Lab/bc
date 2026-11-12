"use strict";
// Protected faucet Lambda: pays a fixed amount ONCE to a participant code (pid) on the allowlist.
//
// Guarantees
//  * Only pids whose SHA-256 digest is in the table can claim; raw pids are never stored or logged.
//  * Exactly-once per pid, also under parallel requests: a conditional DynamoDB update (a lease)
//    lets one request win; the signed transaction is stored BEFORE it is broadcast, so a retry
//    after a crash re-broadcasts the same transaction (same nonce) instead of paying twice.
//  * Rate limit per caller and globally, evaluated BEFORE the pid lookup so guessing codes is throttled too.
//    Caller records are keyed by an HMAC of (IP, time window) with a secret salt: they cannot be reversed
//    to an IP without the salt, cannot be linked across windows, live in a SEPARATE table with a short TTL,
//    and never contain or reference a participant code (the code table never contains an IP).
//  * The faucet key is read from AWS Secrets Manager only, held in memory, never logged.
//  * Two pid modes. allowlist (default): only pre-inserted hashes can claim. prolific: any 24-hex id can claim once;
//    the first claim inserts its hash, and FAUCET_MAX_PAYOUTS caps the number of payments with an atomic counter.
//  * An admin-controlled open/closed switch (DynamoDB item, closed by default) gates /claim. The admin password is
//    only ever compared against a scrypt hash from Secrets Manager and is never logged.
//  * Logs contain only event names, an 8-char pid digest prefix and scrubbed error text.
const crypto = require("crypto");
const { verifyPassword, safeEqual } = require("./adminAuth");
const { Wallet, Transaction, getAddress, isAddress } = require("ethers");

const PID_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9]{8,24}$/; // same rule as src/real_ethereum/wallets/participantId.mjs
const PROLIFIC_PID_PATTERN = /^[a-fA-F0-9]{24}$/; // Prolific participant id
const SAPPHIRE_CHAIN_IDS = new Set([23293, 23295]); // localnet, testnet. Mainnet (23294) is deliberately refused.
const MAX_BODY_BYTES = 2000;
// Sapphire needs a little more than the 21000 of a plain transfer (measured: 22132 used, 21000 reverts).
const TRANSFER_GAS = 60000n;

// IPv6 callers are keyed on their /64 prefix (one subscriber can rotate through the whole /64 at will);
// IPv4-mapped IPv6 addresses count as the IPv4 address.
const normalizeIp = (ip) => {
  const text = String(ip || "unknown").toLowerCase().split("%")[0];
  if (!text.includes(":")) return text;
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = text.includes("::") ? [...front, ...Array(Math.max(8 - front.length - back.length, 0)).fill("0"), ...back] : front;
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return text;
  return `${groups.slice(0, 4).map((group) => group.padStart(4, "0")).join(":")}::/64`;
};

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
  const pidMode = String(env.FAUCET_PID_MODE || "allowlist").toLowerCase();
  if (pidMode !== "allowlist" && pidMode !== "prolific") throw new Error("FAUCET_PID_MODE must be allowlist or prolific");
  let maxPayouts = null;
  if (pidMode === "prolific") {
    // Fail closed: without an explicit cap the faucet must not start in prolific mode.
    if (!/^[1-9][0-9]{0,9}$/.test(String(env.FAUCET_MAX_PAYOUTS ?? ""))) throw new Error("FAUCET_MAX_PAYOUTS must be a positive integer in prolific mode");
    maxPayouts = Number(env.FAUCET_MAX_PAYOUTS);
  }
  return {
    chainId,
    amountWei,
    pidMode,
    maxPayouts,
    requiredStudyId: env.FAUCET_REQUIRED_STUDY_ID || "",
    experimentCode: env.FAUCET_EXPERIMENT_CODE || "",
    adminRateLimit: Number(env.ADMIN_RATE_LIMIT_PER_WINDOW || 5),
    adminGlobalRateLimit: Number(env.ADMIN_GLOBAL_RATE_LIMIT_PER_WINDOW || 300),
    adminSecretTtlMs: Number(env.ADMIN_SECRET_TTL_SECONDS || 60) * 1000,
    rateLimit: Number(env.RATE_LIMIT_PER_WINDOW || 20),
    globalRateLimit: Number(env.GLOBAL_RATE_LIMIT_PER_WINDOW || 600),
    rateWindowSeconds: Number(env.RATE_WINDOW_SECONDS || 600),
    rateTtlGraceSeconds: Number(env.RATE_TTL_GRACE_SECONDS || 60),
    leaseSeconds: Number(env.LEASE_SECONDS || 60),
    confirmTimeoutMs: Number(env.CONFIRM_TIMEOUT_MS || 20000),
    absentChecks: 3,
    absentDelayMs: 700,
  };
};

const createFaucetHandler = ({ store, getPrivateKey, getRateSalt, getAdminSecret, chain, config, now = () => Date.now(), log = console.log }) => {
  if (!SAPPHIRE_CHAIN_IDS.has(config.chainId)) throw new Error("Unsupported chain id");
  const prolific = config.pidMode === "prolific";
  if (prolific && !(Number.isInteger(config.maxPayouts) && config.maxPayouts > 0)) throw new Error("FAUCET_MAX_PAYOUTS must be a positive integer in prolific mode");
  const adminRateLimit = config.adminRateLimit ?? 5;
  const adminGlobalRateLimit = config.adminGlobalRateLimit ?? 300;
  const adminSecretTtlMs = config.adminSecretTtlMs ?? 60_000;
  // One signer per process: signing/nonce selection must not interleave (the stack also sets
  // reserved concurrency 1 so there is a single container).
  let queue = Promise.resolve();
  const exclusive = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const event = (name, fields = {}) => log(JSON.stringify({ event: name, ...fields }));
  // Secret salt (Secrets Manager); a random per-process salt if none is available. Never logged.
  let salt = null;
  const callerKey = async (ip, windowId) => {
    if (!salt) {
      try { salt = (await getRateSalt?.()) || null; } catch { salt = null; }
      if (!salt) salt = crypto.randomBytes(32).toString("hex");
    }
    return crypto.createHmac("sha256", salt).update(`ip:${normalizeIp(ip)}:${windowId}`).digest("hex").slice(0, 32);
  };
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

  // True only if the transaction stays unknown over several checks (RPC nodes can lag).
  const confirmAbsent = async (txHash) => {
    for (let i = 0; i < config.absentChecks; i += 1) {
      if ((await chain.getTransaction(txHash)) || (await chain.getReceipt(txHash))) return false;
      if (config.absentDelayMs > 0 && i < config.absentChecks - 1) await new Promise((resolve) => setTimeout(resolve, config.absentDelayMs));
    }
    return true;
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
            if (/nonce too low/i.test(String(error?.message)) && (await confirmAbsent(previous.txHash))) {
              // Its nonce was taken by another transaction and it stayed absent over several checks
              // (an RPC that lags behind must not make us pay twice): safe to start over.
              await store.release(pidHash);
              previous = null;
            } else if (/nonce too low/i.test(String(error?.message))) {
              throw Object.assign(new Error("previous transaction state unclear"), { code: "PENDING" });
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
          if (ok === false) {
            await store.release(pidHash); // mined but failed (e.g. the target contract reverted): the pid may try again
            throw Object.assign(new Error("transaction reverted"), { code: "REVERTED" });
          }
          throw Object.assign(new Error("transaction not confirmed yet"), { code: "PENDING" });
        }
        // fell through: released, re-reserve below
        const again = await store.reserve(pidHash, address, Math.floor(now() / 1000), Math.floor(now() / 1000) + config.leaseSeconds);
        if (again.outcome !== "reserved") throw Object.assign(new Error("lost reservation"), { code: "PENDING" });
        if (prolific && !(await store.takeSlot(pidHash, config.maxPayouts))) {
          await store.release(pidHash);
          throw Object.assign(new Error("payout cap reached"), { code: "BUDGET" });
        }
      }

      const wallet = await getWallet();
      const [balance, quotedGasPrice, nonce] = await Promise.all([
        chain.getBalance(wallet.address),
        chain.getGasPrice(),
        chain.getNonce(wallet.address),
      ]);
      const gasPrice = (quotedGasPrice * 12n) / 10n; // 20% headroom so a small price rise does not strand the transaction
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
      if (ok === false) {
        await store.release(pidHash); // consumed gas but paid nobody: let the code be used again (rate limits bound abuse)
        throw Object.assign(new Error("transaction reverted"), { code: "REVERTED" });
      }
      if (ok !== true) throw Object.assign(new Error("transaction not confirmed yet"), { code: "PENDING" });
      await store.markPaid(pidHash, { txHash, amountWei: config.amountWei.toString(), paidAt: Math.floor(now() / 1000) });
      return { txHash };
    });

  // Open/closed switch. Missing or unreadable state is closed.
  const readState = async () => {
    try {
      const state = await store.getState();
      if (state?.open === true) return { open: true, updatedAt: state.updatedAt ?? null };
      return { open: false, updatedAt: state?.updatedAt ?? null };
    } catch {
      return { open: false, updatedAt: null };
    }
  };
  const publicState = (state) => ({ open: state.open, updatedAt: state.updatedAt ? new Date(state.updatedAt * 1000).toISOString() : null });

  // Counter scopes for one request: the current window, its TTL and the (salted, /64-normalised) caller key.
  const counters = async (request, callerScope, globalScope) => {
    const nowSeconds = Math.floor(now() / 1000);
    const windowId = Math.floor(nowSeconds / config.rateWindowSeconds);
    // The record is only needed until the end of its window (plus a short grace): short TTL.
    const expiresAt = (windowId + 1) * config.rateWindowSeconds + (config.rateTtlGraceSeconds ?? 60);
    const caller = await callerKey(request.requestContext?.http?.sourceIp, windowId);
    const bump = (by) => Promise.all([
      store.hit(`${callerScope}${caller}`, windowId, expiresAt, by),
      store.hit(globalScope, windowId, expiresAt, by),
    ]);
    // hitCaller / hitGlobal bump one counter each, so a caller can be checked before the global counter is touched.
    const hitCaller = (by) => store.hit(`${callerScope}${caller}`, windowId, expiresAt, by);
    const hitGlobal = (by) => store.hit(globalScope, windowId, expiresAt, by);
    return { bump, hitCaller, hitGlobal };
  };
  // Counts this request against a per-caller and a global counter. Returns true when over the limit.
  const overLimit = async (request, callerScope, globalScope, callerMax, globalMax) => {
    const [callerCount, globalCount] = await (await counters(request, callerScope, globalScope)).bump(1);
    return callerCount > callerMax || globalCount > globalMax;
  };
  const rateLimited = () => json(429, { error: "rate_limited" }, { "retry-after": String(config.rateWindowSeconds) });

  // Admin password hash from Secrets Manager, cached briefly so a changed password takes effect soon.
  let adminCache = { record: null, at: 0 };
  const adminRecord = async () => {
    if (adminCache.record && now() - adminCache.at < adminSecretTtlMs) return adminCache.record; // expires: a changed password takes effect within the TTL
    const record = (await getAdminSecret?.()) || null;
    adminCache = { record, at: now() };
    return record;
  };

  const readBody = (request) => {
    let raw = request.body || "";
    if (request.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
    return raw;
  };

  // GET /status: public, exposes only { open, updatedAt }.
  const status = async (request) => {
    if (await overLimit(request, "st:", "st-global", config.rateLimit, config.globalRateLimit)) return rateLimited();
    return json(200, publicState(await readState()));
  };

  // POST /admin/state { open, password }. Never logs the password or the body; 401 without detail on failure.
  const adminState = async (request) => {
    try {
      const raw = readBody(request);
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { error: "too_large" });
      // Only FAILED verifications count. Each attempt is counted up front (so parallel guesses cannot slip past the
      // limit) and refunded when the password is right: an attacker burning failures from other IPs cannot block the
      // admin's correct password, except by exhausting the modest global failure budget.
      // The caller counter goes first; the global counter is only touched by callers still within their own limit,
      // so a single address hammering the endpoint adds nothing to the global budget beyond its own limit.
      const { hitCaller, hitGlobal } = await counters(request, "admf:", "admf-global");
      const failures = await hitCaller(1);
      if (failures > adminRateLimit) { event("admin_rate_limited"); return rateLimited(); }
      const globalFailures = await hitGlobal(1);
      if (globalFailures > adminGlobalRateLimit) { event("admin_rate_limited"); return rateLimited(); }
      const refund = () => Promise.all([hitCaller(-1), hitGlobal(-1)]);
      let body;
      try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
      let record = null;
      try { record = await adminRecord(); } catch { record = null; }
      const ok = await verifyPassword(body?.password, record);
      if (!ok) { event("admin_denied"); return json(401, { error: "unauthorized" }); }
      await refund().catch(() => {}); // a correct password is not a failure
      if (typeof body.open !== "boolean") return json(400, { error: "bad_request" });
      const updatedAt = Math.floor(now() / 1000);
      await store.setState(body.open, updatedAt);
      event("admin_state_changed", { open: body.open });
      return json(200, publicState({ open: body.open, updatedAt }));
    } catch {
      event("error", { code: "admin" });
      return json(500, { error: "internal" });
    }
  };

  const claimFunds = async (request) => {
    const started = now();
    let pidHash = "";
    try {
      const raw = readBody(request);
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { error: "too_large" });

      // 1. Rate limit first (also throttles pid guessing).
      const nowSeconds = Math.floor(now() / 1000);
      if (await overLimit(request, "ip:", "global", config.rateLimit, config.globalRateLimit)) {
        event("rate_limited");
        return rateLimited();
      }

      // 2. The admin switch. Closed (or unreadable) means no NEW reservation: see step 4b.
      const isOpen = (await readState()).open;

      // 3. Validate input.
      let body;
      try { body = JSON.parse(raw || "{}"); } catch { return json(400, { error: "bad_request" }); }
      const { pid, address, studyId, experimentCode } = body || {};
      const pidOk = typeof pid === "string" && (prolific ? PROLIFIC_PID_PATTERN.test(pid) : PID_PATTERN.test(pid));
      if (!pidOk || typeof address !== "string" || !isAddress(address)) return json(400, { error: "bad_request" });
      if ((studyId !== undefined && typeof studyId !== "string") || (experimentCode !== undefined && typeof experimentCode !== "string")) return json(400, { error: "bad_request" });
      const to = getAddress(address);
      // Prolific ids are hex: fold the case so "ABC.." and "abc.." cannot be paid as two participants.
      pidHash = sha256(prolific ? pid.toLowerCase() : pid);

      // 4. Optional study / experiment checks (prolific mode), fail closed, before anything is reserved.
      if (prolific) {
        if (config.requiredStudyId && !safeEqual(studyId ?? "", config.requiredStudyId)) { event("claim_rejected", { pid: pidHash.slice(0, 8), reason: "study" }); return json(403, { error: "not_eligible" }); }
        if (config.experimentCode && !safeEqual(experimentCode ?? "", config.experimentCode)) { event("claim_rejected", { pid: pidHash.slice(0, 8), reason: "experiment" }); return json(403, { error: "not_eligible" }); }
      }

      // 4b. Closed: nothing is written and no slot is taken. Only a pid that is already paid (same address) is answered,
      // and only a pending reservation that already signed a transaction may resume; anything new is refused.
      if (!isOpen) {
        const existing = await store.get(pidHash);
        if (existing?.status === "paid" && existing.address === to.toLowerCase()) return json(200, { status: "already_paid", txHash: existing.txHash });
        if (!(existing?.status === "pending" && existing.rawTx && existing.address === to.toLowerCase())) {
          event("claim_rejected", { reason: "closed" });
          return json(403, { error: "faucet_closed" });
        }
      }

      // 5. Reserve (exactly-once gate). In prolific mode the first claim of a new id inserts it.
      let reservation = await store.reserve(pidHash, to, nowSeconds, nowSeconds + config.leaseSeconds);
      if (reservation.outcome === "unknown" && prolific) {
        await store.putPid(pidHash, nowSeconds); // a parallel first claim may win this insert: that is fine
        reservation = await store.reserve(pidHash, to, nowSeconds, nowSeconds + config.leaseSeconds);
      }
      if (reservation.outcome === "unknown") { event("claim_rejected", { pid: pidHash.slice(0, 8), reason: "unknown" }); return json(403, { error: "not_eligible" }); }
      if (reservation.outcome === "paid") {
        if (reservation.record.address === to.toLowerCase()) return json(200, { status: "already_paid", txHash: reservation.record.txHash });
        event("claim_rejected", { pid: pidHash.slice(0, 8), reason: "used" });
        return json(403, { error: "not_eligible" });
      }
      if (reservation.outcome === "mismatch") return json(403, { error: "not_eligible" });
      if (reservation.outcome === "busy") return json(409, { error: "in_progress" }, { "retry-after": String(config.leaseSeconds) });
      if (reservation.previous?.address && reservation.previous.address !== to.toLowerCase()) {
        return json(403, { error: "not_eligible" });
      }

      if (!isOpen && !reservation.previous?.rawTx) { // state changed between the check and the reserve: undo, never start a new payment
        await store.release(pidHash);
        event("claim_rejected", { reason: "closed" });
        return json(403, { error: "faucet_closed" });
      }

      // 6. Payout cap (prolific): take one slot atomically before paying; a released reservation gives it back.
      if (prolific && !reservation.previous?.slot) {
        let granted = false;
        try { granted = await store.takeSlot(pidHash, config.maxPayouts); } catch (error) { await store.release(pidHash).catch(() => {}); throw error; }
        if (!granted) {
          await store.release(pidHash);
          event("claim_rejected", { pid: pidHash.slice(0, 8), reason: "budget" });
          return json(403, { error: "budget_exhausted" });
        }
      }

      // 7. Pay.
      const { txHash } = await pay(pidHash, to, reservation.previous);
      event("claim_paid", { pid: pidHash.slice(0, 8), ms: now() - started });
      return json(200, { status: "paid", txHash, amountWei: config.amountWei.toString() });
    } catch (error) {
      const code = error?.code === "FAUCET_EMPTY" ? "faucet_empty" : error?.code === "PENDING" ? "pending" : error?.code === "REVERTED" ? "reverted" : error?.code === "BUDGET" ? "budget" : "internal";
      event("error", { pid: pidHash ? pidHash.slice(0, 8) : undefined, code: scrub(error?.code), message: scrub(error?.message) });
      if (code === "faucet_empty") return json(503, { error: "faucet_empty" });
      if (code === "budget") return json(403, { error: "budget_exhausted" });
      if (code === "reverted") return json(422, { error: "transfer_failed" });
      if (code === "pending") return json(202, { status: "pending" }, { "retry-after": "5" });
      return json(500, { error: "internal" });
    }
  };

  return async (request) => {
    try {
      const method = request.requestContext?.http?.method || "POST";
      const path = String(request.rawPath || request.requestContext?.http?.path || "/claim").replace(/\/+$/, "") || "/claim";
      if (path === "/status") return method === "GET" ? await status(request) : json(405, { error: "method_not_allowed" });
      if (path === "/admin/state") return method === "POST" ? await adminState(request) : json(405, { error: "method_not_allowed" });
      if (path !== "/claim") return json(404, { error: "not_found" });
      if (method !== "POST") return json(405, { error: "method_not_allowed" });
      return await claimFunds(request);
    } catch {
      event("error", { code: "route" });
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
    let secretPromise = null;
    const readSecret = () => {
      if (!secretPromise) {
        secretPromise = secrets.send(new GetSecretValueCommand({ SecretId: process.env.FAUCET_SECRET_ID })).then((result) => {
          const value = result.SecretString || "";
          try { return JSON.parse(value); } catch { return { privateKey: value.trim() }; }
        });
        secretPromise.catch(() => { secretPromise = null; });
      }
      return secretPromise;
    };
    const getPrivateKey = async () => (await readSecret()).privateKey;
    const getRateSalt = async () => (await readSecret()).rateLimitSalt;
    // Admin password hash (scrypt + salt) lives in its own secret; the password itself is never stored.
    // Not cached here: createFaucetHandler caches the record for adminSecretTtlMs (default 60 s), then reads it again.
    const getAdminSecret = async () => {
      if (!process.env.FAUCET_ADMIN_SECRET_ID) return null;
      const result = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.FAUCET_ADMIN_SECRET_ID }));
      return JSON.parse(result.SecretString || "{}");
    };
    cachedHandler = createFaucetHandler({
      store: createDynamoStore({ table: process.env.FAUCET_TABLE, rateTable: process.env.RATE_TABLE }), getPrivateKey, getRateSalt, getAdminSecret, chain, config,
    });
  }
  return cachedHandler(request);
};

module.exports = { createFaucetHandler, createEthersChain, handler, loadConfig, scrub, sha256, PID_PATTERN, PROLIFIC_PID_PATTERN, normalizeIp };
