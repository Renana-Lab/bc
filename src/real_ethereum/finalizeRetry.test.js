import { finalizeRetryDelayMs, isNotEndedRevert, nextFinalizeAttemptAtMs, MAX_FINALIZE_ATTEMPTS } from "./finalizeRetry";

jest.mock("./chainClock", () => ({ chainNowMs: () => 1_000_000 }));

test("recognises the contract's not-ended revert only", () => {
  expect(isNotEndedRevert(new Error("execution reverted: Auction not ended yet"))).toBe(true);
  expect(isNotEndedRevert({ data: { message: "revert Auction not ended yet" } })).toBe(true);
  expect(isNotEndedRevert(new Error("Auction already finalized"))).toBe(false);
  expect(isNotEndedRevert(new Error("insufficient funds"))).toBe(false);
});

test("retry time is endTime + 3 s of chain time per failed attempt, never sooner than 1 s", () => {
  expect(nextFinalizeAttemptAtMs(1000, 1)).toBe(1_003_000);
  expect(nextFinalizeAttemptAtMs(1000, 2)).toBe(1_006_000);
  expect(finalizeRetryDelayMs(1000, 1, 1_000_500)).toBe(2500);
  expect(finalizeRetryDelayMs(1000, 1, 2_000_000)).toBe(1000);
  expect(MAX_FINALIZE_ATTEMPTS).toBe(3);
});
