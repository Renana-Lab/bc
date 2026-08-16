import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  getActiveAuctionSnapshot,
  refreshActiveAuctionRegistry,
  startActiveAuctionRegistrySync,
} from "../real_ethereum/activeAuctionRegistry";
import {
  getActiveFactoryAddress,
  subscribeToMarketChanges,
} from "../real_ethereum/marketConfig";
import {
  getPresenceAdminRole,
  isPresenceConfigured,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_ROLE_EVENT,
  publishPresenceUpdate,
  sendPresenceHeartbeat,
} from "./presenceClient";

const SitePresence = ({ account, children }) => {
  const location = useLocation();
  const [isAdmin, setIsAdmin] = useState(getPresenceAdminRole());
  const [factoryAddress, setFactoryAddress] = useState(getActiveFactoryAddress());
  const sendingRef = useRef(false);
  const queuedRef = useRef(false);

  useEffect(
    () =>
      subscribeToMarketChanges((market) => {
        setFactoryAddress(market?.address || getActiveFactoryAddress());
      }),
    [],
  );

  useEffect(() => {
    if (!account || !factoryAddress) return undefined;
    return startActiveAuctionRegistrySync(factoryAddress);
  }, [account, factoryAddress]);

  const sendHeartbeat = useCallback(async () => {
    if (!account || !isPresenceConfigured()) return;
    if (sendingRef.current) {
      queuedRef.current = true;
      return;
    }

    sendingRef.current = true;
    try {
      let snapshot = getActiveAuctionSnapshot(factoryAddress);
      if (isAdmin && !document.hidden) {
        try {
          snapshot = await refreshActiveAuctionRegistry(factoryAddress);
        } catch (_) {
          // Presence must never add a failure to the auction experience.
        }
      }

      await sendPresenceHeartbeat({
        account,
        isAdmin,
        route: `${location.pathname}${location.search}`,
        activeAuctions: snapshot ? snapshot.activeAuctions.length : null,
      });
    } catch (error) {
      publishPresenceUpdate({
        ok: false,
        status: "degraded",
        error: error.message || "Live activity is temporarily unavailable.",
      });
    } finally {
      sendingRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        window.setTimeout(sendHeartbeat, 100);
      }
    }
  }, [account, factoryAddress, isAdmin, location.pathname, location.search]);

  useEffect(() => {
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, PRESENCE_HEARTBEAT_MS);
    const handleFocus = () => sendHeartbeat();
    const handleVisibility = () => {
      if (!document.hidden) sendHeartbeat();
    };
    const handleRoleChange = (event) => setIsAdmin(Boolean(event.detail?.isAdmin));

    window.addEventListener("focus", handleFocus);
    window.addEventListener(PRESENCE_ROLE_EVENT, handleRoleChange);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener(PRESENCE_ROLE_EVENT, handleRoleChange);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [sendHeartbeat]);

  return children;
};

export default SitePresence;
