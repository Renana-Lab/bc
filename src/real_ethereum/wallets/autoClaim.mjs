import { claimFunds, fetchFaucetStatus } from "./faucetClient.mjs";

// Automatic one-shot faucet claim for the invisible wallet. Everything is silent: the participant is never
// told about a failure (the admin watches balances and tops up).
export const AUTO_CLAIM_MIN_WEI = 5n * 10n ** 16n; // 0.05 TEST

const inflight = new Map(); // address -> promise. At most one attempt per address per page load, ever.

// Resolves "claimed" | "skipped" | "failed". Never rejects. Concurrent / repeated calls for one address share the
// first attempt (React Strict Mode, re-renders), so there can be no loop.
export const autoClaim = ({ faucetUrl, address, strictPid, openPid, studyId, experimentCode, readBalance, fetchImpl, sleep, maxWaitMs = 20000 }) => {
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
      await claimFunds({ faucetUrl, pid, address, studyId, experimentCode, fetchImpl, ...(sleep ? { sleep } : {}) });
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
