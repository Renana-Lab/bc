import { chainNowMs } from "./chainClock";

// finalizeAuctionIfNeeded() reverts with "Auction not ended yet" while block.timestamp < endTime.
// The chain clock can run slightly ahead of the latest block, so a participant may try a moment early.
export const MAX_FINALIZE_ATTEMPTS = 3;
export const FINALIZE_RETRY_AFTER_END_MS = 3000;

export const isNotEndedRevert = (err) =>
  /auction not ended|not ended yet/i.test(
    String(err?.message || err?.data?.message || err?.cause?.message || ""),
  );

// Chain-time (ms) at which attempt number `attemptsDone + 1` should run: endTime + 3 s per failed attempt.
export const nextFinalizeAttemptAtMs = (endTimeSec, attemptsDone) =>
  Number(endTimeSec) * 1000 + FINALIZE_RETRY_AFTER_END_MS * Math.max(1, attemptsDone);

// Real-time delay until that chain-time moment (never shorter than one second).
export const finalizeRetryDelayMs = (endTimeSec, attemptsDone, now = chainNowMs()) =>
  Math.max(1000, nextFinalizeAttemptAtMs(endTimeSec, attemptsDone) - now);
