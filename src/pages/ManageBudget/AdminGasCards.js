import { Box, Button, Typography } from "@mui/material";
import { clearWalletOverrides, hasWalletOverride } from "../../real_ethereum/wallets/walletMode.mjs";
import { useIsAdminWallet } from "../../real_ethereum/wallets/useIsAdminWallet";
import ParticipantsGasCard from "./ParticipantsGasCard";
import FaucetFundsCard from "./FaucetFundsCard";

// Visible while an admin session override is active (MetaMask sign-in or an imported admin key).
export const AdminSessionControls = ({ reload = () => window.location.reload() }) => {
  const { isAdmin } = useIsAdminWallet();
  if (!hasWalletOverride() || !isAdmin) return null;
  return (
    <Box sx={{ width: "100%", mb: 2, display: "flex", gap: 2, alignItems: "center" }} data-testid="admin-session-controls">
      <Typography variant="body2">Admin session: you are using your admin wallet instead of the participant wallet.</Typography>
      <Button size="small" variant="outlined" onClick={() => { clearWalletOverrides(); reload(); }}>Switch back to participant wallet</Button>
    </Box>
  );
};

// Single entry point rendered by AdminOpsCards. Each card hides itself unless the connected wallet is an admin.
const AdminGasCards = () => (
  <>
    <AdminSessionControls />
    <ParticipantsGasCard />
    <FaucetFundsCard />
  </>
);

export default AdminGasCards;
