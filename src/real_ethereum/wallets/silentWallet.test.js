/** @jest-environment node */
import "./testSupport/idbEnv";
import "fake-indexeddb/auto";
import { webcrypto } from "crypto";
import { Wallet } from "ethers";
import { createIndexedDbStorage, createLocalWallet } from "./localWallet.mjs";
import { WALLET_UNREADABLE, createSilentVault, scopeIdFor } from "./silentVault.mjs";

const DB = "data-market-local-wallet";
const newWallet = (scope, extra = {}) => createLocalWallet({
  storage: createIndexedDbStorage(), silentStorage: createIndexedDbStorage({ storeName: "silent" }), scope, scryptN: 2 ** 4, ...extra,
});
const readAll = (storeName) => new Promise((resolve, reject) => {
  const open = indexedDB.open(DB, 2);
  open.onsuccess = () => {
    const db = open.result;
    const out = {};
    const request = db.transaction(storeName).objectStore(storeName).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { out[cursor.key] = cursor.value; cursor.continue(); } else { db.close(); resolve(out); }
    };
    request.onerror = () => reject(request.error);
  };
});
const wipe = () => new Promise((resolve) => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = resolve; r.onerror = resolve; r.onblocked = resolve; });
beforeEach(wipe);

test("first visit creates the wallet with no passphrase and no prompt", async () => {
  const wallet = newWallet("default");
  expect(await wallet.openSilent()).toBe("created");
  expect(wallet.isUnlocked()).toBe(true);
  expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
});

test("after a reload the same wallet opens silently with the same address", async () => {
  const first = newWallet("default");
  await first.openSilent();
  const reloaded = newWallet("default"); // a new object over the same IndexedDB = a page reload
  expect(reloaded.isUnlocked()).toBe(false);
  expect(await reloaded.openSilent()).toBe("opened");
  expect(reloaded.address).toBe(first.address);
});

test("the stored record contains no plaintext key, only IV + ciphertext", async () => {
  const wallet = newWallet("default");
  await wallet.openSilent();
  const stored = await readAll("silent");
  const record = stored["wallet:default"];
  expect(Object.keys(record).sort()).toEqual(["ciphertext", "iv", "key", "v"]); // ONE record: key, iv and ciphertext together
  expect(record.iv.length).toBe(12);
  const dump = JSON.stringify(Array.from(record.ciphertext)) + JSON.stringify(Array.from(record.iv));
  // Decrypt through the wallet and make sure the key hex is nowhere in what was stored.
  const key = record.key;
  const plain = Buffer.from(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, key, record.ciphertext)).toString("utf8");
  expect(plain).toMatch(/^0x[0-9a-f]{64}$/);
  expect(new Wallet(plain).address).toBe(wallet.address);
  const raw = Buffer.from(record.ciphertext).toString("hex") + Buffer.from(record.ciphertext).toString("utf8") + dump;
  expect(raw).not.toContain(plain.slice(2));
  expect(JSON.stringify(stored["wallet:default"])).not.toContain(plain.slice(2));
  expect(await readAll("keystore")).toEqual({}); // no legacy keystore was written
});

test("the AES key is a non-extractable CryptoKey", async () => {
  const wallet = newWallet("default");
  await wallet.openSilent();
  const key = (await readAll("silent"))["wallet:default"].key;
  expect(key.constructor.name).toBe("CryptoKey");
  expect(key.extractable).toBe(false);
  expect(key.algorithm.name).toBe("AES-GCM");
  await expect(webcrypto.subtle.exportKey("raw", key)).rejects.toThrow();
});

test("one wallet per participant id per browser", async () => {
  const a = newWallet(scopeIdFor("5f1a2b3c4d5e6f7a8b9c0d1e"));
  const b = newWallet(scopeIdFor("6f1a2b3c4d5e6f7a8b9c0d1e"));
  const none = newWallet(scopeIdFor(""));
  await Promise.all([a.openSilent(), b.openSilent(), none.openSilent()]);
  expect(new Set([a.address, b.address, none.address]).size).toBe(3);
  const again = newWallet(scopeIdFor("5f1a2b3c4d5e6f7a8b9c0d1e"));
  await again.openSilent();
  expect(again.address).toBe(a.address);
  expect(Object.keys(await readAll("silent")).join()).not.toContain("5f1a2b3c4d5e6f7a8b9c0d1e"); // no raw pid in storage names
});

