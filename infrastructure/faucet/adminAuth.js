"use strict";
// Admin password hashing for the faucet open/closed switch. Only a salted scrypt hash is ever stored
// (AWS Secrets Manager); the password itself is never stored, logged or returned.
const crypto = require("crypto");

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
const MAX_PASSWORD_LENGTH = 200;

const scrypt = (password, salt, params) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 }, (error, key) =>
      error ? reject(error) : resolve(key));
  });

// Returns the JSON-serialisable record to store in Secrets Manager.
const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return { v: 1, alg: "scrypt", ...PARAMS, salt: salt.toString("hex"), hash: key.toString("hex") };
};

// Constant-time comparison of the derived key. Never throws for bad input: returns false.
const verifyPassword = async (password, record) => {
  try {
    if (typeof password !== "string" || !password || password.length > MAX_PASSWORD_LENGTH) return false;
    if (!record || record.alg !== "scrypt" || !/^[0-9a-f]+$/.test(record.salt || "") || !/^[0-9a-f]+$/.test(record.hash || "")) return false;
    const params = { N: Number(record.N), r: Number(record.r), p: Number(record.p), keylen: record.hash.length / 2 };
    if (!(params.N >= 1024 && params.N <= 65536) || !(params.r >= 1 && params.r <= 16) || !(params.p >= 1 && params.p <= 4) || params.keylen < 16) return false;
    const expected = Buffer.from(record.hash, "hex");
    const actual = await scrypt(password, Buffer.from(record.salt, "hex"), params);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

// Timing-safe equality for short shared strings (study id, experiment code): compare fixed-size digests.
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const digest = (value) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
};

module.exports = { hashPassword, verifyPassword, safeEqual, MAX_PASSWORD_LENGTH };
