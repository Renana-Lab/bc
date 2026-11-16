import { subscribeAuctionObservations } from "../auctionObserver.mjs";

// Automatic withdrawals for the invisible wallet: once an auction is closed, a participant's refund or a seller's
// deferred payment is claimed without any button. One attempt per auction per page load, one at a time, silent.
const same = (left, right) => Boolean(left && right) && String(left).toLowerCase() === String(right).toLowerCase();

// Does a list item concern this account? (Minimal "probe" entries always do: they are checked on chain.)
export const concernsAccount = (auction, account) =>
  Boolean(auction?.probe) ||
  same(auction?.manager, account) ||
  same(auction?.highestBidder, account) ||
  Boolean(auction?.addresses?.some((entry) => same(entry, account)));

// `readState(address, account)` -> { closed, cancelled, manager, participated, bid (bigint), isHighestBidder, sellerOwed (bigint) }
// `withdrawRefund(address, account)` / `withdrawSeller(address, account)` send the transactions.
export const createAutoWithdraw = ({ readState, withdrawRefund, withdrawSeller, getAccount, onError = () => {} }) => {
  const handled = new Set(); // auction addresses attempted in this page load
  const blocked = new Set(); // auctions with something due that could not be withdrawn (yet)
  let queue = Promise.resolve();

  const process = async (address, account) => {
    blocked.delete(address);
    const state = await readState(address, account);
    if (!state?.closed) { handled.delete(address); return; } // a stale list entry: look again at the next refresh
    // A cancelled auction refunds everyone, including the leader; otherwise the winner has nothing to withdraw.
    const refundDue = state.participated && state.bid > 0n && (state.cancelled || !state.isHighestBidder);
    const sellerDue = same(state.manager, account) && state.sellerOwed > 0n;
    // "Nothing to withdraw" and every other failure are ignored: the next page load looks again.
    if (sellerDue) await withdrawSeller(address, account).catch((error) => { blocked.add(address); onError(error); });
    if (refundDue) await withdrawRefund(address, account).catch((error) => { blocked.add(address); onError(error); });
  };

  const handle = (auctions, account) => {
    const me = getAccount?.() || account;
    if (!me) return;
    for (const auction of auctions) {
      if (!auction?.address || !auction.closed || auction.isReadPlaceholder) continue;
      if (auction.isRefunded && !same(auction.manager, me)) continue; // already refunded
      if (!concernsAccount(auction, me)) continue;
      const key = String(auction.address).toLowerCase();
      if (handled.has(key)) continue;
      handled.add(key);
      queue = queue.then(() => process(auction.address, me)).catch(onError);
    }
  };

  // Before the participant's balance is swept: finish every queued withdrawal, retry the ones that failed once, and say
  // whether anything is still waiting (false = do not sweep).
  const drain = async () => {
    await queue;
    for (const address of [...blocked]) queue = queue.then(() => process(address, getAccount?.())).catch(onError);
    await queue;
    return blocked.size === 0;
  };

  const stop = subscribeAuctionObservations(handle);
  return { handle, stop, handled, blocked, drain, idle: () => queue };
};
