import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { hashPassword, verifyPassword, safeEqual } = require("../../infrastructure/faucet/adminAuth.js");

test("admin password: salted scrypt hash verifies only the right password and never contains it", async () => {
  const record = await hashPassword("a long enough password");
  assert.equal(record.alg, "scrypt");
  assert.equal(JSON.stringify(record).includes("a long enough password"), false);
  assert.equal(await verifyPassword("a long enough password", record), true);
  for (const bad of ["a long enough passwor", "", "x".repeat(500), undefined, null, 5]) assert.equal(await verifyPassword(bad, record), false);
  const other = await hashPassword("a long enough password");
  assert.notEqual(other.salt, record.salt, "a fresh salt each time");
  assert.notEqual(other.hash, record.hash);
  for (const broken of [null, {}, { ...record, alg: "md5" }, { ...record, hash: "zz" }, { ...record, N: 2 }]) assert.equal(await verifyPassword("a long enough password", broken), false);
});

test("safeEqual compares strings in constant time and rejects non-strings", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "abc"), false);
});
