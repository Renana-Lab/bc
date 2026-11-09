"use strict";
// Participant codes: random, anonymous, single-use. Only SHA-256 digests go to the table.
const crypto = require("crypto");
const { sha256, PID_PATTERN } = require("../../infrastructure/faucet/handler");

// No look-alike characters (0/O, 1/I/L). 16 chars from a 31-symbol alphabet is about 79 bits.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const generatePid = (length = 16) => {
  for (;;) {
    let pid = "";
    for (let i = 0; i < length; i += 1) pid += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (PID_PATTERN.test(pid)) return pid;
  }
};

const generatePids = (count, length = 16) => {
  const pids = new Set();
  while (pids.size < count) pids.add(generatePid(length));
  return [...pids];
};

// Uploads digests (never raw codes) through a store that implements putPid(hash, createdAt).
const uploadPids = async (store, pids, now = () => Math.floor(Date.now() / 1000)) => {
  let created = 0;
  for (const pid of pids) if (await store.putPid(sha256(pid), now())) created += 1;
  return created;
};

module.exports = { generatePid, generatePids, uploadPids, ALPHABET };
