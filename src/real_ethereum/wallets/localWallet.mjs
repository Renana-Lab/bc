import { JsonRpcProvider, Wallet, encryptKeystoreJson, getBytes, isHexString } from "ethers";
import { assertEnvelopedCalldata, assertRequestIsConfidential } from "./sapphireWrap.mjs";

// Mode "local": a key generated in this browser, kept as an encrypted (scrypt + AES) keystore
// in IndexedDB, unlocked with a passphrase. The decrypted key exists only inside this closure
// while unlocked. It is never logged, never sent anywhere, and never exposed by this API.
const KEY = "keystore-v1";

export const createMemoryStorage = () => {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
};

export const createIndexedDbStorage = ({ dbName = "data-market-local-wallet", storeName = "keystore" } = {}) => {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, action) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const request = action(db.transaction(storeName, mode).objectStore(storeName));
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (key) => run("readonly", (store) => store.get(key)),
    set: (key, value) => run("readwrite", (store) => store.put(value, key)),
    delete: (key) => run("readwrite", (store) => store.delete(key)),
  };
};

const walletError = (code, message) => Object.assign(new Error(message), { code });

export const createLocalWallet = ({ storage, scryptN = 2 ** 17 } = {}) => {
  if (!storage) throw new Error("A storage adapter is required.");
  let signer = null;
  const listeners = new Set();
  const emit = (event, payload) => listeners.forEach((listener) => listener(event, payload));

  const unlockWith = (next) => { signer = next; emit("accountsChanged", [next.address]); };
  const encrypt = (wallet, passphrase) =>
    encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, passphrase, { scrypt: { N: scryptN } });

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async exists() { return Boolean(await storage.get(KEY)); },
    isUnlocked() { return Boolean(signer); },
    get address() { return signer ? signer.address : ""; },
    async create(passphrase) {
      if (!passphrase || passphrase.length < 12) throw new Error("Choose a passphrase of at least 12 characters.");
      if (await storage.get(KEY)) throw new Error("A local wallet already exists in this browser. Unlock it or forget it first.");
      const wallet = Wallet.createRandom();
      await storage.set(KEY, await encrypt(wallet, passphrase));
      unlockWith(new Wallet(wallet.privateKey));
      return wallet.address;
    },
    async unlock(passphrase) {
      const json = await storage.get(KEY);
      if (!json) throw new Error("No local wallet in this browser.");
      let decrypted;
      try { decrypted = await Wallet.fromEncryptedJson(json, passphrase); }
      catch { throw new Error("Wrong passphrase."); }
      unlockWith(new Wallet(decrypted.privateKey));
      return decrypted.address;
    },
    lock() { if (signer) { signer = null; emit("accountsChanged", []); } },
    async forget() { signer = null; await storage.delete(KEY); emit("accountsChanged", []); },
    // Backup of the ENCRYPTED keystore (needs the same passphrase to restore).
    async exportEncryptedBackup() {
      const json = await storage.get(KEY);
      if (!json) throw new Error("No local wallet in this browser.");
      return json;
    },
    async importEncryptedBackup(json, passphrase, { overwrite = false } = {}) {
      if (!overwrite && await storage.get(KEY)) throw new Error("A local wallet already exists in this browser. Forget it first.");
      const decrypted = await Wallet.fromEncryptedJson(json, passphrase).catch(() => {
        throw new Error("Backup could not be decrypted with that passphrase.");
      });
      await storage.set(KEY, json);
      unlockWith(new Wallet(decrypted.privateKey));
      return decrypted.address;
    },
    async signMessage(message) {
      if (!signer) throw walletError(4100, "Unlock the local wallet first.");
      return signer.signMessage(message);
    },
    async sendTransaction(request, rpc) {
      if (!signer) throw walletError(4100, "Unlock the local wallet first.");
      return signer.connect(rpc).sendTransaction(request);
    },
  };
};

// Raw (non-encrypting) EIP-1193 provider backed by the local wallet. It is always used UNDER the
// Sapphire wrapper (see sapphireWrap.mjs); it additionally refuses to sign plaintext calldata.
export const createLocalProvider = ({ wallet, network }) => {
  const rpc = new JsonRpcProvider(network.rpcUrls[0], network.chainId, { staticNetwork: true, batchMaxCount: 1 });
  const listeners = new Map();
  const on = (event, listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(listener);
  };
  wallet.subscribe((event, payload) => listeners.get(event)?.forEach((listener) => listener(payload)));
  const accounts = () => (wallet.isUnlocked() ? [wallet.address] : []);
  const sameAccount = (account) => wallet.isUnlocked() && String(account).toLowerCase() === wallet.address.toLowerCase();

  return {
    isLocalWallet: true,
    isUnlocked: () => wallet.isUnlocked(),
    on,
    removeListener: (event, listener) => listeners.get(event)?.delete(listener),
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_chainId": return network.chainIdHex;
        case "net_version": return String(network.chainId);
        case "eth_accounts": return accounts();
        case "eth_requestAccounts":
          if (!wallet.isUnlocked()) throw walletError(4100, "Unlock the local wallet first.");
          return accounts();
        case "wallet_switchEthereumChain":
          if (String(params[0]?.chainId).toLowerCase() === network.chainIdHex) return null;
          throw walletError(4902, `The local wallet only supports ${network.chainName}.`);
        case "wallet_addEthereumChain": return null;
        case "personal_sign": {
          if (!sameAccount(params[1])) throw walletError(4100, "That account is not the unlocked local wallet.");
          const message = isHexString(params[0]) ? getBytes(params[0]) : params[0];
          return wallet.signMessage(message);
        }
        case "eth_sendTransaction": {
          const tx = params[0] || {};
          if (tx.from && !sameAccount(tx.from)) throw walletError(4100, "The sender is not the unlocked local wallet.");
          assertEnvelopedCalldata(tx.data ?? tx.input, "local wallet sign");
          const request = { to: tx.to, data: tx.data ?? tx.input, value: tx.value, chainId: network.chainId };
          if (tx.gas || tx.gasLimit) request.gasLimit = tx.gas || tx.gasLimit;
          if (tx.nonce !== undefined) request.nonce = tx.nonce;
          return (await wallet.sendTransaction(request, rpc)).hash;
        }
        case "eth_sign":
        case "eth_signTransaction":
        case "eth_signTypedData":
        case "eth_signTypedData_v3":
        case "eth_signTypedData_v4":
          throw walletError(4200, `${method} is not supported by the local wallet.`);
        default:
          // Reads and raw broadcasts must be enveloped as well (defense in depth under the wrapper).
          assertRequestIsConfidential({ method, params });
          return rpc.send(method, params);
      }
    },
  };
};