test("concurrent opens (Strict Mode) create exactly one wallet", async () => {
  const wallet = newWallet("default");
  const [one, two] = await Promise.all([wallet.openSilent(), wallet.openSilent()]);
  expect(one).toBe(two);
  expect(Object.keys(await readAll("silent")).sort()).toEqual(["wallet:default"]);
});

test("an old passphrase keystore: unlock once, re-save silently, never asked again", async () => {
  const legacy = newWallet("default");
  const legacyAddress = await legacy.create("a long old passphrase");
  expect(Object.keys(await readAll("keystore"))).toEqual(["keystore-v1"]);

  const upgraded = newWallet("default");
  expect(await upgraded.openSilent()).toBe("needs-migration");
  expect(upgraded.isUnlocked()).toBe(false);
  await expect(upgraded.unlock("wrong passphrase!!")).rejects.toThrow(/Wrong passphrase/);
  expect(await upgraded.unlock("a long old passphrase")).toBe(legacyAddress);
  await upgraded.migrateToSilent();
  expect(await readAll("keystore")).toEqual({}); // old keystore removed

  const reloaded = newWallet("default");
  expect(await reloaded.openSilent()).toBe("opened");
  expect(reloaded.address).toBe(legacyAddress);
});

test("admin view backup: passphrase-encrypted, restorable", async () => {
  const wallet = newWallet("default");
  await wallet.openSilent();
  await expect(wallet.exportBackup("short")).rejects.toThrow(/12 characters/);
  const backup = await wallet.exportBackup("a long passphrase!");
  const keystore = JSON.parse(backup);
  expect(keystore.Crypto || keystore.crypto).toBeDefined(); // a standard encrypted JSON keystore
  const other = newWallet("admin");
  expect(await other.restoreBackupSilent(backup, "a long passphrase!")).toBe(wallet.address);
  await expect(other.restoreBackupSilent(backup, "wrong passphrase!!")).rejects.toThrow(/could not be decrypted/);
  const reloaded = newWallet("admin");
  await reloaded.openSilent();
  expect(reloaded.address).toBe(wallet.address);
});

test("without WebCrypto or IndexedDB the silent open fails loudly (the host then shows the unsupported-browser page)", async () => {
  const realSubtle = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    await expect(newWallet("default").openSilent()).rejects.toThrow(/WebCrypto is not available/);
  } finally {
    Object.defineProperty(globalThis, "crypto", realSubtle);
  }
  const brokenStorage = { get: async () => { throw new Error("IndexedDB is not available"); }, set: async () => {}, delete: async () => {} };
  const wallet = createLocalWallet({ storage: brokenStorage, silentStorage: brokenStorage, scope: "default" });
  await expect(wallet.openSilent()).rejects.toThrow(/IndexedDB is not available/);
  expect(wallet.isUnlocked()).toBe(false);
});

// A storage whose every operation is slow and jittered, over the real IndexedDB: two tabs racing on a first visit.
const slowStorage = (inner, delays) => {
  let call = 0;
  const wait = () => new Promise((resolve) => setTimeout(resolve, delays[call++ % delays.length]));
  return {
    get: async (key) => { await wait(); return inner.get(key); },
    set: async (key, value) => { await wait(); return inner.set(key, value); },
    delete: async (key) => { await wait(); return inner.delete(key); },
    putIfAbsent: async (key, value) => { await wait(); return inner.putIfAbsent(key, value); },
  };
};

test("two concurrent wallets (two tabs) on one slow storage end up with the same address, and the stored record decrypts", async () => {
  const slow = slowStorage(createIndexedDbStorage({ storeName: "silent" }), [30, 5, 18, 2, 40, 9]);
  const make = () => createLocalWallet({ storage: createIndexedDbStorage(), silentStorage: slow, scope: "default", scryptN: 2 ** 4 });
  const [one, two] = [make(), make()]; // separate objects: Strict Mode de-duplication does not apply
  const results = await Promise.all([one.openSilent(), two.openSilent()]);
  expect(one.address).toBe(two.address);
  expect(results.slice().sort()).toEqual(["created", "opened"]); // exactly one of them created it
  const stored = await readAll("silent");
  expect(Object.keys(stored)).toEqual(["wallet:default"]);
  const record = stored["wallet:default"];
  const plain = Buffer.from(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, record.key, record.ciphertext)).toString("utf8");
  expect(new Wallet(plain).address).toBe(one.address); // key, iv and ciphertext belong together
  const later = newWallet("default");
  expect(await later.openSilent()).toBe("opened");
  expect(later.address).toBe(one.address);
});

