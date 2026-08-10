import {
  getFriendlyRpcError,
  getRpcFailureKind,
  isRpcProviderFailure,
} from "./rpcConfig";

describe("RPC failure classification", () => {
  test("classifies public provider throttling without exposing vendor copy", () => {
    const error = new Error(
      "Returned error: Rate limit exceeded. To obtain higher limits, visit allnodes.com",
    );

    expect(getRpcFailureKind(error)).toBe("capacity");
    expect(isRpcProviderFailure(error)).toBe(true);
    expect(getFriendlyRpcError(error)).toBe(
      "RPC capacity was reached. That endpoint is cooling down while the system uses another connection.",
    );
    expect(getFriendlyRpcError(error)).not.toMatch(/allnodes/i);
  });

  test("quarantines endpoints whose plan does not support Sepolia", () => {
    const error = new Error(
      "chain is not available on free plan, please upgrade to paid plan",
    );

    expect(getRpcFailureKind(error)).toBe("unsupported-plan");
    expect(getFriendlyRpcError(error)).toMatch(/disabled for this session/i);
  });
});
