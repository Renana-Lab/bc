// Tiny bus: "these auctions were just seen" (list refresh) or "this auction was just closed" (finalize).
// The auto-withdraw code listens; nothing here touches the chain.
const listeners = new Set();

export const subscribeAuctionObservations = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// `auctions`: list items ({ address, closed, manager, highestBidder, addresses, isRefunded }) or minimal
// { address, closed: true, probe: true } entries, which the listener checks on chain.
export const observeAuctions = (auctions, account = "") => {
  if (!Array.isArray(auctions) || !auctions.length) return;
  listeners.forEach((listener) => {
    try { listener(auctions, account); } catch { /* ignore */ }
  });
};
