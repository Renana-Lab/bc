// "Invisible wallet" storage (REACT_APP_WALLET_MODE=local, default). Test-network funds only, so convenience
// beats strong key protection: the participant never types anything.
//
// The private key is encrypted with an AES-GCM CryptoKey that is generated with extractable:false and kept in
// IndexedDB as a CryptoKey object (its raw bytes can never be read back by script). Only the IV and the
// ciphertext are stored in the same record. This protects against casual reads of the storage (a copied record is useless
// without the non-extractable key); it does NOT protect against script running on this origin, which could ask the
// browser to decrypt. That trade-off is intentional for test funds.
import { toUtf8Bytes, toUtf8String } from "ethers";

const KEY_PREFIX = "key:";
const RECORD_PREFIX = "wallet:";

const getSubtle = () => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available in this browser.");
  return subtle;
};

// cyrb53: a small, fast, synchronous, non-cryptographic 53-bit string hash. It only names storage slots (it is not a
// security boundary), so a pure function is fine and keeps the provider creatable before the first render settles.
const cyrb53 = (text, seed) => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
};

// One wallet per participant id per browser. The id is hashed so no raw pid appears in storage names.
export const scopeIdFor = (pid) => {
  const value = String(pid || "").trim();
  if (!value) return "default";
  return `pid-${[1, 2, 3, 4].map((seed) => cyrb53(value, seed)).join("").slice(0, 32)}`;
};

// Storage adapters used here: get/set/delete, plus putIfAbsent(key, value) -> boolean (true when written). The
// whole sealed wallet is ONE record { v, key, iv, ciphertext }, so a ciphertext can never be paired with a
// different AES key (two tabs racing on a first visit used to be able to do that with two separate entries).
// A wallet IS stored but cannot be read (wrong/missing key, corrupt record): different from "storage unavailable".
export const WALLET_UNREADABLE = "wallet-unreadable";
const unreadable = (message) => Object.assign(new Error(message), { code: WALLET_UNREADABLE });

const putIfAbsent = async (storage, name, record) => {
  if (typeof storage.putIfAbsent === "function") return storage.putIfAbsent(name, record);
  if (await storage.get(name)) return false;
  await storage.set(name, record);
  return true;
};

const encryptRecord = async (privateKey) => {
  const key = await getSubtle().generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await getSubtle().encrypt({ name: "AES-GCM", iv }, key, toUtf8Bytes(privateKey));
  return { v: 2, key, iv, ciphertext: new Uint8Array(ciphertext) };
};

export const createSilentVault = ({ storage, scope = "default" }) => {
  if (!storage) throw new Error("A storage adapter is required.");
  const legacyKeyName = `${KEY_PREFIX}${scope}`; // v1 kept the CryptoKey in a second entry
  const recordName = `${RECORD_PREFIX}${scope}`;

  return {
    scope,
    async exists() { return Boolean(await storage.get(recordName)); },
    // Writes only when nothing is stored yet (first visit). Resolves true when this call stored the record.
    async sealIfAbsent(privateKey) {
      return putIfAbsent(storage, recordName, await encryptRecord(privateKey));
    },
    // Replaces whatever is stored (migration, admin restore).
    async seal(privateKey) {
      await storage.set(recordName, await encryptRecord(privateKey));
      await storage.delete(legacyKeyName);
    },
    // Resolves with the private key, or null when nothing is stored for this scope.
    async open() {
      const record = await storage.get(recordName);
      if (!record) return null;
      const key = record.key || (await storage.get(legacyKeyName));
      if (!key) throw unreadable("The wallet key for this browser is missing.");
      let plain;
      try {
        plain = await getSubtle().decrypt({ name: "AES-GCM", iv: record.iv }, key, record.ciphertext);
      } catch (error) {
        throw unreadable(`The stored wallet could not be decrypted (${error?.name || "error"}).`);
      }
      return toUtf8String(new Uint8Array(plain));
    },
    async destroy() { await storage.delete(recordName); await storage.delete(legacyKeyName); },
  };
};
