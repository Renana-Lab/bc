import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Tooltip,
  Typography,
} from "@mui/material";
import AdminPanelSettingsOutlinedIcon from "@mui/icons-material/AdminPanelSettingsOutlined";
import GavelOutlinedIcon from "@mui/icons-material/GavelOutlined";
import PeopleAltOutlinedIcon from "@mui/icons-material/PeopleAltOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  getLivePresence,
  isPresenceConfigured,
  PRESENCE_UPDATE_EVENT,
} from "../../telemetry/presenceClient";

const EMPTY_COUNTS = {
  users: 0,
  admins: 0,
  bots: 0,
  activeAuctions: 0,
  sessions: 0,
};

const metricDefinitions = [
  {
    key: "users",
    label: "Users online",
    help: "Unique connected wallets, excluding wallets currently authenticated as admins.",
    Icon: PeopleAltOutlinedIcon,
    color: "#103090",
    background: "#edf2ff",
  },
  {
    key: "admins",
    label: "Admins online",
    help: "Unique wallets with an authenticated Admin Zone session.",
    Icon: AdminPanelSettingsOutlinedIcon,
    color: "#6b3fa0",
    background: "#f5efff",
  },
  {
    key: "bots",
    label: "Bots online",
    help: "Unique enabled bot wallets whose browser scheduler is running and heartbeating.",
    Icon: SmartToyOutlinedIcon,
    color: "#0f7044",
    background: "#edf8f2",
  },
  {
    key: "activeAuctions",
    label: "Active auctions",
    help: "Open, unfinalized auction contracts whose end time is still in the future.",
    Icon: GavelOutlinedIcon,
    color: "#9a5b00",
    background: "#fff6e6",
  },
];

const formatFreshness = (timestamp, now) => {
  if (!timestamp) return "Waiting for first update";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 2) return "Updated now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.floor(seconds / 60)}m ago`;
};

const LiveActivityPanel = () => {
  const configured = isPresenceConfigured();
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [peakToday, setPeakToday] = useState(EMPTY_COUNTS);
  const [status, setStatus] = useState(configured ? "connecting" : "unconfigured");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);

  const applyPayload = useCallback((payload) => {
    if (payload?.counts) {
      setCounts({ ...EMPTY_COUNTS, ...payload.counts });
      setUpdatedAt(Number(payload.counts.timestamp || Date.now()));
    }
    if (payload?.peakToday) {
      setPeakToday({ ...EMPTY_COUNTS, ...payload.peakToday });
    }
    if (payload?.status) setStatus(payload.status);
    if (payload?.error) setError(payload.error);
    else if (payload?.ok !== false) setError("");
  }, []);

  const refresh = useCallback(async () => {
    if (!configured) return;
    setRefreshing(true);
    try {
      applyPayload({ ...(await getLivePresence()), status: "live" });
    } catch (refreshError) {
      applyPayload({
        ok: false,
        status: "degraded",
        error: refreshError.message || "Live activity is temporarily unavailable.",
      });
    } finally {
      setRefreshing(false);
    }
  }, [applyPayload, configured]);

  useEffect(() => {
    if (!configured) return undefined;
    refresh();
    const refreshTimer = window.setInterval(refresh, 10000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    const handlePresenceUpdate = (event) => applyPayload(event.detail || {});
    window.addEventListener(PRESENCE_UPDATE_EVENT, handlePresenceUpdate);
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
      window.removeEventListener(PRESENCE_UPDATE_EVENT, handlePresenceUpdate);
    };
  }, [applyPayload, configured, refresh]);

  const freshness = useMemo(
    () => formatFreshness(updatedAt, now),
    [now, updatedAt],
  );

  if (!configured) {
    return (
      <Alert severity="info" sx={{ borderRadius: 2 }}>
        Live activity is ready in the app but not configured for this deployment. Deploy the
        serverless presence stack and set <strong>REACT_APP_PRESENCE_API_URL</strong> in Amplify.
      </Alert>
    );
  }

  return (
    <Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          mb: 1.5,
        }}
      >
        <Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.8 }}>
            <Box
              aria-hidden="true"
              sx={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: status === "live" ? "#31a66a" : "#d38b24",
                boxShadow:
                  status === "live" ? "0 0 0 4px rgba(49, 166, 106, 0.11)" : "none",
              }}
            />
            <Typography variant="body2" sx={{ fontWeight: 800 }}>
              {status === "live" ? "Live connection" : "Reconnecting"}
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {freshness} / {counts.sessions} active browser session
            {counts.sessions === 1 ? "" : "s"}
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          startIcon={refreshing ? <CircularProgress size={14} /> : <RefreshIcon />}
          onClick={refresh}
          disabled={refreshing}
          sx={{ borderRadius: 999, flexShrink: 0 }}
        >
          Refresh
        </Button>
      </Box>

      {error && (
        <Alert severity="warning" sx={{ mb: 1.5, borderRadius: 2 }}>
          {error} The auction system is unaffected.
        </Alert>
      )}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
          gap: 1.25,
        }}
      >
        {metricDefinitions.map(({ key, label, help, Icon, color, background }) => (
          <Tooltip key={key} title={help} arrow placement="top">
            <Box
              tabIndex={0}
              sx={{
                display: "grid",
                gridTemplateColumns: "38px minmax(0, 1fr) auto",
                alignItems: "center",
                gap: 1.25,
                minHeight: 76,
                px: 1.4,
                py: 1.2,
                borderRadius: 2,
                border: "1px solid rgba(159, 176, 239, 0.3)",
                background:
                  "linear-gradient(135deg, rgba(255,255,255,0.96), rgba(247,249,255,0.82))",
                outline: "none",
                "&:focus-visible": { boxShadow: "0 0 0 3px rgba(16,48,144,0.13)" },
              }}
            >
              <Box
                sx={{
                  width: 38,
                  height: 38,
                  borderRadius: 1.5,
                  display: "grid",
                  placeItems: "center",
                  color,
                  backgroundColor: background,
                }}
              >
                <Icon fontSize="small" />
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 750 }}>
                  {label}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Peak today: {peakToday[key] || 0}
                </Typography>
              </Box>
              <Typography
                component="strong"
                sx={{ fontSize: 28, lineHeight: 1, fontWeight: 850, color: "#11164f" }}
              >
                {counts[key] || 0}
              </Typography>
            </Box>
          </Tooltip>
        ))}
      </Box>
    </Box>
  );
};

export default LiveActivityPanel;
