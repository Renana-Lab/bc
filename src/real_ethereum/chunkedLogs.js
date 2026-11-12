// eth_getLogs helper for RPCs with a small block-range limit.
// The public Sapphire RPC rejects ranges over 100 rounds ("max allowed of rounds in logs query is: 100"),
// so ranges are capped at 90 blocks (inclusive) and the total number of requests is hard-capped.
export const MAX_LOG_RANGE_BLOCKS = 90;
export const DEFAULT_MAX_LOG_REQUESTS = 60;
export const DEFAULT_LOG_CONCURRENCY = 3;

// Splits [fromBlock, toBlock] into ascending ranges of <= chunkSize blocks. When that would take more
// than maxRequests ranges, only the newest maxRequests ranges are kept and `truncated` is set.
export const planLogRanges = (
  fromBlock,
  toBlock,
  { chunkSize = MAX_LOG_RANGE_BLOCKS, maxRequests = DEFAULT_MAX_LOG_REQUESTS } = {}
) => {
  const size = Math.max(1, Math.min(Math.floor(chunkSize) || 1, MAX_LOG_RANGE_BLOCKS));
  const cap = Math.max(1, Math.floor(maxRequests) || 1);
  const end = Math.floor(toBlock);
  let start = Math.max(0, Math.floor(fromBlock));
  if (!Number.isFinite(end) || end < start) return { ranges: [], truncated: false, fromBlock: start, toBlock: end };

  let truncated = false;
  if (Math.ceil((end - start + 1) / size) > cap) {
    start = end - cap * size + 1;
    truncated = true;
  }
  const ranges = [];
  for (let from = start; from <= end; from += size) {
    ranges.push({ from, to: Math.min(end, from + size - 1) });
  }
  return { ranges, truncated, fromBlock: start, toBlock: end };
};

// fetchRange(from, to) -> array of logs. Failures are collected, not thrown, so callers can show
// "N of M ranges failed" instead of silently dropping data.
export const readLogsChunked = async ({
  fromBlock,
  toBlock,
  fetchRange,
  chunkSize = MAX_LOG_RANGE_BLOCKS,
  maxRequests = DEFAULT_MAX_LOG_REQUESTS,
  concurrency = DEFAULT_LOG_CONCURRENCY,
}) => {
  const plan = planLogRanges(fromBlock, toBlock, { chunkSize, maxRequests });
  const results = new Array(plan.ranges.length);
  const failedRanges = [];
  let next = 0;
  const worker = async () => {
    while (next < plan.ranges.length) {
      const index = next;
      next += 1;
      const { from, to } = plan.ranges[index];
      try {
        results[index] = (await fetchRange(from, to)) || [];
      } catch (error) {
        results[index] = [];
        failedRanges.push({ from, to, error: error?.message || String(error) });
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, plan.ranges.length || 1));
  await Promise.all(Array.from({ length: workers }, worker));
  failedRanges.sort((a, b) => a.from - b.from);
  return {
    logs: results.flat(),
    totalRanges: plan.ranges.length,
    failedRanges,
    truncated: plan.truncated,
    fromBlock: plan.fromBlock,
    toBlock: plan.toBlock,
  };
};

export const describeRangeHealth = ({ totalRanges = 0, failedRanges = [], truncated = false, fromBlock = 0 } = {}) => {
  const parts = [];
  if (failedRanges.length) parts.push(`${failedRanges.length} of ${totalRanges} ranges failed`);
  if (truncated) parts.push(`window shortened to the newest blocks (from ${fromBlock}) by the request cap`);
  return parts.join("; ");
};
