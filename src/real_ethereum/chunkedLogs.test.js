import {
  MAX_LOG_RANGE_BLOCKS,
  describeRangeHealth,
  planLogRanges,
  readLogsChunked,
} from "./chunkedLogs";

describe("planLogRanges", () => {
  test("splits into inclusive ranges of at most 90 blocks covering the window exactly", () => {
    const { ranges, truncated } = planLogRanges(1000, 1999);
    expect(truncated).toBe(false);
    expect(ranges[0].from).toBe(1000);
    expect(ranges[ranges.length - 1].to).toBe(1999);
    ranges.forEach(({ from, to }) => expect(to - from + 1).toBeLessThanOrEqual(MAX_LOG_RANGE_BLOCKS));
    ranges.slice(1).forEach(({ from }, index) => expect(from).toBe(ranges[index].to + 1));
  });
  test("never exceeds 90 blocks even if a larger chunk size is requested", () => {
    planLogRanges(0, 5000, { chunkSize: 500, maxRequests: 1000 }).ranges.forEach(({ from, to }) =>
      expect(to - from + 1).toBeLessThanOrEqual(90)
    );
  });
  test("hard-caps the number of requests, keeping the newest blocks", () => {
    const plan = planLogRanges(0, 1_000_000, { maxRequests: 5 });
    expect(plan.ranges).toHaveLength(5);
    expect(plan.truncated).toBe(true);
    expect(plan.ranges[4].to).toBe(1_000_000);
    expect(plan.fromBlock).toBe(1_000_000 - 5 * 90 + 1);
  });
  test("handles empty and single-block windows", () => {
    expect(planLogRanges(10, 5).ranges).toEqual([]);
    expect(planLogRanges(7, 7).ranges).toEqual([{ from: 7, to: 7 }]);
  });
});

describe("readLogsChunked", () => {
  test("only requests ranges within the RPC limit, with limited concurrency", async () => {
    let active = 0;
    let peak = 0;
    const seen = [];
    const result = await readLogsChunked({
      fromBlock: 0,
      toBlock: 999,
      concurrency: 3,
      fetchRange: async (from, to) => {
        seen.push([from, to]);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return [{ blockNumber: from }];
      },
    });
    expect(seen.every(([from, to]) => to - from + 1 <= 90)).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.logs).toHaveLength(result.totalRanges);
    expect(result.failedRanges).toEqual([]);
  });

  test("reports partial failure instead of swallowing it, and keeps the logs that did load", async () => {
    const result = await readLogsChunked({
      fromBlock: 0,
      toBlock: 359, // 4 ranges
      fetchRange: async (from) => {
        if (from === 90) throw new Error("max allowed of rounds in logs query is: 100");
        return [{ blockNumber: from }];
      },
    });
    expect(result.totalRanges).toBe(4);
    expect(result.failedRanges).toEqual([{ from: 90, to: 179, error: "max allowed of rounds in logs query is: 100" }]);
    expect(result.logs.map((log) => log.blockNumber)).toEqual([0, 180, 270]);
    expect(describeRangeHealth(result)).toBe("1 of 4 ranges failed");
  });

  test("a cap-shortened window is reported", async () => {
    const result = await readLogsChunked({ fromBlock: 0, toBlock: 100000, maxRequests: 3, fetchRange: async () => [] });
    expect(result.totalRanges).toBe(3);
    expect(describeRangeHealth(result)).toMatch(/shortened/);
  });

  test("all ranges failing is visible as N of N", async () => {
    const result = await readLogsChunked({
      fromBlock: 0,
      toBlock: 179,
      fetchRange: async () => {
        throw new Error("down");
      },
    });
    expect(describeRangeHealth(result)).toBe("2 of 2 ranges failed");
    expect(result.logs).toEqual([]);
  });
});
