// Admin-state notices and the seller's edit-minimum control for one auction. Never shows payloads.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, TextField, Typography } from "@mui/material";
import { readOnlyCall } from "../../real_ethereum/readOnly";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import { chainNowMs } from "../../real_ethereum/chainClock";
import { readIsFactoryAdmin } from "../../real_ethereum/adminChain";
import { canSellerEditMinimum, mapAuctionAdminRow } from "../ManageBudget/adminCardData";
import { createAdminActions, validateMinimum } from "../ManageBudget/adminActions";

const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };

const defaultReadState = async ({ address, account }) => {
  const options = { ...READ_OPTIONS, factoryAddress: getActiveFactoryAddress() };
  const [hidden, allowSellerEdit, isAdmin] = await Promise.all([
    readOnlyCall(({ factory }) => factory.methods.hidden(address), 1, options).catch(() => false),
    readOnlyCall(({ factory }) => factory.methods.allowSellerEdit(), 1, options).catch(() => false),
    account ? readIsFactoryAdmin(account, options).catch(() => false) : Promise.resolve(false),
  ]);
  return { hidden: Boolean(hidden), allowSellerEdit: Boolean(allowSellerEdit), isAdmin: Boolean(isAdmin) };
};

export default function AuctionAdminPanel({
  address,
  account,
  manager,
  minimumContribution,
  hasBids,
  endTimeSec,
  closed,
  cancelled,
  onChanged,
  readState = defaultReadState,
  actions: actionsOverride,
}) {
  const actions = useMemo(() => actionsOverride || createAdminActions(), [actionsOverride]);
  const [flags, setFlags] = useState({ hidden: false, allowSellerEdit: false, isAdmin: false });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState({ busy: false, message: "", ok: true });

  useEffect(() => {
    let live = true;
    Promise.resolve(readState({ address, account })).then(
      (next) => live && setFlags(next),
      () => {}
    );
    return () => {
      live = false;
    };
  }, [address, account, closed, cancelled, hasBids, readState]);

  const row = mapAuctionAdminRow({
    address,
    summary: [minimumContribution, 0, 0, manager, 0, "", hasBids ? "0x1" : "", endTimeSec, closed],
    cancelled,
    hidden: flags.hidden,
  });
  const canEdit = canSellerEditMinimum({
    row,
    account,
    nowSec: Math.floor(chainNowMs() / 1000),
    allowSellerEdit: flags.allowSellerEdit,
  });

  const save = useCallback(async () => {
    setStatus({ busy: true, message: "", ok: true });
    try {
      validateMinimum(draft);
      await actions.sellerSetMinimum(address, draft);
      setEditing(false);
      setStatus({ busy: false, message: "Minimum updated.", ok: true });
      await onChanged?.();
    } catch (error) {
      setStatus({ busy: false, message: error?.message || "Could not update the minimum.", ok: false });
    }
  }, [actions, address, draft, onChanged]);

  return (
    <Box sx={{ textAlign: "center", my: 1 }}>
      {cancelled ? (
        <Typography color="error" role="status" data-testid="auction-cancelled-banner">
          This auction was cancelled by an admin. The leading bidder is refunded, the seller is not paid and no data is released.
        </Typography>
      ) : null}
      {flags.isAdmin && flags.hidden ? (
        <Typography variant="body2" role="status" data-testid="auction-hidden-badge">
          Hidden from the auctions list (visible to admins only).
        </Typography>
      ) : null}
      {canEdit ? (
        editing ? (
          <Box sx={{ display: "flex", gap: 1, justifyContent: "center", alignItems: "center", mt: 1, flexWrap: "wrap" }}>
            <TextField
              size="small"
              label="New minimum bid (wei)"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button variant="contained" size="small" disabled={status.busy} onClick={save}>
              Save minimum
            </Button>
            <Button size="small" onClick={() => setEditing(false)}>
              Back
            </Button>
          </Box>
        ) : (
          <Button
            size="small"
            variant="outlined"
            sx={{ mt: 1 }}
            onClick={() => {
              setDraft(String(minimumContribution ?? ""));
              setEditing(true);
            }}
          >
            Edit minimum bid
          </Button>
        )
      ) : null}
      {status.message ? (
        <Typography variant="body2" color={status.ok ? "success.main" : "error"} role="status">
          {status.message}
        </Typography>
      ) : null}
    </Box>
  );
}
