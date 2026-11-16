/** @jest-environment node */
import "./testSupport/idbEnv";
import "fake-indexeddb/auto";
import { webcrypto } from "crypto";
import { Wallet } from "ethers";
import { createIndexedDbStorage, createLocalWallet } from "./localWallet.mjs";
import { scopeIdFor } from "./silentVault.mjs";

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
  expect(Object.keys(record).sort()).toEqual(["ciphertext", "iv", "v"]);
  expect(record.iv.length).toBe(12);
  const dump = JSON.stringify(Array.from(record.ciphertext)) + JSON.stringify(Array.from(record.iv));
  // Decrypt through the wallet and make sure the key hex is nowhere in what was stored.
  const key = stored["key:default"];
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
  const key = (await readAll("silent"))["key:default"];
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
  expect(Object.keys(await readAll("silent")).sort()).toEqual(["key:default", "wallet:default"]);
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
