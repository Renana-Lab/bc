// Read helpers for the factory admin role and the per-auction admin flags.
// Writes live in pages/ManageBudget/adminActions.js. Nothing here touches auction payloads.
import { useEffect, useRef, useState } from "react";
import { readOnlyCall } from "./readOnly";
import { getWalletAccess, subscribeWalletAccess } from "./walletAccess";

const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };
const lower = (value) => String(value ?? "").toLowerCase();
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value ?? ""));

export const readIsFactoryAdmin = async (account, options = READ_OPTIONS) => {
  if (!isAddress(account)) return false;
  return Boolean(await readOnlyCall(({ factory }) => factory.methods.isAdmin(account), 1, options));
};

export const readFactoryOwner = async (options = READ_OPTIONS) =>
  lower(await readOnlyCall(({ factory }) => factory.methods.owner(), 1, options));

// -> Set of lowercase campaign addresses the admin has hidden. Chunked to keep eth_call small.
export const readHiddenSet = async (addresses, { chunk = 100, options = READ_OPTIONS } = {}) => {
  const hidden = new Set();
  for (let start = 0; start < addresses.length; start += chunk) {
    const part = addresses.slice(start, start + chunk);
    const flags = await readOnlyCall(({ factory }) => factory.methods.getHiddenFlags(part), 1, options);
    part.forEach((address, index) => {
      if (flags[index]) hidden.add(lower(address));
    });
  }
  return hidden;
};

// cancelled() is read per auction, so callers pass only closed auctions. Cancelled is final, so
// positive AND negative answers for closed auctions are cached for the session.
const cancelledCache = new Map();
export const resetCancelledCache = () => cancelledCache.clear();

export const readCancelledSet = async (addresses, { options = READ_OPTIONS } = {}) => {
  const cancelled = new Set();
  await Promise.all(
    addresses.map(async (address) => {
      const key = lower(address);
      if (!cancelledCache.has(key)) {
        try {
          const value = Boolean(await readOnlyCall(({ campaign }) => campaign(address).methods.cancelled(), 1, options));
          cancelledCache.set(key, value);
        } catch (_) {
          return; // unknown: treated as not cancelled until a later read succeeds
        }
      }
      if (cancelledCache.get(key)) cancelled.add(key);
    })
  );
  return cancelled;
};

const connectedAccount = () => {
  const access = getWalletAccess();
  return access.status === "connected" ? access.account : "";
};

// On-chain admin status of the connected wallet. `refreshKey` re-reads (for example on each list refresh).
export const useFactoryAdminStatus = ({ reader = readIsFactoryAdmin, refreshKey = 0 } = {}) => {
  const [account, setAccount] = useState(connectedAccount);
  const [onChainAdmin, setOnChainAdmin] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => subscribeWalletAccess(() => setAccount(connectedAccount())), []);
  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!account) {
      setOnChainAdmin(false);
      return;
    }
    reader(account).then(
      (value) => requestId === requestRef.current && setOnChainAdmin(Boolean(value)),
      () => requestId === requestRef.current && setOnChainAdmin(false)
    );
  }, [account, reader, refreshKey]);

  return { account, onChainAdmin };
};
