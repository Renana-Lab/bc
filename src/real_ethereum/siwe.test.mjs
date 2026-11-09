import assert from "node:assert/strict";
import test from "node:test";
import { buildSiweMessage, splitSignature } from "./siwe.mjs";

test("builds an EIP-4361 message with an expiry", () => {
  const message = buildSiweMessage({
    domain: "localhost:3000",
    address: "0x" + "ab".repeat(20),
    uri: "http://localhost:3000",
    chainId: 23293,
    now: new Date("2026-01-01T00:00:00.000Z"),
    nonce: "abcdef0123456789",
  });
  assert.match(message, /^localhost:3000 wants you to sign in with your Ethereum account:\n0xab/);
  assert.match(message, /\nChain ID: 23293\n/);
  assert.match(message, /\nIssued At: 2026-01-01T00:00:00.000Z\n/);
  assert.match(message, /\nExpiration Time: 2026-01-01T01:00:00.000Z$/);
});

test("splits a 65-byte signature and normalizes v", () => {
  const sig = "0x" + "11".repeat(32) + "22".repeat(32) + "01";
  assert.deepEqual(splitSignature(sig), { r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32), v: 28 });
  assert.throws(() => splitSignature("0x1234"));
});
