// Shared by the auctions list, the Dynamic active-auction list and Auction controls: one place that owns the record
// and cancel dialogs and the close-early confirmation, so every entry point behaves the same way.
import { createElement, useCallback, useMemo, useState } from "react";
import { createAdminActions } from "./adminActions";
import AuctionRecordDialog from "./AuctionRecordDialog";
import CancelAuctionDialog from "./CancelAuctionDialog";

export const CLOSE_EARLY_CONFIRM = "Close this auction now? Bidding will stop immediately.";

export const useAuctionAdminDialogs = ({ actions: actionsOverride, onChanged, canWrite = true, confirm = (text) => window.confirm(text), onError } = {}) => {
  const actions = useMemo(() => actionsOverride || createAdminActions(), [actionsOverride]);
  const [record, setRecord] = useState(null); // address
  const [cancel, setCancel] = useState(null); // { address, description }

  const closeEarly = useCallback(
    async (address) => {
      if (!confirm(CLOSE_EARLY_CONFIRM)) return false;
      try {
        await actions.closeNow(address);
        await onChanged?.();
        return true;
      } catch (error) {
        onError?.(error?.message || "Close failed.");
        return false;
      }
    },
    [actions, confirm, onChanged, onError]
  );

  const dialogs = [
    record ? createElement(AuctionRecordDialog, { key: "record", address: record, canWrite, actions, onChanged, onClose: () => setRecord(null) }) : null,
    cancel ? createElement(CancelAuctionDialog, { key: "cancel", auction: cancel, actions, onDone: onChanged, onClose: () => setCancel(null) }) : null,
  ];
  return { openRecord: setRecord, openCancel: setCancel, closeEarly, dialogs };
};

export default useAuctionAdminDialogs;
