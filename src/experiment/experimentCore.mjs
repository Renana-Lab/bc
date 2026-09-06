export const EXPERIMENT_CHAIN_ID = 11155111;
export const REQUIRED_BUDGET_WEI = 2000;
export const SELLER_MIN_BALANCE_WEI = 20_000_000_000_000_000n;
export const BIDDER_MIN_BALANCE_WEI = 5_000_000_000_000_000n;
export const ACTOR_RUN_MS = 20 * 60 * 1000;
export const AUCTION_DURATION_MINUTES = 25;
export const MINIMUM_START_REMAINING_SECONDS = 20 * 60;
export const MINIMUM_BID_REMAINING_SECONDS = 20;

export const AUCTION_SPECS = [50, 50, 100, 100, 150, 150, 200, 200, 250, 250]
  .map((minimumBidWei, index) => ({
    id: `A${String(index + 1).padStart(2, "0")}`,
    minimumBidWei,
    durationMinutes: AUCTION_DURATION_MINUTES,
  }));

export const HUMAN_ARCHETYPES = Object.freeze({
  cautious: {
    label: "Cautious",
    considerMin: 1,
    considerMax: 3,
    delayMinSeconds: 60,
    delayMaxSeconds: 150,
    willingnessMinWei: 300,
    willingnessMaxWei: 700,
  },
  value: {
    label: "Value-focused",
    considerMin: 2,
    considerMax: 4,
    delayMinSeconds: 40,
    delayMaxSeconds: 100,
    willingnessMinWei: 700,
    willingnessMaxWei: 1200,
  },
  competitive: {
    label: "Competitive",
    considerMin: 4,
    considerMax: 6,
    delayMinSeconds: 20,
    delayMaxSeconds: 60,
    willingnessMinWei: 1200,
    willingnessMaxWei: 1800,
  },
  late: {
    label: "Late-entry",
    considerMin: 1,
    considerMax: 3,
    delayMinSeconds: 20,
    delayMaxSeconds: 60,
    willingnessMinWei: 900,
    willingnessMaxWei: 1600,
    inactiveForMs: 14 * 60 * 1000,
  },
});

const normalizeHeader = (value = "") =>
  String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

const splitLine = (line, delimiter) =>
  delimiter === ","
    ? String(line).match(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)
        ?.map((value) => value.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) || []
    : String(line).split(delimiter);

export const parseWalletTable = (text = "") => {
  const lines = String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("The wallet file has no data rows.");

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = splitLine(lines[0], delimiter).map(normalizeHeader);
  const findColumn = (...names) => headers.findIndex((header) => names.includes(header));
  const numberIndex = findColumn("number", "walletnumber", "id");
  const addressIndex = findColumn("address", "publickey", "addresspublickey");
  const privateKeyIndex = findColumn("privatekey", "key");
  const fundingIndex = findColumn("sepolia", "funding", "balance", "sepoliafunding");
  if (numberIndex < 0 || addressIndex < 0 || privateKeyIndex < 0) {
    throw new Error("Wallet file must include Number, Address, and Private Key columns.");
  }

  return lines.slice(1).map((line, index) => {
    const values = splitLine(line, delimiter).map((value) => String(value || "").trim());
    return {
      number: Number(values[numberIndex] || index + 1),
      address: values[addressIndex] || "",
      privateKey: values[privateKeyIndex] || "",
      fundingHint: fundingIndex >= 0 ? values[fundingIndex] || "" : "",
    };
  });
};

