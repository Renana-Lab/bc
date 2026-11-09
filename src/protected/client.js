import { getDeliveryKey } from "./keys";
import { getEthereumProvider } from "../real_ethereum/ethereumProvider";
import { getActiveFactoryAddress } from "../real_ethereum/marketConfig";
import { getWalletAccess, requireWalletAccess, subscribeWalletAccess } from "../real_ethereum/walletAccess";

export const protectedMarketEnabled = process.env.REACT_APP_PROTECTED_MARKET === "true";
let worker;
let nextId = 0;
let generation = 0;
let session;
let sessionPending;
let sessionExpiry;
let configPromise;
const pending = new Map();
const listeners = new Set();
const preparations = new Map();
const encryptedStages = new Map();
const creations = new Map();
let observedProvider;
const providerRevoked = () => clearProtectedSession();
const observeProvider = provider => {
  if (provider === observedProvider) return;
  for (const event of ["chainChanged", "accountsChanged", "disconnect"]) observedProvider?.removeListener?.(event, providerRevoked);
  observedProvider = provider;
  for (const event of ["chainChanged", "accountsChanged", "disconnect"]) provider?.on?.(event, providerRevoked);
};

export const clearProtectedSession = () => {
  generation += 1;
  session = undefined;
  clearTimeout(sessionExpiry);
  sessionPending = undefined;
  preparations.clear();
  encryptedStages.clear();
  creations.clear();
  worker?.terminate();
  worker = undefined;
  for (const task of pending.values()) task.reject(new Error("Wallet session changed"));
  pending.clear();
  listeners.forEach(listener => listener());
};
export const subscribeProtectedRevocation = listener => { listeners.add(listener); return () => listeners.delete(listener); };
let walletIdentity = getWalletAccess().status === "connected" ? getWalletAccess().account.toLowerCase() : "";
let walletProvider = getEthereumProvider();
if (protectedMarketEnabled) subscribeWalletAccess(() => {
  const current = getWalletAccess();
  // Focus changes while MetaMask signs are not an account revocation. The route
  // gate still covers content; fresh verification is required after signing.
  if (current.status === "checking") return;
  const identity = current.status === "connected" ? current.account.toLowerCase() : "";
  const provider = getEthereumProvider();
  if (identity !== walletIdentity || provider !== walletProvider) {
    walletIdentity = identity; walletProvider = provider; clearProtectedSession(); observeProvider(provider);
  }
});

const cryptoOperation = (action, args = []) => new Promise((resolve, reject) => {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id);
      if (!task) return;
      pending.delete(data.id);
      data.error ? task.reject(new Error(data.error)) : task.resolve(data.result);
    };
    worker.onerror = () => clearProtectedSession();
  }
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, action, args });
});

const api = async (path, body, token) => {
  const base = (process.env.REACT_APP_PROTECTED_API_URL || "").replace(/\/$/, "");
  if (!base || (!base.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(base))) {
    throw new Error("Protected storage is not configured securely");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) {
      const messages = {
        untrusted_auction: "The auction is not yet confirmed on this marketplace. Please retry after the network confirmations.",
        not_authorized: "Only the seller or the confirmed winning buyer can open this information.",
        awaiting_confirmation: "Settlement is still being confirmed on Sepolia. No signature is needed. Please try again shortly.",
        delivery_key_recovery_required: "The original delivery key is not available in this browser. Recover access with the same wallet.",
        payload_unavailable: "The encrypted information is not ready. No data was released; please retry shortly.",
        payload_key_mismatch: "The encrypted data could not be verified. Your auction was not created. Please try again.",
        service_unavailable: "The network or protected storage is temporarily unavailable. Please retry shortly.",
        challenge_expired: "Wallet verification expired. Please retry and confirm the new request in MetaMask.",
      };
      const error = new Error(messages[result.error] || result.message || result.error || "Protected storage request failed");
      error.status = response.status;
      error.code = result.error;
      throw error;
    }
    return result;
  } finally { clearTimeout(timer); }
};

