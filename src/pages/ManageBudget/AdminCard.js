// Shared admin card: the same gloss card, title, collapse button and 65 ms Collapse as the marketplace
// admin (src/market/BackendApp.js AdminCard). Styles live in src/styles/admin.css.
import { useState } from "react";
import { Box, Button, Collapse, IconButton, Typography } from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import RefreshIcon from "@mui/icons-material/Refresh";
import "../../styles/admin.css";

export const adminHeadCellSx = { fontWeight: 700, color: "#002884", fontSize: 14 };

export const adminPrimaryButtonSx = {
  backgroundColor: "#103090",
  borderRadius: "20px",
  textTransform: "none",
  "&:hover": { backgroundColor: "#0c2470" },
};

const refreshPillSx = {
  borderRadius: "20px",
  borderColor: "#103090",
  color: "#103090",
  textTransform: "none",
  "&:hover": { borderColor: "#103090", backgroundColor: "rgba(16, 48, 144, 0.06)" },
};

// Market-style outlined refresh pill used as an AdminCard `action`.
export const AdminRefreshButton = ({ onClick, loading = false, label = "Refresh" }) => (
  <Button
    size="small"
    variant="outlined"
    startIcon={<RefreshIcon />}
    onClick={onClick}
    disabled={loading}
    sx={refreshPillSx}
  >
    {loading ? "Loading..." : label}
  </Button>
);

// Controlled when `open` is given (with `onToggle`); otherwise it keeps its own state from `defaultOpen`.
const AdminCard = ({ title, children, open, onToggle, action = null, defaultOpen = false, unmountOnExit = false }) => {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const controlled = typeof open === "boolean";
  const isOpen = controlled ? open : innerOpen;
  const toggle = () => {
    if (!controlled) setInnerOpen((value) => !value);
    onToggle?.();
  };
  const panelId = `admin-card-${String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <Box className={`adminGlossCard ${isOpen ? "adminGlossCardOpen" : ""}`}>
      <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start", gap: 2 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" sx={{ color: "#002884", fontWeight: 700 }}>
            {title}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
          {action}
          <IconButton
            onClick={toggle}
            aria-expanded={isOpen}
            aria-controls={panelId}
            aria-label={isOpen ? `Collapse ${title}` : `Expand ${title}`}
            className="adminCollapseButton"
          >
            <KeyboardArrowDownIcon
              sx={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 75ms ease-out" }}
            />
          </IconButton>
        </Box>
      </Box>
      <Collapse in={isOpen} timeout={65} id={panelId} unmountOnExit={unmountOnExit}>
        <Box sx={{ pt: 2 }}>{children}</Box>
      </Collapse>
    </Box>
  );
};

export default AdminCard;
