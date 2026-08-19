import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  getActiveFactoryAddress,
  subscribeToMarketChanges,
} from "../real_ethereum/marketConfig";
import {
  BOTNET_STATE_EVENT,
  getRunningBotDescriptors,
} from "./botPresence";
import {
  getPresenceAdminRole,
  isPresenceConfigured,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_ROLE_EVENT,
  publishPresenceUpdate,
  sendPresenceHeartbeat,
} from "./presenceClient";
import {
  getWalletSessionAccount,
  subscribeToWalletSession,
} from "./walletSession";

const isChainRoute = (pathname) =>
  /^\/(auctions-list|auction\/|open-auction|manage-budget)/.test(pathname);

const PresenceCoordinator = () => {
  const location = useLocation();
  const [account, setAccount] = useState(getWalletSessionAccount());
  const [isAdmin, setIsAdmin] = useState(getPresenceAdminRole());
  const [factoryAddress, setFactoryAddress] = useState(getActiveFactoryAddress());
  const sendingRef = useRef(false);
  const registryModuleRef = useRef(null);
  const registryStopRef = useRef(null);

  useEffect(
    () =>
      subscribeToMarketChanges((market) => {
        setFactoryAddress(market?.address || getActiveFactoryAddress());
      }),
    [],
  );

  useEffect(() => subscribeToWalletSession(setAccount), []);

  useEffect(() => {
    const handleRoleChange = (event) => setIsAdmin(Boolean(event.detail?.isAdmin));
    window.addEventListener(PRESENCE_ROLE_EVENT, handleRoleChange);
    return () => window.removeEventListener(PRESENCE_ROLE_EVENT, handleRoleChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    registryStopRef.current?.();
    registryStopRef.current = null;

    if (!account || !factoryAddress || !isChainRoute(location.pathname)) {
      return undefined;
    }

    import("../real_ethereum/activeAuctionRegistry")
      .then((registry) => {
        if (cancelled) return;
        registryModuleRef.current = registry;
        if (location.pathname !== "/auctions-list") {
          registryStopRef.current = registry.startActiveAuctionRegistrySync(factoryAddress);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      registryStopRef.current?.();
      registryStopRef.current = null;
    };
  }, [account, factoryAddress, location.pathname]);

  const sendHeartbeat = useCallback(async () => {
    if (sendingRef.current || !isPresenceConfigured()) return;
    const bots = getRunningBotDescriptors();
    if (document.hidden && !bots.length) return;
    if (!account && !bots.length) return;

    sendingRef.current = true;
    try {
      const snapshot = registryModuleRef.current?.getActiveAuctionSnapshot(factoryAddress);
      await sendPresenceHeartbeat({
        account,
        isAdmin,
        route: `${location.pathname}${location.search}`,
        bots,
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
    }
  }, [account, factoryAddress, isAdmin, location.pathname, location.search]);

  useEffect(() => {
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, PRESENCE_HEARTBEAT_MS);
    const handleFocus = () => sendHeartbeat();
    const handleVisibility = () => {
      if (!document.hidden) sendHeartbeat();
    };
    window.addEventListener("focus", handleFocus);
    window.addEventListener(BOTNET_STATE_EVENT, sendHeartbeat);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener(BOTNET_STATE_EVENT, sendHeartbeat);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [sendHeartbeat]);

  return null;
};

export default PresenceCoordinator;