const identity = async (expectedWallet) => {
  const access = await requireWalletAccess();
  if (expectedWallet && expectedWallet.toLowerCase() !== access.account.toLowerCase()) throw new Error("Wallet changed");
  const provider = getEthereumProvider();
  observeProvider(provider);
  const chainId = Number(await provider.request({ method: "eth_chainId" }));
  const config = await (configPromise || (configPromise = api("/config").catch(error => { configPromise = undefined; throw error; })));
  const factory = getActiveFactoryAddress();
  if (chainId !== Number(config.chainId) || factory.toLowerCase() !== String(config.factory).toLowerCase()) throw new Error("Protected network configuration mismatch");
  const key = await getDeliveryKey(access.account, chainId, () => cryptoOperation("generate"));
  return { wallet: access.account, chainId, factory, provider, config, key };
};

const authenticate = async (owner) => {
  if (session && session.wallet === owner.wallet.toLowerCase() && session.expiresAt > Date.now() + 5000) return session;
  if (!sessionPending) {
    const epoch = generation;
    sessionPending = (async () => {
      const challenge = await api("/challenge", { wallet: owner.wallet, publicKey: owner.key.publicKey });
      const signature = await owner.provider.request({ method: "eth_signTypedData_v4", params: [owner.wallet, JSON.stringify(challenge.typedData)] });
      const access = await requireWalletAccess();
      if (access.account.toLowerCase() !== owner.wallet.toLowerCase() || getEthereumProvider() !== owner.provider || Number(await owner.provider.request({ method: "eth_chainId" })) !== owner.chainId) throw new Error("Wallet changed during signing");
      const result = await api("/session", { challengeId: challenge.challengeId, signature });
      if (epoch !== generation) throw new Error("Wallet session changed");
      session = { ...result, wallet: owner.wallet.toLowerCase(), expiresAt: Number(result.expiresAt) * 1000 };
      clearTimeout(sessionExpiry);
      sessionExpiry = setTimeout(clearProtectedSession, Math.max(0, session.expiresAt - Date.now()));
      sessionExpiry.unref?.();
      return session;
    })().finally(() => { if (epoch === generation) sessionPending = undefined; });
  }
  return sessionPending;
};

// This path only touches local key storage: bidding never waits for KMS or the API.
export const getBidKeyFingerprint = async (wallet, chainId) => {
  if (Number(chainId) !== 11155111) throw new Error("Switch MetaMask to Sepolia before bidding.");
  const key = await getDeliveryKey(wallet, chainId, () => cryptoOperation("generate"));
  return key.fingerprint;
};

export const prepareProtectedAuction = async ({ wallet, text, operationId, onProgress = () => {} }) => {
  const owner = await identity(wallet);
  const epoch = generation;
  const auth = await authenticate(owner);
  // A digest avoids retaining plaintext in a retry cache.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const cacheKey = `${owner.wallet}:${operationId || crypto.randomUUID()}:${Array.from(new Uint8Array(digest)).join(",")}`;
  if (preparations.has(cacheKey)) return preparations.get(cacheKey);
  let stage = encryptedStages.get(cacheKey);
  if (!stage) {
    onProgress("Encrypting data");
    const nonce = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("");
    const context = { chainId: owner.chainId, factory: owner.factory, seller: owner.wallet, nonce };
    const sealed = await cryptoOperation("seal", [text, context, owner.config.publicKey]);
    if (epoch !== generation) throw new Error("Wallet session changed");
    stage = { nonce, sealed, uploaded: false, id: null };
    encryptedStages.set(cacheKey, stage);
  }
  const { nonce, sealed } = stage;
  onProgress("Uploading encrypted data");
  const envelopeBody = JSON.stringify(sealed.envelope);
  if (!stage.uploaded) {
    const upload = await api("/uploads", { nonce, ciphertextHash: sealed.ciphertextHash, wrappedKey: sealed.wrappedKey, envelopeBytes: new TextEncoder().encode(envelopeBody).byteLength }, auth.token);
    stage.id = upload.id;
    if (!upload.ready) {
      const response = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.headers || { "Content-Type": "application/json" }, body: envelopeBody });
      if (!response.ok) throw new Error("Encrypted upload failed. Your auction has not been created.");
    }
    stage.uploaded = true;
  }
  const completed = await api(`/uploads/${encodeURIComponent(stage.id)}/complete`, {}, auth.token).catch(error => {
    if (error.code === "payload_key_mismatch" && encryptedStages.get(cacheKey) === stage) encryptedStages.delete(cacheKey);
    throw error;
  });
  if (completed.ready !== true || completed.ciphertextHash?.toLowerCase() !== sealed.ciphertextHash.toLowerCase()) throw new Error("Encrypted upload was not verified");
  if (epoch !== generation) throw new Error("Wallet session changed");
  const result = { nonce, ciphertextHash: sealed.ciphertextHash, sellerKeyHash: owner.key.fingerprint, payloadId: stage.id };
  preparations.set(cacheKey, result);
  encryptedStages.delete(cacheKey);
  return result;
};

