const MANIFEST_KEY = "data-market:experiment-public-manifest:v1";
const EVENTS_KEY = "data-market:experiment-public-events:v1";

const readJson = (key, fallback) => {
  if (typeof window === "undefined") return fallback;
  try {
    return JSON.parse(window.localStorage.getItem(key) || "") || fallback;
  } catch (_) {
    return fallback;
  }
};

export const getExperimentEvidence = () => ({
  manifest: readJson(MANIFEST_KEY, null),
  events: readJson(EVENTS_KEY, []),
});

export const saveExperimentManifest = (manifest) => {
  if (!manifest?.experimentId || !Array.isArray(manifest.participants)) {
    throw new Error("This is not a valid public experiment manifest.");
  }
  const serialized = JSON.stringify(manifest);
  if (/privateKey|seedPhrase|password/i.test(serialized)) {
    throw new Error("Public manifests cannot contain wallet secrets.");
  }
  window.localStorage.setItem(MANIFEST_KEY, serialized);
  return manifest;
};

export const parseExperimentEvents = (text = "") => String(text)
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => {
    try {
      const event = JSON.parse(line);
      const serialized = JSON.stringify(event);
      if (/privateKey|seedPhrase|password/i.test(serialized)) {
        throw new Error("contains wallet secrets");
      }
      return event;
    } catch (error) {
      throw new Error(`Invalid evidence line ${index + 1}: ${error.message}`);
    }
  });

export const saveExperimentEvents = (events) => {
  if (!Array.isArray(events)) throw new Error("Experiment evidence must be an array.");
  window.localStorage.setItem(EVENTS_KEY, JSON.stringify(events.slice(-10000)));
  return events;
};

export const clearExperimentEvidence = () => {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(MANIFEST_KEY);
  window.localStorage.removeItem(EVENTS_KEY);
};

export const toExperimentReportRows = (manifest, events = []) => {
  if (!manifest) return [];
  const metadata = [
    ["Experiment", "Experiment ID", manifest.experimentId],
    ["Experiment", "Immutable seed", manifest.seed],
    ["Experiment", "Chain ID", manifest.chainId],
    ["Experiment", "Factory Address", manifest.factoryAddress],
    ["Experiment", "Created At ISO", manifest.createdAtIso],
    ["Protocol", "Actor run minutes", manifest.actorRunMinutes],
    ["Protocol", "Auction duration minutes", manifest.auctionDurationMinutes],
  ].map(([section, field, value]) => ({ Section: section, Field: field, Value: value }));
  const participants = (manifest.participants || []).map((participant) => ({
    Section: "Participant",
    Field: participant.actorId || participant.auctionId || `Wallet ${participant.walletNumber}`,
    Value: participant.address,
    Role: participant.role,
    Archetype: participant.archetype || "",
    Observer: participant.observer ? "Yes" : "No",
    "Wallet Number": participant.walletNumber,
  }));
  const auctions = (manifest.auctionSpecs || []).map((auction) => ({
    Section: "Auction",
    Field: auction.id,
    Value: auction.address || auction.auctionAddress || "Not created in imported manifest",
    Description: auction.description,
    "Seller Address": auction.sellerAddress,
    "Minimum Bid (wei)": auction.minimumBidWei,
    "Duration (minutes)": auction.durationMinutes,
  }));
  const evidenceSummary = [{
    Section: "Evidence",
    Field: "Imported runtime events",
    Value: events.length,
  }];
  return [...metadata, ...participants, ...auctions, ...evidenceSummary];
};

export const toExperimentEventRows = (events = []) => events.map((event) => ({
  "Time ISO": event.timeIso || "",
  "Experiment ID": event.experimentId || "",
  Type: event.type || "",
  "Actor ID": event.actorId || "",
  Cohort: event.cohort || "",
  Archetype: event.archetype || "",
  "Wallet Address": event.walletAddress || event.wallet || "",
  "Auction ID": event.auctionId || "",
  "Auction Address": event.auctionAddress || "",
  Decision: event.decision || "",
  Reason: event.reason || event.error || "",
  "Transaction Hash": event.transactionHash || "",
  "Etherscan URL": event.etherscanUrl || "",
  "Incremental Bid (wei)": event.incrementalBidWei || event.amountWei || "",
  "Cumulative Bid (wei)": event.cumulativeBidWei || "",
  "Budget Before (wei)": event.budgetBeforeWei || "",
  "Budget After (wei)": event.budgetAfterWei || "",
  "Active Auctions": Array.isArray(event.active) ? event.active.length : "",
  "Finalizable Auctions": Array.isArray(event.finalizable) ? event.finalizable.length : "",
}));
