/* eslint-env es2020 */
// React side of the Admin Zone UI gate (see adminGate.js: UI only, contract writes are not enforced).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Typography } from "@mui/material";
import { getWalletAccess, requireWalletAccess, subscribeWalletAccess } from "../../real_ethereum/walletAccess";
import { ensureTargetChain, getTargetNetwork } from "../../real_ethereum/sapphireNetworks";
import {
  ADMIN_GATE_NOTE,
  getAdminAddresses,
  getAdminProofExpiry,
  getVerifiedAdminAddress,
  isAdminAddress,
  requestAdminProof,
} from "./adminGate";

const connectedAccount = () => {
  const access = getWalletAccess();
  return access.status === "connected" ? access.account : "";
};

// Tracks the connected wallet and whether it currently holds a valid admin proof. Admin status is
// re-derived (signature re-verified) on wallet changes, tab focus/visibility and at proof expiry, so an
// open tab loses admin after ADMIN_PROOF_MINUTES and when the wallet account changes.
export const useAdminAccess = ({ allowlist } = {}) => {
  const list = useMemo(() => allowlist || getAdminAddresses(), [allowlist]);
  const [account, setAccount] = useState(connectedAccount);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timerRef = useRef(null);

  const recheck = useCallback(() => {
    const next = connectedAccount();
    setAccount(next);
    const verified = next ? getVerifiedAdminAddress(next, { allowlist: list }) : "";
    setIsAdmin(Boolean(verified));
    window.clearTimeout(timerRef.current);
    if (verified) {
      const msLeft = getAdminProofExpiry(next, { allowlist: list }) - Date.now();
      // setTimeout caps at ~24.8 days; proofs are an hour, but stay safe.
      timerRef.current = window.setTimeout(recheck, Math.min(Math.max(msLeft, 0) + 50, 2 ** 31 - 1));
    }
  }, [list]);

  useEffect(() => {
    recheck();
    const unsubscribe = subscribeWalletAccess(recheck);
    const onVisible = () => {
      if (!document.hidden) recheck();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(timerRef.current);
    };
  }, [recheck]);

  const onAllowlist = isAdminAddress(account, list);

  const unlock = useCallback(async () => {
    setError("");
    const current = connectedAccount();
    if (!current) {
      setError("Connect your wallet first.");
      return;
    }
    // Never prompt a wallet that is not on the list.
    if (!isAdminAddress(current, list)) {
      setError("This wallet address is not on the admin list.");
      return;
    }
    setBusy(true);
    try {
      const session = await requireWalletAccess();
      const network = await ensureTargetChain(session.provider, getTargetNetwork());
      await requestAdminProof({
        provider: session.provider,
        account: session.account,
        chainId: network.chainId,
        domain: window.location.host,
        uri: window.location.origin,
        allowlist: list,
      });
      recheck();
    } catch (gateError) {
      setError(gateError?.code === 4001 ? "Signature request was rejected." : gateError?.message || "Admin sign-in failed.");
    } finally {
      setBusy(false);
    }
  }, [list, recheck]);

  return { account, isAdmin, onAllowlist, busy, error, unlock, allowlistSize: list.length };
};

export const AdminGatePrompt = ({ access, shortAddress = (value) => value }) => (
  <>
    <Typography variant="h5" gutterBottom>
      Admin Access Required
    </Typography>
    <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ mt: 1 }}>
      {access.account ? `Connected wallet: ${shortAddress(access.account)}` : "Connect your wallet to continue."}
    </Typography>
    {!access.allowlistSize ? (
      <Typography variant="body2" color="error" sx={{ mt: 2 }}>
        No admin addresses are configured (REACT_APP_ADMIN_ADDRESSES), so nobody can unlock this page.
      </Typography>
    ) : access.account && !access.onAllowlist ? (
      <Typography variant="body2" color="error" sx={{ mt: 2 }}>
        This wallet address is not on the admin list.
      </Typography>
    ) : null}
    <Button
      variant="contained"
      color="primary"
      fullWidth
      sx={{ mt: 3 }}
      onClick={access.unlock}
      disabled={access.busy || !access.account || !access.onAllowlist}
    >
      {access.busy ? "Waiting for signature..." : "Sign to unlock"}
    </Button>
    {access.error && (
      <Typography color="error" sx={{ mt: 2 }}>
        {access.error}
      </Typography>
    )}
    <Typography variant="caption" color="text.secondary" sx={{ mt: 2 }} textAlign="center">
      {ADMIN_GATE_NOTE}
    </Typography>
  </>
);