const submitProtectedAuction = async ({ factory, wallet, minimum, text, description, duration, operationId, onProgress }) => {
  const prepared = await prepareProtectedAuction({ wallet, text, operationId, onProgress });
  const epoch = generation;
  const owner = await identity(wallet);
  if (factory.options?.address && factory.options.address.toLowerCase() !== owner.factory.toLowerCase()) throw new Error("Protected factory changed");
  if (factory.methods.usedPayloadIds && await factory.methods.usedPayloadIds(prepared.payloadId).call()) {
    throw new Error("This encrypted auction was already created. Refresh the auction list before trying again.");
  }
  await assertRecipient(owner, epoch);
  onProgress?.("Confirm auction in MetaMask");
  const receipt = await factory.methods.createEncryptedCampaign(minimum, prepared.nonce, prepared.ciphertextHash, prepared.sellerKeyHash, description, duration).send({ from: wallet, chainId: owner.chainId });
  preparations.clear();
  return receipt;
};

export const createProtectedAuction = async input => {
  if (!input.operationId) return submitProtectedAuction(input);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    input.wallet.toLowerCase(), getActiveFactoryAddress().toLowerCase(), input.operationId,
    String(input.minimum), input.text, input.description, String(input.duration),
  ])));
  const id = Array.from(new Uint8Array(digest)).join(",");
  if (!creations.has(id)) {
    const task = submitProtectedAuction(input).catch(error => { if (creations.get(id) === task) creations.delete(id); throw error; });
    creations.set(id, task);
  }
  return creations.get(id);
};

const assertRecipient = async (owner, epoch) => {
  const fresh = await requireWalletAccess();
  if (fresh.account.toLowerCase() !== owner.wallet.toLowerCase() || getEthereumProvider() !== owner.provider || Number(await owner.provider.request({ method: "eth_chainId" })) !== owner.chainId) throw new Error("Wallet or network changed");
  if (epoch !== generation) throw new Error("Wallet session changed");
};

export const decryptProtectedAuction = async ({ address, wallet, expectedHash, expectedPayloadId, recover = false }) => {
  const owner = await identity(wallet);
  const epoch = generation;
  // Only an explicit recovery action may ask the wallet to sign.
  const release = recover
    ? await api("/release", { auction: address }, (await authenticate(owner)).token)
    : await api("/release", { auction: address, publicKey: owner.key.publicKey, walletHint: owner.wallet });
  if (release.id?.toLowerCase() !== expectedPayloadId?.toLowerCase() || release.ciphertextHash?.toLowerCase() !== expectedHash?.toLowerCase()) throw new Error("Payload identity mismatch");
  const response = await fetch(release.downloadUrl, { cache: "no-store" });
  if (!response.ok) throw new Error("Encrypted data is temporarily unavailable");
  const envelope = await response.json();
  const text = await cryptoOperation("open", [envelope, release.wrappedKey, owner.key.privateKey, envelope.context, expectedHash]);
  await assertRecipient(owner, epoch);
  return text;
};

export const listProtectedArchives = () => api("/archives");

export const decryptProtectedArchive = async ({ archiveId, wallet, expectedHash, expectedPayloadId }) => {
  const owner = await identity(wallet);
  const epoch = generation;
  const auth = await authenticate(owner);
  const release = await api("/release", { archiveId }, auth.token);
  if (release.id?.toLowerCase() !== expectedPayloadId?.toLowerCase() || release.ciphertextHash?.toLowerCase() !== expectedHash?.toLowerCase()) throw new Error("Archive payload identity mismatch");
  const response = await fetch(release.downloadUrl, { cache: "no-store" });
  if (!response.ok) throw new Error("Encrypted archive is temporarily unavailable");
  const envelope = await response.json();
  const text = await cryptoOperation("open", [envelope, release.wrappedKey, owner.key.privateKey, envelope.context, expectedHash]);
  await assertRecipient(owner, epoch);
  return text;
};
