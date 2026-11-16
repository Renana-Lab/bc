import { useEffect, useState } from "react";
import { chainNowMs } from "../../real_ethereum/chainClock";
import { formatCountdown } from "./adminCardData";

// One shared one-second tick for a whole table (not one timer per row). `enabled` pauses it for closed cards.
export const useChainNowSec = (enabled = true) => {
  const [now, setNow] = useState(() => Math.floor(chainNowMs() / 1000));
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Math.floor(chainNowMs() / 1000));
    const id = window.setInterval(() => {
      if (!document.hidden) setNow(Math.floor(chainNowMs() / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
};

export const Countdown = ({ endTime, nowSec }) => <span>{formatCountdown(endTime, nowSec)}</span>;