test("many tabs at once still converge on a single wallet", async () => {
  const slow = slowStorage(createIndexedDbStorage({ storeName: "silent" }), [11, 3, 25, 7]);
  const wallets = Array.from({ length: 5 }, () => createLocalWallet({ storage: createIndexedDbStorage(), silentStorage: slow, scope: "default", scryptN: 2 ** 4 }));
  await Promise.all(wallets.map((wallet) => wallet.openSilent()));
  expect(new Set(wallets.map((wallet) => wallet.address)).size).toBe(1);
});

test("the first-visit open runs inside navigator.locks `wallet:<scope>` when the Web Locks API exists", async () => {
  const names = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: jest.fn(async (name, callback) => { names.push(name); return callback(); }) } } });
  try {
    const wallet = newWallet("pid-abc");
    expect(await wallet.openSilent()).toBe("created");
    expect(names).toEqual(["wallet:pid-abc"]);
    expect(wallet.isUnlocked()).toBe(true);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original); else delete globalThis.navigator;
  }
});

test("without navigator.locks the open still works", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    expect(await newWallet("default").openSilent()).toBe("created");
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original); else delete globalThis.navigator;
  }
});

test("the IV is random: 12 bytes, never all zeros, and different for every seal", async () => {
  const wallet = newWallet("default");
  await wallet.openSilent();
  const first = (await readAll("silent"))["wallet:default"].iv;
  expect(first.length).toBe(12);
  expect(Array.from(first).some((byte) => byte !== 0)).toBe(true);
  const other = newWallet("other");
  await other.openSilent();
  const second = (await readAll("silent"))["wallet:other"].iv;
  expect(Array.from(second).some((byte) => byte !== 0)).toBe(true);
  expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  // Re-sealing the same key (migration, restore) draws a fresh IV and a fresh AES key.
  const vault = createSilentVault({ storage: createIndexedDbStorage({ storeName: "silent" }), scope: "default" });
  await vault.seal(`0x${"11".repeat(32)}`);
  const resealed = (await readAll("silent"))["wallet:default"];
  expect(Buffer.from(resealed.iv).equals(Buffer.from(first))).toBe(false);
});

test("putIfAbsent never overwrites: the first record wins and a later sealIfAbsent reports false", async () => {
  const vault = createSilentVault({ storage: createIndexedDbStorage({ storeName: "silent" }), scope: "default" });
  expect(await vault.sealIfAbsent(`0x${"11".repeat(32)}`)).toBe(true);
  expect(await vault.sealIfAbsent(`0x${"22".repeat(32)}`)).toBe(false);
  expect(await vault.open()).toBe(`0x${"11".repeat(32)}`);
});

test("a stored wallet that cannot be decrypted is reported as unreadable (different from unavailable storage)", async () => {
  const wallet = newWallet("default");
  await wallet.openSilent();
  const storage = createIndexedDbStorage({ storeName: "silent" });
  const record = await storage.get("wallet:default");
  await storage.set("wallet:default", { ...record, ciphertext: new Uint8Array(record.ciphertext.length) }); // corrupted
  const error = await newWallet("default").openSilent().catch((e) => e);
  expect(error.code).toBe(WALLET_UNREADABLE);
  const missingKey = { get: async (key) => (key === "wallet:default" ? { v: 1, iv: record.iv, ciphertext: record.ciphertext } : null), set: async () => {}, delete: async () => {} };
  const lost = await createLocalWallet({ storage: missingKey, silentStorage: missingKey, scope: "default" }).openSilent().catch((e) => e);
  expect(lost.code).toBe(WALLET_UNREADABLE);
});

test("a record written by the first version (key in its own entry) still opens", async () => {
  const storage = createIndexedDbStorage({ storeName: "silent" });
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const secret = `0x${"33".repeat(32)}`;
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, Buffer.from(secret)));
  await storage.set("key:default", key);
  await storage.set("wallet:default", { v: 1, iv, ciphertext });
  const wallet = newWallet("default");
  expect(await wallet.openSilent()).toBe("opened");
  expect(wallet.address).toBe(new Wallet(secret).address);
});
