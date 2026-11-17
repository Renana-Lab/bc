// Same small status label as the marketplace admin (src/market/BackendApp.js StatusLabel).
export const STATUS_COLORS = { active: "#1565c0", ended: "#ef6c00", sold: "#2e7d32", unsold: "#616161", cancelled: "#b00020" };

const labelStyle = {
  display: "inline-block",
  marginLeft: 6,
  padding: "1px 8px",
  borderRadius: 10,
  fontSize: "0.7rem",
  fontWeight: 700,
  textTransform: "uppercase",
  color: "#fff",
};

const TITLES = {
  active: "Open for bids",
  ended: "Ended with bids; waiting to be finalized",
  sold: "Finalized with a winner",
  unsold: "Ended or finalized without bids",
  cancelled: "Cancelled by an admin",
};

export const StatusLabel = ({ status, hidden = false }) => {
  if (!status) return null;
  return (
    <>
      <span title={TITLES[status] || status} style={{ ...labelStyle, background: STATUS_COLORS[status] || "#616161" }} data-testid="auction-status">
        {status}
      </span>
      {hidden ? (
        <span title="Hidden from non-admins in this app" style={{ ...labelStyle, color: "#616161", background: "transparent", border: "1px solid #616161" }} data-testid="auction-hidden">
          hidden
        </span>
      ) : null}
    </>
  );
};

export default StatusLabel;
