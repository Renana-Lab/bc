// The faucet admin password is typed once per browser session and shared by every card that talks to the faucet
// (Participants gas, Faucet funds, auto-return, messages). It lives in sessionStorage only: it is cleared when the
// tab closes and is never written to localStorage, a URL or a log. A rejected password is dropped again.
import { useCallback, useEffect, useState } from "react";

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

// { password, hasPassword, remember(pw), forget(), run(pw, action) }
//   run(typedOrEmpty, action) uses the typed password, else the session one; it remembers a password that worked
//   and forgets one the server refused, so the field reappears.
export const useFaucetSessionPassword = () => {
  const [password, setPassword] = useState(getSessionPassword);
  useEffect(() => {
    const sync = () => setPassword(getSessionPassword());
    listeners.add(sync);
    sync();
    return () => listeners.delete(sync);
  }, []);
  const run = useCallback(async (typed, action) => {
    const used = typed || getSessionPassword();
    if (!used) throw new Error("Enter the faucet admin password.");
    try {
      const result = await action(used);
      if (used !== getSessionPassword()) setSessionPassword(used);
      return result;
    } catch (error) {
      if (isUnauthorizedError(error)) clearSessionPassword();
      throw error;
    }
  }, []);
  return { password, hasPassword: Boolean(password), remember: setSessionPassword, forget: clearSessionPassword, run };
};
