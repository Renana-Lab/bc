// "Dynamic active-auction list": the auctions in the shared active-auction registry (already synced site-wide,
// so this card makes no RPC reads of its own), with the same admin icons as the auctions list.
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Box, Button, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import StopIcon from "@mui/icons-material/Stop";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import { getActiveAuctionSnapshot, subscribeActiveAuctionRegistry } from "../../real_ethereum/activeAuctionRegistry";
import AdminCard, { adminHeadCellSx } from "./AdminCard";
import AdminIconAction from "./AdminIconAction";
import StatusLabel from "./AuctionStatusLabel";
import { Countdown, useChainNowSec } from "./AdminCountdown";
import { getAdminActionAvailability } from "./adminCardData";
import { shortAddress } from "./reportUtils";
import useAuctionAdminDialogs from "./useAuctionAdminDialogs";

const lower = (value) => String(value ?? "").toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

export const registryRows = (snapshot) =>
  [...(snapshot?.activeAuctions || []), ...(snapshot?.finalizableAuctions || [])].map((auction) => ({
    address: auction.address,
    description: auction.description || "",
    minimum: String(auction.minimumContribution ?? ""),
    highestBid: String(auction.highestBid ?? "0"),
    bidders: Number(auction.approversCount || 0),
    manager: auction.manager,
    endTime: Number(auction.endTimeSec || 0),
    closed: Boolean(auction.closed),
    hasBids: Number(auction.approversCount || 0) > 0 || (Boolean(auction.highestBidder) && lower(auction.highestBidder) !== ZERO),
    cancelled: false,
    hidden: false,
  }));

const Tile = ({ label, value, background, border, labelColor, valueColor }) => (
  <Box sx={{ p: 1, borderRadius: 2, background, border: `1px solid ${border}`, textAlign: "center" }}>
    <small style={{ color: labelColor, fontWeight: 700 }}>{label}</small>
    <div style={{ fontSize: "1.25rem", fontWeight: 800, color: valueColor }}>{value}</div>
  </Box>
);

export const ActiveAuctionListCard = ({ canWrite = false, actions, snapshotReader = () => getActiveAuctionSnapshot(getActiveFactoryAddress()), defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const [snapshot, setSnapshot] = useState(() => snapshotReader());
  const nowSec = useChainNowSec(open);
  useEffect(() => subscribeActiveAuctionRegistry(() => setSnapshot(snapshotReader())), [snapshotReader]);
  const dialogs = useAuctionAdminDialogs({ actions, canWrite, onChanged: () => setSnapshot(snapshotReader()) });
  const rows = useMemo(() => registryRows(snapshot), [snapshot]);
  const active = rows.filter((row) => !row.closed && row.endTime > nowSec).length;

  return (
    <AdminCard title="Dynamic active-auction list" open={open} onToggle={() => setOpen((value) => !value)}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, 1fr)", sm: "repeat(4, 1fr)" }, gap: 1, mb: 2 }}>
        <Tile label="Active" value={active} background="#eaf8f1" border="#b7e4c7" labelColor="#0f6d45" valueColor="#168052" />
        <Tile label="Total listed" value={rows.length} background="#f0f3f9" border="#d9dff2" labelColor="#5e638a" valueColor="#002884" />
      </Box>
      <Typography variant="caption" color="text.secondary" display="block">
        Read from the shared auction registry, so this list adds no extra RPC load. Ended auctions stay listed until they are finalized.
      </Typography>
      <div className="tableScrollWrap">
        <Table size="small">
          <TableHead>
            <TableRow>
              {["Description", "End date", "Countdown", "Highest bid", "Bidders", "Action"].map((name) => (
                <TableCell key={name} align="center" sx={adminHeadCellSx}>{name}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const can = getAdminActionAvailability(row, nowSec);
              return (
                <TableRow key={row.address} data-testid={`active-row-${row.address}`}>
                  <TableCell align="center">
                    <strong>{row.description || shortAddress(row.address)}</strong> <StatusLabel status={can.status} />
                    <br />
                    <small title={row.address}>{shortAddress(row.address)}</small>
                  </TableCell>
                  <TableCell align="center">{row.endTime ? new Date(row.endTime * 1000).toLocaleString() : "-"}</TableCell>
                  <TableCell align="center"><Countdown endTime={row.endTime} nowSec={nowSec} /></TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>{row.highestBid}</TableCell>
                  <TableCell align="center">{row.bidders}</TableCell>
                  <TableCell align="center" sx={{ whiteSpace: "nowrap" }}>
                    <Button component={RouterLink} to={`/auction/${row.address}`} size="small">View</Button>
                    <AdminIconAction title={`Cancel auction: ${row.description || row.address}`} disabled={!canWrite || !can.cancel} onClick={() => dialogs.openCancel(row)}>
                      <DeleteOutlineIcon color={canWrite && can.cancel ? "error" : "disabled"} />
                    </AdminIconAction>
                    <AdminIconAction title="Close auction early" disabled={!canWrite || !can.closeNow} onClick={() => dialogs.closeEarly(row.address)}>
                      <StopIcon color={canWrite && can.closeNow ? "error" : "disabled"} />
                    </AdminIconAction>
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows.length ? <TableRow><TableCell colSpan={6} align="center">No active auctions in the registry.</TableCell></TableRow> : null}
          </TableBody>
        </Table>
      </div>
      {dialogs.dialogs}
    </AdminCard>
  );
};

export default ActiveAuctionListCard;
