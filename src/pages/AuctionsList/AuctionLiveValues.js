import { memo } from "react";
import { useSharedClock } from "../../performance/sharedClock";

export const formatTimeLeft = (endTime, now = Date.now()) => {
  if (!Number(endTime)) return "";

  const millisecondsLeft = Number(endTime) - now;
  if (millisecondsLeft <= 0) return "Closed";

  const totalSeconds = Math.max(0, Math.floor(millisecondsLeft / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");

  return days > 0
    ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

export const formatLastUpdated = (updatedAt, now = Date.now()) => {
  if (!updatedAt) return "Waiting for first sync";

  const secondsAgo = Math.max(0, Math.floor((now - Number(updatedAt)) / 1000));
  if (secondsAgo < 5) return "Updated now";
  if (secondsAgo < 60) return `Updated ${secondsAgo}s ago`;
  return `Updated ${Math.floor(secondsAgo / 60)}m ago`;
};

export const AuctionCountdown = memo(function AuctionCountdown({ endTime }) {
  const now = useSharedClock();
  return formatTimeLeft(endTime, now);
});

export const LastUpdatedLabel = memo(function LastUpdatedLabel({ updatedAt }) {
  const now = useSharedClock();
  return formatLastUpdated(updatedAt, now);
});
