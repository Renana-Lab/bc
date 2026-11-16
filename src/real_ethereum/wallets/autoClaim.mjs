import { claimFunds, fetchFaucetStatus } from "./faucetClient.mjs";

// Automatic one-shot faucet claim for the invisible wallet. Everything is silent: the participant is never
// told about a failure (the admin watches balances and tops up).
export const AUTO_CLAIM_MIN_WEI = 5n * 10n ** 16n; // 0.05 TEST

const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 15000;
const RETRYABLE_CODES = new Set(["rate_limited", "network", "busy"]);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const inflight = new Map(); // address -> promise. At most one attempt per address per page load, ever.

// Resolves "claimed" | "skipped" | "failed". Never rejects. Concurrent / repeated calls for one address share the
// first attempt (React Strict Mode, re-renders), so there can be no loop.
export const autoClaim = ({ faucetUrl, address, strictPid, openPid, studyId, experimentCode, readBalance, fetchImpl, sleep, maxWaitMs = 40000, random = Math.random }) => {
  if (!faucetUrl || !address) return Promise.resolve("skipped");
  const key = String(address).toLowerCase();
  if (inflight.has(key)) return inflight.get(key);
  const attempt = (async () => {
    try {
      if (!strictPid && !openPid) return "skipped";
      let balance = null;
      try { balance = BigInt(await readBalance()); } catch { balance = null; } // unknown balance: let the faucet decide
      if (balance !== null && balance >= AUTO_CLAIM_MIN_WEI) return "skipped";
      const status = await fetchFaucetStatus({ faucetUrl, fetchImpl });
      if (status.open === false) return "skipped";
      // Open mode accepts any printable id; otherwise only the strict formats are ever sent.
      const pid = status.pidMode === "open" ? openPid || strictPid : strictPid;
      if (!pid) return "skipped";
      // "already_paid" resolves like "paid": nothing to tell the participant. Faucet errors reject and are swallowed below.
      const claim = () => claimFunds({ faucetUrl, pid, address, studyId, experimentCode, fetchImpl, ...(sleep ? { sleep } : {}) });
      try {
        await claim();
      } catch (error) {
        // The faucet has a per-window rate limit that a whole lab session can hit at once: one jittered retry
        // (still within this single attempt per page load, never a loop). Other refusals are final.
        if (!RETRYABLE_CODES.has(error?.code)) throw error;
        await (sleep || defaultSleep)(RETRY_MIN_MS + Math.floor(random() * (RETRY_MAX_MS - RETRY_MIN_MS)));
        await claim();
      }
      return "claimed";
    } catch {
      return "failed";
    }
  })();
  // The session continues after maxWaitMs even if the claim is still retrying in the background.
  let timer;
  const bounded = Promise.race([
    attempt.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve("failed"), maxWaitMs); }),
  ]);
  inflight.set(key, bounded);
  return bounded;
};

export const __resetAutoClaimForTests = () => inflight.clear();
