// Admin Zone "Auction list history" card (marketplace parity): pick a time, see the auctions that were active then.
import { useState } from "react";
import { Alert, Box, Button, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import AdminCard, { adminHeadCellSx } from "./AdminCard";
import { createChainLogReader } from "./adminAuditReader";
import { readAuctionListState } from "./auctionListHistory";
import { shortAddress } from "./reportUtils";

export const AuctionListHistoryCard = ({ defaultOpen = false, readState = readAuctionListState, createReader = createChainLogReader }) => {
  const [time, setTime] = useState("");
  const [state, setState] = useState({ loading: false, error: "", result: null, at: null });

  const inspect = async (event) => {
    event.preventDefault();
    const atMs = new Date(time).getTime();
    if (!Number.isFinite(atMs)) return;
    setState({ loading: true, error: "", result: null, at: atMs });
    try {
      const factoryAddress = getActiveFactoryAddress();
      const result = await readState({ atSec: Math.floor(atMs / 1000), factoryAddress, reader: createReader(factoryAddress) });
      setState({ loading: false, error: "", result, at: atMs });
    } catch (error) {
      setState({ loading: false, error: error?.message || "Could not read the chain history.", result: null, at: atMs });
    }
  };

  const { result } = state;
  return (
    <AdminCard title="Auction list history" defaultOpen={defaultOpen}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
        Rebuilt from chain events (creations, bids, early closes and cancellations), not from this browser's cache.
      </Typography>
      <form onSubmit={inspect} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <TextField
          name="time" label="State at" type="datetime-local" required size="small"
          InputLabelProps={{ shrink: true }} value={time} onChange={(event) => setTime(event.target.value)}
        />
        <Button type="submit" variant="outlined" disabled={state.loading || !time} sx={{ borderRadius: "20px" }}>
          {state.loading ? "Reading..." : "Inspect state"}
        </Button>
      </form>
      {state.error ? <Alert severity="error" sx={{ mt: 1 }}>{state.error}</Alert> : null}
      {result ? (
        <Box sx={{ mt: 2 }}>
          <p style={{ color: "#002884", fontWeight: 600 }}>
            {new Date(state.at).toLocaleString()} / {result.rows.length} active auction{result.rows.length === 1 ? "" : "s"}
          </p>
          {result.outOfRange ? (
            <Alert severity="warning" data-testid="history-out-of-range">
              That time is older than the loaded range (the last {result.lookback} blocks, from block {result.from}), so the state cannot be rebuilt.
            </Alert>
          ) : null}
          {result.healthNote ? <Alert severity="warning" sx={{ mt: 1 }} data-testid="history-incomplete">History incomplete: {result.healthNote}.</Alert> : null}
          {!result.outOfRange ? (
            <Typography variant="caption" color="text.secondary" display="block">
              Auctions created before block {result.from} are not included (events from the last {result.lookback} blocks).
            </Typography>
          ) : null}
          <div className="tableScrollWrap">
            <Table size="small">
              <TableHead>
                <TableRow>
                  {["Auction", "Highest bid", "End time"].map((name) => (
                    <TableCell key={name} align="center" sx={adminHeadCellSx}>{name}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {result.rows.map((row) => (
                  <TableRow key={row.address}>
                    <TableCell align="center">{row.description} <small title={row.address}>({shortAddress(row.address)})</small></TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700 }}>{row.highestBid}</TableCell>
                    <TableCell align="center">{new Date(row.endTimeSec * 1000).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {!result.rows.length ? <TableRow><TableCell colSpan={3} align="center">No auctions were active at that time.</TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </div>
        </Box>
      ) : null}
    </AdminCard>
  );
};

export default AuctionListHistoryCard;
