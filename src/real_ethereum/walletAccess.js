import { setWalletSessionAccount } from "../telemetry/walletSession";

const ACCOUNT = /^0x[0-9a-fA-F]{40}$/;
const TIMEOUT = 3000;
const listeners = new Set();
const announcements = new Map();
let snapshot = { status: "checking", account: "", provider: null, verifiedAt: 0, reason: "" };
let generation = 0;
let pending = null;
let timer;
let expiry;
let users = 0;
let discovering = false;
let boundProvider = null;

export const getWalletAccess = () => snapshot;
export const subscribeWalletAccess = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const publish = (status, fields = {}) => {
  snapshot = { ...snapshot, status, account: "", verifiedAt: 0, ...fields };
  setWalletSessionAccount(status === "connected" ? snapshot.account : "");
  listeners.forEach((listener) => listener());
};
const invalidate = (status = "checking", reason = "") => {
  generation += 1;
  pending = null;
  clearTimeout(expiry);
  publish(status, { reason });
};
const announce = (event) => {
  const { info, provider } = event.detail || {};
  if (!info?.rdns || !provider?.request) return;
  announcements.set(provider, info.rdns);
  reconcileProvider();
};
export const discoverWalletProvider = () => {
  if (typeof window === "undefined") return null;
  if (!discovering) {
    discovering = true;
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  const announced = [...announcements].filter(([, rdns]) => rdns === "io.metamask");
  if (announced.length) return announced.length === 1 ? announced[0][0] : null;
  if (announcements.size) return null;
  const injected = window.ethereum?.providers || [window.ethereum];
  const eligible = [...new Set(injected)].filter((provider) =>
    provider?.isMetaMask && typeof provider?.request === "function" &&
    typeof provider?._metamask?.isUnlocked === "function");
  return eligible.length === 1 ? eligible[0] : null;
};
const changed = () => { invalidate(); void verifyWalletAccess(); };
const disconnected = () => invalidate("unavailable", "MetaMask disconnected. Unlock it and reconnect.");
const reconcileProvider = () => {
  const provider = discoverWalletProvider();
  if (provider !== boundProvider) {
    for (const event of ["accountsChanged", "chainChanged", "disconnect"]) {
      boundProvider?.removeListener?.(event, event === "disconnect" ? disconnected : changed);
    }
    boundProvider = provider;
    invalidate("checking");
    snapshot = { ...snapshot, provider };
    if (users) {
      for (const event of ["accountsChanged", "chainChanged", "disconnect"]) {
        provider?.on?.(event, event === "disconnect" ? disconnected : changed);
      }
    }
  }
  return provider;
};
const deadline = (promise) => new Promise((resolve, reject) => {
  const id = setTimeout(() => reject(new Error("MetaMask verification timed out. Open the extension and retry.")), TIMEOUT);
  Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(id));
});
export const verifyWalletAccess = () => {
  const provider = reconcileProvider();
  if (pending) return pending;
  if (!provider) {
    publish("unavailable", { provider: null, reason: "A verifiable MetaMask extension was not detected. Enable it for this site and retry." });
    return Promise.resolve(snapshot);
  }
  if (document.hidden) return Promise.resolve(snapshot);
  const epoch = generation;
  const task = (async () => {
    try {
      if (typeof provider._metamask?.isUnlocked !== "function") {
        throw new Error("This wallet cannot verify its unlock state. Update the MetaMask extension and retry.");
      }
      const result = await deadline((async () => {
        const unlocked = await provider._metamask.isUnlocked();
        if (unlocked !== true) return { status: unlocked === false ? "locked" : "verification-failed" };
        const accounts = await provider.request({ method: "eth_accounts" });
        if (!Array.isArray(accounts) || accounts.some((account) => !ACCOUNT.test(account))) {
          throw new Error("MetaMask returned an invalid account response.");
        }
        if (!accounts.length) return { status: "unauthorized" };
        if (await provider._metamask.isUnlocked() !== true) return { status: "locked" };
        return { status: "connected", account: accounts[0] };
      })());
      if (generation !== epoch) return snapshot;
      if (document.hidden || discoverWalletProvider() !== provider) {
        invalidate("checking");
        return snapshot;
      }
      const reasons = { locked: "Unlock MetaMask to continue.", unauthorized: "Connect an account to this website in MetaMask.", "verification-failed": "MetaMask unlock state could not be verified." };
      clearTimeout(expiry);
      publish(result.status, { provider, account: result.account || "", verifiedAt: result.status === "connected" ? Date.now() : 0, reason: reasons[result.status] || "" });
      if (result.status === "connected") expiry = setTimeout(() => invalidate("verification-failed", "Wallet verification expired. Retry the connection."), TIMEOUT);
    } catch (error) {
      if (generation === epoch) invalidate("verification-failed", "MetaMask verification failed or timed out. Unlock or update the extension and retry.");
    }
    return snapshot;
  })();
  pending = task;
  task.finally(() => { if (pending === task) pending = null; });
  return task;
};
const suspend = () => invalidate("checking");
const resume = () => { suspend(); void verifyWalletAccess(); };
const visibility = () => document.hidden ? suspend() : resume();
export const startWalletAccess = () => {
  users += 1;
  if (users === 1) {
    // Rebind after Strict Mode's setup/cleanup cycle.
    boundProvider = null;
    void verifyWalletAccess();
    timer = setInterval(() => { if (!document.hidden) void verifyWalletAccess(); }, 1000);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("pagehide", suspend);
    document.addEventListener("visibilitychange", visibility);
  }
  return () => {
    users -= 1;
    if (users) return;
    clearInterval(timer);
    suspend();
    for (const event of ["accountsChanged", "chainChanged", "disconnect"]) boundProvider?.removeListener?.(event, event === "disconnect" ? disconnected : changed);
    boundProvider = null;
    window.removeEventListener("focus", resume);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("pagehide", suspend);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("eip6963:announceProvider", announce);
    announcements.clear();
    discovering = false;
  };
};
export const requireWalletAccess = async () => {
  const result = await verifyWalletAccess();
  if (result.status !== "connected" || document.hidden || Date.now() - result.verifiedAt >= TIMEOUT) {
    throw new Error(result.reason || "Verify your MetaMask connection before continuing.");
  }
  return result;
};
export const walletDiagnostic = () => JSON.stringify({
  build: process.env.REACT_APP_BUILD_ID || [...document.scripts].map((script) => script.src).find((src) => /main\.|\/assets\/index/.test(src)) || "local",
  browser: navigator.userAgent,
  provider: announcements.get(snapshot.provider) || (snapshot.provider ? "legacy-metamask" : "none"),
  status: snapshot.status, verifiedAt: snapshot.verifiedAt,
  reason: snapshot.reason.replace(/0x[0-9a-f]+/gi, "[redacted]"),
}, null, 2);
