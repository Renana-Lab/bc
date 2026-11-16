// Admin-controlled display flags for the auctions list: `hidden` (UI-only, stored on the factory) and
// `cancelled` (final, stored on the auction). Nothing here touches payloads or contract logic.
import { useEffect, useMemo, useRef, useState } from "react";
import { readCancelledSet, readHiddenSet, useFactoryAdminStatus } from "../../real_ethereum/adminChain";

const lower = (value) => String(value ?? "").toLowerCase();

// Hidden auctions disappear for everyone except on-chain admins, who see them with a badge.
export const filterHiddenAuctions = (auctions, hiddenSet, isAdmin) =>
  isAdmin || !hiddenSet?.size ? auctions : auctions.filter((auction) => !hiddenSet.has(lower(auction.address)));

export const auctionBadges = ({ hidden, cancelled }) => [cancelled ? "Cancelled" : "", hidden ? "Hidden" : ""].filter(Boolean);

const EMPTY = new Set();

// Re-reads when the set of listed auctions changes (that is every list refresh cycle), so a hide or cancel
// shows up within one refresh.
export const useAuctionAdminFlags = (auctions, { hiddenReader = readHiddenSet, cancelledReader = readCancelledSet, adminReader } = {}) => {
  const { onChainAdmin } = useFactoryAdminStatus(adminReader ? { reader: adminReader } : {});
  const [flags, setFlags] = useState({ hidden: EMPTY, cancelled: EMPTY });
  const requestRef = useRef(0);

  const addresses = useMemo(
    () => auctions.filter((auction) => !auction.isReadPlaceholder).map((auction) => auction.address),
    [auctions]
  );
  const closedAddresses = useMemo(
    () => auctions.filter((auction) => !auction.isReadPlaceholder && auction.closed).map((auction) => auction.address),
    [auctions]
  );
  const key = `${addresses.join(",")}|${closedAddresses.length}`;

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!addresses.length) {
      setFlags({ hidden: EMPTY, cancelled: EMPTY });
      return;
    }
    Promise.all([
      Promise.resolve(hiddenReader(addresses)).catch(() => null),
      Promise.resolve(cancelledReader(closedAddresses)).catch(() => null),
    ]).then(([hidden, cancelled]) => {
      if (requestId !== requestRef.current) return;
      // A failed read keeps the previous answer instead of un-hiding everything.
      setFlags((current) => ({ hidden: hidden || current.hidden, cancelled: cancelled || current.cancelled }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { hidden: flags.hidden, cancelled: flags.cancelled, isAdmin: onChainAdmin };
};
