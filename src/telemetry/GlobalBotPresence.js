import { useCallback, useEffect, useRef } from "react";
import { BOTNET_STATE_EVENT, getRunningBotDescriptors } from "./botPresence";
import {
  isPresenceConfigured,
  PRESENCE_HEARTBEAT_MS,
  sendPresenceHeartbeat,
} from "./presenceClient";

const GlobalBotPresence = ({ route = "/" }) => {
  const sendingRef = useRef(false);

  const sendHeartbeat = useCallback(async () => {
    if (sendingRef.current || !isPresenceConfigured()) return;
    const bots = getRunningBotDescriptors();
    if (!bots.length) return;

    sendingRef.current = true;
    try {
      await sendPresenceHeartbeat({ route, bots });
    } catch (_) {
      // Bot telemetry is observational and must never interrupt bot execution.
    } finally {
      sendingRef.current = false;
    }
  }, [route]);

  useEffect(() => {
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, PRESENCE_HEARTBEAT_MS);
    window.addEventListener(BOTNET_STATE_EVENT, sendHeartbeat);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(BOTNET_STATE_EVENT, sendHeartbeat);
    };
  }, [sendHeartbeat]);

  return null;
};

export default GlobalBotPresence;