const hashSeed = (input = "") => {
  let value = 2166136261;
  for (let index = 0; index < String(input).length; index += 1) {
    value ^= String(input).charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
};

export const createSeededRandom = (seed) => {
  let state = hashSeed(seed) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let result = state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

export const seededInteger = (random, minimum, maximum) =>
  minimum + Math.floor(random() * (maximum - minimum + 1));

export const seededShuffle = (items, random) => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

export const createExperimentId = (date = new Date()) =>
  `EXP-${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;

const publicWallet = (wallet, role, extra = {}) => ({
  walletNumber: wallet.number,
  address: wallet.address,
  role,
  ...extra,
});

export const assignExperimentRoles = (eligibleWallets, { experimentId, seed }) => {
  if (!experimentId || !seed) throw new Error("Experiment ID and seed are required.");
  if (eligibleWallets.length < 40) {
    throw new Error(`At least 40 eligible wallets are required; found ${eligibleWallets.length}.`);
  }
  // Preparation orders the already threshold-filtered seller, bidder, and reserve pools.
  // Preserve that order so a bidder-only wallet can never be promoted into a seller slot.
  const sorted = [...eligibleWallets];
  const sellers = sorted.slice(0, 10);
  const humans = sorted.slice(10, 30);
  const bots = sorted.slice(30, 40);
  const reserves = sorted.slice(40);
  const archetypes = [
    ...Array(5).fill("cautious"),
    ...Array(5).fill("value"),
    ...Array(5).fill("competitive"),
    ...Array(5).fill("late"),
  ];
  const observerIndexes = new Set(
    seededShuffle(humans.map((_wallet, index) => index), createSeededRandom(`${seed}:observers`)).slice(0, 2),
  );

  const participants = [
    ...sellers.map((wallet, index) => publicWallet(wallet, "seller", { auctionId: AUCTION_SPECS[index].id })),
    ...humans.map((wallet, index) => publicWallet(wallet, "synthetic-human", {
      actorId: `H${String(index + 1).padStart(2, "0")}`,
      archetype: archetypes[index],
      observer: observerIndexes.has(index),
    })),
    ...bots.map((wallet, index) => publicWallet(wallet, "standard-bot", {
      actorId: `B${String(index + 1).padStart(2, "0")}`,
    })),
    ...reserves.map((wallet, index) => publicWallet(wallet, "reserve", {
      actorId: `R${String(index + 1).padStart(2, "0")}`,
    })),
  ];
  const privateWallets = participants.map((participant) => {
    const wallet = sorted.find((candidate) => candidate.number === participant.walletNumber);
    return { ...participant, privateKey: wallet.privateKey };
  });

  return { participants, privateWallets };
};

export const buildHumanSchedule = (actor, { seed, startAtMs, stopAtMs }) => {
  const profile = HUMAN_ARCHETYPES[actor.archetype];
  if (!profile) throw new Error(`Unknown human archetype: ${actor.archetype}`);
  if (actor.observer) return [];
  const random = createSeededRandom(`${seed}:${actor.actorId}:${actor.address}`);
  const willingnessWei = seededInteger(
    random,
    profile.willingnessMinWei,
    profile.willingnessMaxWei,
  );
  const consideredAuctionIds = seededShuffle(
    AUCTION_SPECS.map((auction) => auction.id),
    random,
  ).slice(0, seededInteger(random, profile.considerMin, profile.considerMax));
  const schedule = [];
  let atMs = startAtMs + Number(profile.inactiveForMs || 0);
  while (atMs < stopAtMs) {
    atMs += seededInteger(random, profile.delayMinSeconds, profile.delayMaxSeconds) * 1000;
    if (atMs >= stopAtMs) break;
    schedule.push({
      atMs,
      auctionId: consideredAuctionIds[seededInteger(random, 0, consideredAuctionIds.length - 1)],
      willingnessWei,
      reconsideration: schedule.length + 1,
    });
  }
  return schedule;
};

export const buildExperimentManifest = ({ experimentId, seed, factoryAddress, assignments, createdAt = new Date() }) => ({
  schemaVersion: 1,
  experimentId,
  seed,
  createdAtIso: createdAt.toISOString(),
  chainId: EXPERIMENT_CHAIN_ID,
  factoryAddress,
  actorRunMinutes: ACTOR_RUN_MS / 60000,
  auctionDurationMinutes: AUCTION_DURATION_MINUTES,
  auctionSpecs: AUCTION_SPECS.map((auction, index) => ({
    ...auction,
    description: `${experimentId}-${auction.id}`,
    sellerAddress: assignments.participants.find(
      (participant) => participant.role === "seller" && participant.auctionId === auction.id,
    )?.address || "",
  })),
  participants: assignments.participants,
});

export const validateRoleIsolation = (participants = []) => {
  const errors = [];
  const seenAddresses = new Set();
  const seenNumbers = new Set();
  participants.forEach((participant) => {
    const address = String(participant.address || "").toLowerCase();
    if (seenAddresses.has(address)) errors.push(`Duplicate address ${participant.address}`);
    if (seenNumbers.has(participant.walletNumber)) errors.push(`Duplicate wallet #${participant.walletNumber}`);
    seenAddresses.add(address);
    seenNumbers.add(participant.walletNumber);
  });
  const sellers = new Set(
    participants.filter((participant) => participant.role === "seller")
      .map((participant) => String(participant.address).toLowerCase()),
  );
  participants
    .filter((participant) => ["synthetic-human", "standard-bot"].includes(participant.role))
    .forEach((participant) => {
      if (sellers.has(String(participant.address).toLowerCase())) {
        errors.push(`Seller ${participant.address} is also a bidder.`);
      }
    });
  return errors;
};

export const getRunInvalidReasons = ({
  chainId,
  activeExperimentAuctions = [],
  registryAgeMs = 0,
  healthyActors = 0,
  totalActors = 30,
  unhealthyConsecutiveMinutes = 0,
  reportEvidenceComplete = true,
}) => {
  const reasons = [];
  if (Number(chainId) !== EXPERIMENT_CHAIN_ID) reasons.push("Wrong chain");
  if (activeExperimentAuctions.length !== 10) reasons.push("Expected exactly 10 active experiment auctions");
  if (Number(registryAgeMs) > 60_000) reasons.push("Active-auction registry stale for over 60 seconds");
  if (totalActors && healthyActors / totalActors < 0.9 && unhealthyConsecutiveMinutes >= 2) {
    reasons.push("Fewer than 90% of actors healthy for two consecutive minutes");
  }
  if (!reportEvidenceComplete) reasons.push("Report evidence incomplete");
  return reasons;
};

export const toPublicManifest = (manifest = {}) => ({
  ...manifest,
  participants: (manifest.participants || []).map(({ privateKey: _privateKey, ...participant }) => participant),
});
