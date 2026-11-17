// Confirm dialog for cancelling an auction, modelled on the marketplace DeleteAuctionDialog. On chain the auction
// is not hidden from non-admins by cancelling; it is closed and marked cancelled.
import { useState } from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from "@mui/material";
import { MAX_NOTE_BYTES, byteLength } from "./adminActions";

export const cancelDialogText = (description) =>
  `${description || "This auction"} will be closed and marked cancelled. Its record and bids stay on chain. If it has not been finalized, the leading bid is refunded and the seller is not paid. If it was already finalized, nothing is refunded.`;

const CancelAuctionDialog = ({ auction, actions, onClose, onDone }) => {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bytes = byteLength(note.trim());
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await actions.cancelAuction(auction.address, note);
      await onDone?.();
      onClose();
    } catch (cancelError) {
      setError(cancelError?.message || "Cancel failed.");
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Cancel auction?</DialogTitle>
      <DialogContent>
        <p>{cancelDialogText(auction.description)}</p>
        <TextField
          label="Note (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          fullWidth
          size="small"
          multiline
          minRows={2}
          error={bytes > MAX_NOTE_BYTES}
          helperText={`${bytes}/${MAX_NOTE_BYTES} bytes`}
        />
        {error ? <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Back</Button>
        <Button color="error" variant="contained" onClick={confirm} disabled={busy || bytes > MAX_NOTE_BYTES}>
          {busy ? "Cancelling..." : "Cancel auction"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default CancelAuctionDialog;
