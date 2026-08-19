import {
  __resetRpcProviderHealthForTests,
  executeWithRpcFailover,
  getConfiguredRpcUrls,
  getFriendlyRpcError,
  getHealthyRpcUrls,
  getRpcFailureKind,
  isRpcProviderFailure,
  scheduleRpcRequest,
} from "./rpcConfig";

describe("RPC failure classification", () => {
  beforeEach(() => {
    __resetRpcProviderHealthForTests();
  });

  test("classifies public provider throttling without exposing vendor copy", () => {
    const error = new Error(
      "Returned error: Rate limit exceeded. To obtain higher limits, visit allnodes.com",
    );

    expect(getRpcFailureKind(error)).toBe("capacity");
    expect(isRpcProviderFailure(error)).toBe(true);
    expect(getFriendlyRpcError(error)).toBe(
      "Blockchain data is syncing through a backup connection.",
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

  test("ships a redundant fallback pool without legacy shared credentials", () => {
    const urls = getConfiguredRpcUrls();

    expect(urls.length).toBeGreaterThanOrEqual(3);
    expect(urls).toContain("https://ethereum-sepolia-rpc.publicnode.com");
    expect(urls).toContain("https://sepolia.gateway.tenderly.co");
    expect(urls).toContain("https://sepolia.rpc.thirdweb.com");
    expect(urls.join(",")).not.toContain("6426761d274542bb9652e9a5aff35a0c");
  });

  test("classifies HTTP provider status codes even without vendor text", () => {
    expect(getRpcFailureKind({ response: { status: 429 } })).toBe("capacity");
    expect(getRpcFailureKind({ status: 503 })).toBe("network");
    expect(getRpcFailureKind({ statusCode: 403 })).toBe("unsupported-plan");
  });

  test("fails over when Web3 cannot connect to a configured node", () => {
    const error = new Error(
      "CONNECTION ERROR: Couldn't connect to node https://rpc.sepolia.org.",
    );

    expect(getRpcFailureKind(error)).toBe("network");
    expect(isRpcProviderFailure(error)).toBe(true);
    expect(getFriendlyRpcError(error)).toMatch(/automatic connection recovery/i);
  });

  test("silently fails over and quarantines an unreachable endpoint", async () => {
    const urls = ["https://first.example", "https://second.example"];
    const operation = jest.fn(async (url) => {
      if (url === urls[0]) throw new Error("CONNECTION ERROR: Couldn't connect to node");
      return "healthy-result";
    });

    const result = await executeWithRpcFailover(urls, operation);

    expect(result).toMatchObject({
      value: "healthy-result",
      url: urls[1],
      attempts: 2,
    });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(getHealthyRpcUrls(urls)).toEqual([urls[1]]);
  });

  test("reports one aggregate outage only after every endpoint fails", async () => {
    const urls = ["https://first.example", "https://second.example"];
    const operation = jest.fn(async () => {
      throw new Error("network error");
    });

    await expect(executeWithRpcFailover(urls, operation)).rejects.toMatchObject({
      code: "RPC_POOL_UNAVAILABLE",
      providerFailures: [
        { url: urls[0], kind: "network" },
        { url: urls[1], kind: "network" },
      ],
    });
    expect(getFriendlyRpcError(await executeWithRpcFailover(urls, operation).catch((error) => error)))
      .toMatch(/reconnecting automatically/i);
  });

  test("serializes bursts sent to the same endpoint", async () => {
    const url = "https://paced.example";
    let active = 0;
    let maxActive = 0;
    const operation = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return true;
    };

    await Promise.all(
      Array.from({ length: 5 }, () => scheduleRpcRequest(url, operation)),
    );

    expect(maxActive).toBe(1);
  });

  test("flushes queued work away from an endpoint as soon as capacity is exhausted", async () => {
    const urls = ["https://overloaded.example", "https://backup.example"];
    let overloadedCalls = 0;
    const operation = async (url) => {
      if (url === urls[0]) {
        overloadedCalls += 1;
        throw new Error("429 Too Many Requests");
      }
      return "backup-result";
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => executeWithRpcFailover(urls, operation)),
    );

    expect(overloadedCalls).toBe(1);
    expect(results.every((result) => result.value === "backup-result")).toBe(true);
    expect(results.every((result) => result.url === urls[1])).toBe(true);
  });
});
