// Pure data mappers for the read-only Admin Zone cards. No network or React here so they unit-test.

export const AUDIT_EVENT_TYPES = [
  "BudgetChanged",
  "AuctionCreatedDetailed",
  "AuctionFinalizationFailed",
  "SellerPaid",
  "RefundProcessed",
];

const lower = (value) => String(value ?? "").toLowerCase();
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// Strings only: BigInt/BN values are not JSON-serializable and web3 returns both index and name keys.
export const namedArgs = (returnValues = {}) =>
  Object.fromEntries(
    Object.entries(returnValues)
      .filter(([key]) => Number.isNaN(Number(key)) && key !== "__length__")
      .map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : String(value)])
  );

// A revert reason is `bytes`. Decode Error(string) when possible, otherwise keep the hex.
export const decodeRevertReason = (hex) => {
  const text = String(hex ?? "");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(text) || text.length <= 2) return text === "0x" ? "(empty reason)" : text;
  if (text.toLowerCase().startsWith("0x08c379a0") && text.length >= 138) {
    try {
      const length = parseInt(text.slice(10 + 64, 10 + 128), 16);
      const body = text.slice(10 + 128, 10 + 128 + length * 2);
      const bytes = body.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [];
      return new TextDecoder().decode(new Uint8Array(bytes));
    } catch (_) {
      return text;
    }
  }
  return text;
};

const summarizeEvent = (name, args) => {
  switch (name) {
    case "BudgetChanged":
      return `${args.user}: ${args.increase === "true" ? "+" : "-"}${args.amount} (${args.budgetBefore} -> ${args.budgetAfter})`;
    case "AuctionCreatedDetailed":
      return `${args.campaignAddress} by ${args.seller}, min ${args.minimum}`;
    case "AuctionFinalizationFailed":
      return `${args.campaignAddress}: ${decodeRevertReason(args.reason)}`;
    case "SellerPaid":
      return `${args.seller} paid ${args.amount}`;
    case "RefundProcessed":
      return `${args.contributor} refunded ${args.amount}`;
    default:
      return "";
  }
};

// raw: a web3 event ({event, returnValues, blockNumber, logIndex, transactionHash, address}).
export const normalizeAuditEvent = (raw = {}, source = "") => {
  const name = raw.event || raw.eventName || "";
  const args = namedArgs(raw.returnValues);
  return {
    id: `${raw.transactionHash || ""}:${num(raw.logIndex)}:${name}`,
    name,
    source: source || lower(raw.address),
    contract: lower(raw.address),
    blockNumber: num(raw.blockNumber),
    logIndex: num(raw.logIndex),
    transactionHash: raw.transactionHash || "",
    auction: lower(args.campaignAddress || (name === "SellerPaid" || name === "RefundProcessed" ? raw.address : "")),
    actor: lower(args.user || args.seller || args.contributor || ""),
    summary: summarizeEvent(name, args),
    args,
  };
};

export const compareNewestFirst = (a, b) =>
  num(b.blockNumber) - num(a.blockNumber) || num(b.logIndex) - num(a.logIndex);

// Dedupe by id (live + polled reads overlap) and sort newest first.
export const mergeAuditEvents = (...lists) => {
  const byId = new Map();
  lists.flat().forEach((event) => event && byId.set(event.id, event));
  return Array.from(byId.values()).sort(compareNewestFirst);
};

export const filterAuditEvents = (events, { types = [], query = "" } = {}) => {
  const needle = lower(query).trim();
  return events.filter((event) => {
    if (types.length && !types.includes(event.name)) return false;
    if (!needle) return true;
    return [event.summary, event.auction, event.actor, event.transactionHash, event.name].some((field) =>
      lower(field).includes(needle)
    );
  });
};

// Stable, secret-free JSON for the Inspect view.
export const inspectEventJson = (event) =>
  JSON.stringify(
    {
      event: event.name,
      contract: event.contract,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      transactionHash: event.transactionHash,
      args: event.args,
    },
    null,
    2
  );

// addresses: factory.allUsers in registration order. budgets: map lowercase address -> usersBudget string.
// events: normalized BudgetChanged events. labels: lowercase address -> local label. bots: Set of lowercase wallets.
export const mapUserRows = ({ addresses = [], budgets = {}, events = [], labels = {}, bots = new Set() }) => {
  const lastChange = new Map();
  [...events].sort(compareNewestFirst).forEach((event) => {
    if (event.name === "BudgetChanged" && !lastChange.has(event.actor)) lastChange.set(event.actor, event);
  });
  return addresses
    .map((address, index) => {
      const key = lower(address);
      const last = lastChange.get(key);
      return {
        address,
        index,
        label: labels[key] || "",
        isBot: bots.has(key),
        budget: budgets[key] ?? "",
        lastChange: last
          ? {
              blockNumber: last.blockNumber,
              transactionHash: last.transactionHash,
              direction: last.args.increase === "true" ? "increase" : "decrease",
              amount: last.args.amount,
              budgetBefore: last.args.budgetBefore,
              budgetAfter: last.args.budgetAfter,
            }
          : null,
      };
    })
    .sort(
      (a, b) =>
        num(b.lastChange?.blockNumber ?? -1) - num(a.lastChange?.blockNumber ?? -1) || b.index - a.index
    );
};

// Local bot config (localStorage list) -> { labels, bots } keyed by lowercase wallet.
export const mapBotConfig = (list) => {
  const labels = {};
  const bots = new Set();
  (Array.isArray(list) ? list : []).forEach((bot) => {
    const wallet = lower(bot?.wallet);
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) return;
    bots.add(wallet);
    if (bot.name) labels[wallet] = String(bot.name);
  });
  return { labels, bots };
};

// Result of one probe -> a display row. result: {ok, detail, ...} | null when not configured.
export const toServiceRow = (name, result) => {
  if (!result) return { name, status: "not configured", detail: "" };
  return { name, status: result.ok ? "ok" : "down", detail: result.detail || "" };
};

export const joinUrl = (base, path) => `${String(base || "").replace(/\/+$/, "")}${path}`;
