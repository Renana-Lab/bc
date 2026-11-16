import { useEffect, useState } from "react";
import { getWalletAccess, subscribeWalletAccess } from "../walletAccess";
import { isAdminAddress } from "../../pages/ManageBudget/adminGate";

const read = () => {
  const access = getWalletAccess();
  return access.status === "connected" ? access.account : "";
};

// UI-level check: the connected wallet is on REACT_APP_ADMIN_ADDRESSES. (Admin Zone itself additionally needs the
// signed proof from useAdminAccess; this only decides whether admin-only controls are drawn at all.)
export const useIsAdminWallet = ({ allowlist } = {}) => {
  const [account, setAccount] = useState(read);
  useEffect(() => {
    setAccount(read());
    return subscribeWalletAccess(() => setAccount(read()));
  }, []);
  return { account, isAdmin: Boolean(account) && (allowlist ? isAdminAddress(account, allowlist) : isAdminAddress(account)) };
};
