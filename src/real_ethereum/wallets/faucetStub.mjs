// STUB of the protected faucet (localnet experiments only). Policy: a fixed amount per participant
// code, once. The funding key is NOT part of this module: the caller injects `send`, and any real
// deployment would keep its key in server-side secret storage, never in the repo or the browser.
import { createHash } from "node:crypto";
import { isValidParticipantId } from "./participantId.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export const createFaucet = ({ amountWei, send, claimed = new Map(), allowlist = null }) => {
  if (!(amountWei > 0n)) throw new Error("amountWei must be a positive bigint");
  const funded = new Set([...claimed.values()].map((entry) => entry.address));
  const inFlight = new Set();
  return {
    async claim(pid, address) {
      if (!isValidParticipantId(pid)) throw new Error("Invalid participant code.");
      if (!ADDRESS.test(address || "")) throw new Error("Invalid address.");
      // Only digests are stored, so the table holds no raw participant codes.
      const key = digest(pid);
      if (allowlist && !allowlist.has(key)) throw new Error("Unknown participant code.");
      if (claimed.has(key) || inFlight.has(key)) throw new Error("This participant code already received funds.");
      if (funded.has(address.toLowerCase())) throw new Error("This address already received funds.");
      inFlight.add(key);
      try {
        const hash = await send(address, amountWei);
        claimed.set(key, { address: address.toLowerCase(), hash });
        funded.add(address.toLowerCase());
        return { hash, amountWei };
      } finally {
        inFlight.delete(key);
      }
    },
    digestOf: digest,
  };
};
