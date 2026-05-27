import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import LaunchIcon from "@mui/icons-material/Launch";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import toast from "react-hot-toast";
import { getMarketOptions } from "../../real_ethereum/marketConfig";
import { readOnlyCall } from "../../real_ethereum/readOnly";

const GITHUB_OWNER = "Renana-Lab";
const GITHUB_REPO = "bc";
const WORKFLOW_FILE = "auto-finalize-auctions.yml";
const WORKFLOW_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}`;
const WORKFLOW_RUNS_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=6`;
const RERUN_COMMAND = `gh workflow run ${WORKFLOW_FILE} --repo ${GITHUB_OWNER}/${GITHUB_REPO} --ref master`;
const getCancelRunCommand = (runId) =>
  `gh run cancel ${runId} --repo ${GITHUB_OWNER}/${GITHUB_REPO}`;
const STALE_RUN_MS = 12 * 60 * 1000;
const SCAN_CONCURRENCY = 4;
const MONITOR_CARD_SX = {
  position: "relative",
  overflow: "hidden",
  contain: "paint",
  background:
    "linear-gradient(145deg, #ffffff 0%, #ffffff 58%, #f7f9ff 100%)",
  boxShadow:
    "inset 0 1px 0 rgba(255, 255, 255, 0.86), 0 4px 12px rgba(16, 48, 144, 0.035)",
  "&::before": {
    content: '""',
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    background:
      "linear-gradient(115deg, rgba(255, 255, 255, 0.38) 0%, rgba(255, 255, 255, 0.06) 38%, rgba(126, 149, 226, 0.06) 100%)",
  },
  "& > *": {
    position: "relative",
    zIndex: 1,
  },
};

const shortAddress = (address) =>
  address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Unknown";

const formatDateTime = (value) => {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
};

const getRunTone = (run) => {
  if (!run) return "default";
  if (run.status !== "completed") return "info";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "failure" || run.conclusion === "cancelled") {
    return "error";
  }
  return "warning";
};

const getRunLabel = (run) => {
  if (!run) return "No runs found";
  if (run.status !== "completed") return run.status;
  return run.conclusion || "completed";
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }
  );

  await Promise.all(workers);
  return results;
};

const readAuctionFinalizerState = async (address, factoryAddress) => {
  try {
    const summary = await readOnlyCall(
      ({ campaign }) => campaign(address).methods.getListSummary(),
      undefined,
      {
        factoryAddress,
        preferInjected: false,
        allowInjectedFallback: false,
      }
    );

    return {
      address,
      description: summary[5] || shortAddress(address),
      highestBid: summary[4],
      endTime: Number(summary[7]),
      closed: Boolean(summary[8]),
    };
  } catch (_listSummaryError) {
    const [summary, closed] = await Promise.all([
      readOnlyCall(
        ({ campaign }) => campaign(address).methods.getSummary(),
        undefined,
        {
          factoryAddress,
          preferInjected: false,
          allowInjectedFallback: false,
        }
      ),
      readOnlyCall(
        ({ campaign }) => campaign(address).methods.getStatus(),
        undefined,
        {
          factoryAddress,
          preferInjected: false,
          allowInjectedFallback: false,
        }
      ),
    ]);

    return {
      address,
      description: summary[5] || shortAddress(address),
      highestBid: summary[4],
      endTime: Number(summary[9]),
      closed: Boolean(closed),
    };
  }
};

