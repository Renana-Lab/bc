import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTOR_RUN_MS,
  assignExperimentRoles,
  buildExperimentManifest,
  buildHumanSchedule,
  createSeededRandom,
  getRunInvalidReasons,
  parseWalletTable,
  seededShuffle,
  validateRoleIsolation,
} from "./experimentCore.mjs";

const wallets = Array.from({ length: 50 }, (_value, index) => ({
  number: index + 1,
  address: `0x${String(index + 1).padStart(40, "0")}`,
  privateKey: `0x${String(index + 1).padStart(64, "0")}`,
}));

test("wallet parser discards password and seed phrase columns", () => {
  const parsed = parseWalletTable(
    "Number\tAddress (Public Key)\tPassword\tPrivate Key\t12-Word Seed Phrase\tsepolia\n" +
      `1\t${wallets[0].address}\tdont-store\t${wallets[0].privateKey}\tdont-store-this-either\t1`,
  );
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["address", "fundingHint", "number", "privateKey"]);
  assert.equal(JSON.stringify(parsed).includes("dont-store"), false);
});

test("role assignment is deterministic, isolated, and complete", () => {
  const first = assignExperimentRoles(wallets, { experimentId: "EXP-1", seed: "fixed" });
  const second = assignExperimentRoles(wallets, { experimentId: "EXP-1", seed: "fixed" });
  assert.deepEqual(first.participants, second.participants);
  assert.equal(first.participants.filter((row) => row.role === "seller").length, 10);
  assert.equal(first.participants.filter((row) => row.role === "synthetic-human").length, 20);
  assert.equal(first.participants.filter((row) => row.role === "standard-bot").length, 10);
  assert.equal(first.participants.filter((row) => row.observer).length, 2);
  assert.deepEqual(validateRoleIsolation(first.participants), []);
});

test("human schedules are reproducible and remain inside the run window", () => {
  const assignments = assignExperimentRoles(wallets, { experimentId: "EXP-1", seed: "fixed" });
  const actor = assignments.participants.find((row) => row.role === "synthetic-human" && !row.observer);
  const startAtMs = 1_000_000;
  const input = { seed: "fixed", startAtMs, stopAtMs: startAtMs + ACTOR_RUN_MS };
  const schedule = buildHumanSchedule(actor, input);
  assert.deepEqual(schedule, buildHumanSchedule(actor, input));
  assert.ok(schedule.every((step) => step.atMs > startAtMs && step.atMs < input.stopAtMs));
});

test("seeded shuffle does not depend on ambient randomness", () => {
  assert.deepEqual(
    seededShuffle([1, 2, 3, 4, 5], createSeededRandom("seed")),
    seededShuffle([1, 2, 3, 4, 5], createSeededRandom("seed")),
  );
});

test("manifest has public roles and ten parameterized auctions", () => {
  const assignments = assignExperimentRoles(wallets, { experimentId: "EXP-1", seed: "fixed" });
  const manifest = buildExperimentManifest({
    experimentId: "EXP-1",
    seed: "fixed",
    factoryAddress: wallets[49].address,
    assignments,
  });
  assert.equal(manifest.auctionSpecs.length, 10);
  assert.equal(manifest.auctionSpecs[9].minimumBidWei, 250);
  assert.equal(JSON.stringify(manifest).includes("privateKey"), false);
});

test("run invalidation covers hard protocol boundaries", () => {
  assert.deepEqual(getRunInvalidReasons({
    chainId: 1,
    activeExperimentAuctions: [],
    registryAgeMs: 61_000,
    healthyActors: 20,
    unhealthyConsecutiveMinutes: 2,
    reportEvidenceComplete: false,
  }), [
    "Wrong chain",
    "Expected exactly 10 active experiment auctions",
    "Active-auction registry stale for over 60 seconds",
    "Fewer than 90% of actors healthy for two consecutive minutes",
    "Report evidence incomplete",
  ]);
});

test("one hundred seeded schedules respect observers, late entry, and exact stop", () => {
  const assignments = assignExperimentRoles(wallets, { experimentId: "EXP-STRESS", seed: "roles" });
  const humans = assignments.participants.filter((row) => row.role === "synthetic-human");
  for (let seedIndex = 0; seedIndex < 100; seedIndex += 1) {
    const startAtMs = 100_000;
    const stopAtMs = startAtMs + ACTOR_RUN_MS;
    humans.forEach((actor) => {
      const schedule = buildHumanSchedule(actor, { seed: `stress-${seedIndex}`, startAtMs, stopAtMs });
      if (actor.observer) assert.equal(schedule.length, 0);
      assert.ok(schedule.every((step) => step.atMs < stopAtMs));
      if (actor.archetype === "late" && schedule.length) {
        assert.ok(schedule[0].atMs >= startAtMs + 14 * 60 * 1000);
      }
    });
  }
});

test("role validator catches duplicate and seller/bidder reuse", () => {
  const assignments = assignExperimentRoles(wallets, { experimentId: "EXP-1", seed: "fixed" });
  const bad = [...assignments.participants];
  bad[10] = { ...bad[10], address: bad[0].address };
  const errors = validateRoleIsolation(bad);
  assert.ok(errors.some((error) => error.startsWith("Duplicate address")));
  assert.ok(errors.some((error) => error.includes("also a bidder")));
});
