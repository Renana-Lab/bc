// The faucet admin password is typed once per browser session and shared by every card that talks to the faucet
// (Participants gas, Faucet funds, auto-return, messages). It lives in sessionStorage only: it is cleared when the
// tab closes and is never written to localStorage, a URL or a log. A rejected password is dropped again.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsAdminWallet } from "../../real_ethereum/wallets/useIsAdminWallet";
import { getAdminProofHeader } from "./adminGate";

export const SESSION_PASSWORD_KEY = "bc:faucet-admin-password:session";

let memoryPassword = ""; // fallback when sessionStorage is unavailable
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

export const getSessionPassword = () => {
  try {
    const stored = window.sessionStorage.getItem(SESSION_PASSWORD_KEY);
    if (stored !== null) return stored;
  } catch {
    // fall through to the in-memory copy
  }
  return memoryPassword;
};

export const setSessionPassword = (password) => {
  const value = String(password ?? "");
  memoryPassword = value;
  try {
    if (value) window.sessionStorage.setItem(SESSION_PASSWORD_KEY, value);
    else window.sessionStorage.removeItem(SESSION_PASSWORD_KEY);
  } catch {
    // memory copy still works for this page load
  }
  notify();
};

export const clearSessionPassword = () => setSessionPassword("");

export const isUnauthorizedError = (error) => error?.code === "unauthorized" || /wrong password/i.test(String(error?.message || ""));

// Wallet proofs the faucet refused (401, 503 or "not supported" on an older faucet): not tried again until a new proof is signed.
const refusedProofs = new Set();
const isRefusal = (error) => error?.code === "unauthorized" || error?.code === "unavailable";

// { password, hasPassword, usesWallet, hasCredential, remember(pw), forget(), run(typed, action) }
//   run(typedOrEmpty, action) calls action({ password }) with the typed password, else action({ proof }) with the signed-in admin
//   wallet's proof (x-admin-proof), else action({ password }) with the session password. Spread the argument into the client call.
//   A refused proof falls back to the session password when there is one, otherwise it throws so the password field appears.
//   A password that worked is remembered; one the server refused is forgotten, so the field reappears.
export const useFaucetSessionPassword = () => {
  const [password, setPassword] = useState(getSessionPassword);
  const { account } = useIsAdminWallet();
  const [tick, setTick] = useState(0); // bumped when a proof is refused or may have expired
  useEffect(() => {
    const sync = () => { setPassword(getSessionPassword()); setTick((value) => value + 1); };
    listeners.add(sync);
    sync();
    return () => listeners.delete(sync);
  }, []);
  const currentProof = useCallback(() => {
    const proof = account ? getAdminProofHeader(account) : null;
    return proof && !refusedProofs.has(proof) ? proof : null;
  }, [account]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const proof = useMemo(currentProof, [currentProof, tick]);
  const run = useCallback(async (typed, action) => {
    const attempt = async (auth) => {
      try {
        const result = await action(auth);
        if (auth.password && auth.password !== getSessionPassword()) setSessionPassword(auth.password);
        return result;
      } catch (error) {
        if (auth.password && isUnauthorizedError(error)) clearSessionPassword();
        throw error;
      }
    };
    const walletProof = typed ? null : currentProof();
    if (walletProof) {
      try {
        return await action({ proof: walletProof });
      } catch (error) {
        if (!isRefusal(error)) throw error;
        refusedProofs.add(walletProof);
        notify();
        if (!getSessionPassword()) {
          throw Object.assign(new Error(error.code === "unavailable"
            ? "The faucet could not check your admin role right now. Try again, or enter the faucet admin password."
            : "The faucet did not accept your admin wallet. Enter the faucet admin password."), { code: "wallet_refused" });
        }
      }
    }
    const used = typed || getSessionPassword();
    if (!used) {
      setTick((value) => value + 1);
      throw new Error("Enter the faucet admin password.");
    }
    return attempt({ password: used });
  }, [currentProof]);
  return {
    password, hasPassword: Boolean(password), usesWallet: Boolean(proof), hasCredential: Boolean(password) || Boolean(proof),
    remember: setSessionPassword, forget: clearSessionPassword, run,
  };
};