const AutoFinalizerMonitor = ({ marketOptions }) => {
  const markets = useMemo(
    () => (marketOptions || getMarketOptions()).filter((market) => market.address),
    [marketOptions]
  );
  const marketNamesText = markets.map((market) => market.label).join(" and ");
  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState("");
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scan, setScan] = useState(null);

  const latestRun = runs[0];
  const activeRun = runs.find((run) =>
    ["queued", "in_progress", "waiting", "requested", "pending"].includes(
      run.status
    )
  );
  const latestRunAge = latestRun?.created_at
    ? Date.now() - new Date(latestRun.created_at).getTime()
    : null;
  const latestRunIsStale =
    typeof latestRunAge === "number" && latestRunAge > STALE_RUN_MS;
  const pendingCount =
    scan?.markets.reduce((sum, market) => sum + market.pending.length, 0) || 0;
  const failedReadCount =
    scan?.markets.reduce((sum, market) => sum + market.failedReads, 0) || 0;
  const healthTone = pendingCount || failedReadCount ? "warning" : "success";

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    setRunsError("");

    try {
      const response = await fetch(WORKFLOW_RUNS_API, {
        headers: { Accept: "application/vnd.github+json" },
      });

      if (!response.ok) {
        throw new Error(`GitHub returned ${response.status}`);
      }

      const payload = await response.json();
      setRuns(payload.workflow_runs || []);
    } catch (error) {
      setRunsError(error.message || "Could not read GitHub Actions status.");
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const scanContracts = useCallback(async () => {
    setScanLoading(true);
    setScanError("");

    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const marketResults = await mapWithConcurrency(
        markets,
        1,
        async (market) => {
          const addresses = await readOnlyCall(
            ({ factory }) => factory.methods.getDeployedCampaigns(),
            undefined,
            {
              factoryAddress: market.address,
              preferInjected: false,
              allowInjectedFallback: false,
            }
          );

          const states = await mapWithConcurrency(
            addresses,
            SCAN_CONCURRENCY,
            async (address) => {
              try {
                return await readAuctionFinalizerState(address, market.address);
              } catch (error) {
                return {
                  address,
                  error: error.message || "Read failed",
                };
              }
            }
          );

          const failedReads = states.filter((state) => state.error).length;
          const pending = states
            .filter(
              (state) =>
                !state.error && !state.closed && state.endTime <= nowSeconds
            )
            .sort((a, b) => a.endTime - b.endTime);

          return {
            ...market,
            total: addresses.length,
            pending,
            failedReads,
          };
        }
      );

      setScan({
        updatedAt: new Date().toISOString(),
        markets: marketResults,
      });
    } catch (error) {
      setScanError(error.message || "Could not scan contracts.");
    } finally {
      setScanLoading(false);
    }
  }, [markets]);

  const refreshAll = () => {
    loadRuns();
    scanContracts();
  };

  const copyRerunCommand = async () => {
    try {
      await navigator.clipboard.writeText(RERUN_COMMAND);
      toast.success("Re-run command copied");
    } catch (_error) {
      toast.error("Could not copy command");
    }
  };

  const copyCancelCommand = async () => {
    if (!activeRun?.id) return;

    try {
      await navigator.clipboard.writeText(getCancelRunCommand(activeRun.id));
      toast.success("Stop command copied");
    } catch (_error) {
      toast.error("Could not copy command");
    }
  };

  return (
    <Box sx={{ width: "100%" }}>
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="flex-start"
        gap={2}
        flexWrap="wrap"
      >
        <Box>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ textTransform: "uppercase", letterSpacing: 0.4 }}
          >
            Automation monitor
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 800 }}>
            Auto Finalizer
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 620 }}>
            Checks the GitHub Actions runner and scans
            {marketNamesText ? ` ${marketNamesText}` : " configured"} contracts
            for ended auctions that still need payment finalization.
          </Typography>
        </Box>
        <Box display="flex" gap={1} flexWrap="wrap" justifyContent="flex-end">
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshIcon />}
            onClick={refreshAll}
            disabled={runsLoading || scanLoading}
            sx={{ borderRadius: 999 }}
          >
            Check now
          </Button>
          <Button
            variant="contained"
            size="small"
            startIcon={<PlayArrowIcon />}
            onClick={() => window.open(WORKFLOW_URL, "_blank", "noopener,noreferrer")}
            sx={{ borderRadius: 999, backgroundColor: "#103090" }}
          >
            Re-run
          </Button>
          <Button
            variant="outlined"
            color="error"
            size="small"
            startIcon={<StopCircleIcon />}
            onClick={() =>
              activeRun?.html_url &&
              window.open(activeRun.html_url, "_blank", "noopener,noreferrer")
            }
            disabled={!activeRun?.html_url}
            sx={{ borderRadius: 999 }}
          >
            Stop run
          </Button>
        </Box>
      </Box>

      {(runsLoading || scanLoading) && <LinearProgress sx={{ mt: 2 }} />}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "1fr 1fr 1fr" },
          gap: 1.25,
          mt: 2,
        }}
      >
        <Box
          sx={{
            ...MONITOR_CARD_SX,
            p: 1.25,
            borderRadius: 2,
            border: "1px solid #edf0fb",
          }}
        >
          <Typography variant="caption" color="text.secondary">
            Latest GitHub run
          </Typography>
          <Box display="flex" gap={1} alignItems="center" sx={{ mt: 0.5 }}>
            <Chip
              size="small"
              color={getRunTone(latestRun)}
              label={getRunLabel(latestRun)}
              icon={
                latestRun?.conclusion === "success" ? (
                  <TaskAltIcon />
                ) : latestRun ? (
                  <ErrorOutlineIcon />
                ) : undefined
              }
            />
            {runsLoading && <CircularProgress size={16} />}
          </Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
            {latestRun
              ? `${formatDateTime(latestRun.created_at)}${
                  latestRunIsStale ? " - older than expected" : ""
                }`
              : "Click Check now to read GitHub status."}
          </Typography>
        </Box>

        <Box
          sx={{
            ...MONITOR_CARD_SX,
            p: 1.25,
            borderRadius: 2,
            border: "1px solid #edf0fb",
          }}
        >
          <Typography variant="caption" color="text.secondary">
            Pending finalization
          </Typography>
          <Box display="flex" gap={1} alignItems="center" sx={{ mt: 0.5 }}>
            <Chip
              size="small"
              color={healthTone}
              label={`${pendingCount} pending`}
              icon={pendingCount ? <ErrorOutlineIcon /> : <TaskAltIcon />}
            />
            {scanLoading && <CircularProgress size={16} />}
          </Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
            {scan?.updatedAt
              ? `Scanned ${formatDateTime(scan.updatedAt)}`
              : "Click Check now to scan contracts."}
          </Typography>
        </Box>

        <Box
          sx={{
            ...MONITOR_CARD_SX,
            p: 1.25,
            borderRadius: 2,
            border: "1px solid #edf0fb",
          }}
        >
          <Typography variant="caption" color="text.secondary">
            Read errors
          </Typography>
          <Box display="flex" gap={1} alignItems="center" sx={{ mt: 0.5 }}>
            <Chip
              size="small"
              color={failedReadCount ? "warning" : "success"}
              label={`${failedReadCount} read issue${failedReadCount === 1 ? "" : "s"}`}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
            Uses read-only RPC, not MetaMask, to avoid wallet noise.
          </Typography>
        </Box>
      </Box>

      {(runsError || scanError) && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {runsError || scanError}
        </Alert>
      )}

      {scan?.markets?.length ? (
        <Box sx={{ mt: 2 }}>
          {scan.markets.map((market) => (
            <Box
              key={market.id}
              sx={{
                ...MONITOR_CARD_SX,
                mb: 1,
                p: 1.25,
                borderRadius: 2,
                border: "1px solid #edf0fb",
              }}
            >
              <Box display="flex" justifyContent="space-between" gap={1} flexWrap="wrap">
                <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                  {market.label} market
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {market.total} auction{market.total === 1 ? "" : "s"} checked
                </Typography>
              </Box>
              {market.pending.length ? (
                <Box sx={{ mt: 1 }}>
                  {market.pending.slice(0, 4).map((auction) => (
                    <Typography
                      key={auction.address}
                      variant="caption"
                      display="block"
                      color="warning.main"
                    >
                      Needs finalization: {auction.description} ({shortAddress(auction.address)})
                    </Typography>
                  ))}
                  {market.pending.length > 4 && (
                    <Typography variant="caption" color="text.secondary">
                      +{market.pending.length - 4} more pending auction
                      {market.pending.length - 4 === 1 ? "" : "s"}
                    </Typography>
                  )}
                </Box>
              ) : (
                <Typography variant="caption" color="success.main">
                  No ended unfinalized auctions found.
                </Typography>
              )}
              {market.failedReads > 0 && (
                <Typography variant="caption" color="warning.main" display="block">
                  {market.failedReads} auction read
                  {market.failedReads === 1 ? "" : "s"} failed during scan.
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      ) : null}

      <Divider sx={{ my: 2 }} />

      <Box display="flex" gap={1} flexWrap="wrap" alignItems="center">
        <Button
          variant="outlined"
          size="small"
          startIcon={<LaunchIcon />}
          href={WORKFLOW_URL}
          target="_blank"
          rel="noreferrer"
          sx={{ borderRadius: 999 }}
        >
          View logs
        </Button>
        <Button
          variant="text"
          size="small"
          startIcon={<ContentCopyIcon />}
          onClick={copyRerunCommand}
        >
          Copy CLI re-run command
        </Button>
        <Button
          variant="text"
          color="error"
          size="small"
          startIcon={<ContentCopyIcon />}
          onClick={copyCancelCommand}
          disabled={!activeRun?.id}
        >
          Copy CLI stop command
        </Button>
        <Typography variant="caption" color="text.secondary">
          This admin panel does not finalize automatically. GitHub Actions starts
          scheduled runs about every 5 minutes; each run checks every 15 seconds
          while active. Re-run and stop open GitHub because tokens must not live
          in the frontend.
        </Typography>
      </Box>
    </Box>
  );
};

export default AutoFinalizerMonitor;
