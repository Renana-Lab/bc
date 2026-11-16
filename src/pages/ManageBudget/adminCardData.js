// Pure data mappers for the read-only Admin Zone cards. No network or React here so they unit-test.

export const AUDIT_EVENT_TYPES = [
  "BudgetChanged",
  "GlobalBudgetReset",
  "UserBudgetSet",
  "AuctionCreatedDetailed",
  "AuctionFinalizationFailed",
  "MinimumChanged",
  "AuctionClosedEarly",
  "AuctionCancelled",
  "AuctionHiddenChanged",
  "UserDisabledChanged",
  "SellerEditAllowedChanged",
  "AdminAdded",
  "AdminRemoved",
  "OwnershipTransferred",
  "SellerPaid",
  "SellerPaymentDeferred",
  "RefundProcessed",
];

// Events emitted by the factory (read by address) and by campaigns (read by recent campaign list).
export const FACTORY_AUDIT_EVENTS = AUDIT_EVENT_TYPES.filter(
  (name) => !["SellerPaid", "SellerPaymentDeferred", "RefundProcessed"].includes(name)
);
export const CAMPAIGN_AUDIT_EVENTS = ["SellerPaid", "SellerPaymentDeferred", "RefundProcessed"];

// Campaign events the audit/record views understand but the Audit events card does not list.
const CAMPAIGN_ADDRESS_EVENTS = ["SellerPaid", "SellerPaymentDeferred", "RefundProcessed", "BidRecorded"];

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
    case "GlobalBudgetReset":
      return `epoch ${args.epoch}: default budget ${args.newBudget} by ${args.by}`;
    case "UserBudgetSet":
      return `${args.user}: total ${args.total}, available ${args.available} by ${args.by}`;
    case "MinimumChanged":
      return `${args.campaign}: minimum ${args.oldMinimum} -> ${args.newMinimum} by ${args.by}`;
    case "AuctionClosedEarly":
      return `${args.campaign} closed early by ${args.by}`;
    case "AuctionCancelled":
      return `${args.campaign} cancelled by ${args.by}${args.fundsReleased === "true" ? "" : " (already finalized: hidden only)"}${
        args.note ? `: ${args.note}` : ""
      }`;
    case "AuctionHiddenChanged":
      return `${args.campaign} ${args.hidden === "true" ? "hidden" : "unhidden"} by ${args.by}`;
    case "UserDisabledChanged":
      return `${args.user} ${args.disabled === "true" ? "disabled" : "enabled"} by ${args.by}`;
    case "SellerEditAllowedChanged":
      return `seller minimum edits ${args.allowed === "true" ? "allowed" : "blocked"} by ${args.by}`;
    case "AdminAdded":
      return `${args.admin} added as admin by ${args.by}`;
    case "AdminRemoved":
      return `${args.admin} removed as admin by ${args.by}`;
    case "OwnershipTransferred":
      return `ownership ${args.previousOwner} -> ${args.newOwner}`;
    case "SellerPaymentDeferred":
      return `${args.seller}: ${args.amount} credited for withdrawal (payout failed)`;
    case "SellerPaid":
      return `${args.seller} paid ${args.amount}`;
    case "RefundProcessed":
      return `${args.contributor} refunded ${args.amount}`;
    case "BidRecorded":
      return `${args.bidder} bid ${args.amount} (total ${args.cumulativeBid}, budget ${args.budgetBefore} -> ${args.budgetAfter})`;
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
    auction: lower(
      args.campaignAddress ||
        args.campaign ||
        (CAMPAIGN_ADDRESS_EVENTS.includes(name) ? raw.address : "")
    ),
    actor: lower(args.user || args.seller || args.contributor || args.bidder || args.admin || args.by || ""),
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
// held: lowercase address -> amount reserved by leading bids. disabled: Set of lowercase addresses.
// budgets are "available" (getBudget); total = available + held, which is what setUserBudget takes.
export const mapUserRows = ({
  addresses = [],
  budgets = {},
  events = [],
  labels = {},
  bots = new Set(),
  held = {},
  disabled = new Set(),
}) => {
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
        held: held[key] ?? "0",
        total: /^\d+$/.test(String(budgets[key] ?? "")) && /^\d+$/.test(String(held[key] ?? "0"))
          ? (BigInt(budgets[key]) + BigInt(held[key] ?? "0")).toString()
          : "",
        disabled: disabled.has(key),
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

// ---- per-auction admin rows -------------------------------------------------------------------

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// summary: getListSummary() result [min, balance, approvers, manager, highestBid, description, highestBidder, endTime, closed].
export const mapAuctionAdminRow = ({ address, summary = [], cancelled = false, hidden = false }) => ({
  address,
  minimum: String(summary[0] ?? ""),
  manager: String(summary[3] ?? ""),
  highestBid: String(summary[4] ?? "0"),
  description: String(summary[5] ?? ""),
  hasBids: lower(summary[6]) !== ZERO_ADDRESS && Boolean(summary[6]),
  endTime: num(summary[7]),
  closed: Boolean(summary[8]),
  cancelled: Boolean(cancelled),
  hidden: Boolean(hidden),
});

// Status vocabulary shared with the marketplace admin: active, ended, sold, unsold, cancelled.
//   sold      = finalized with a winner;   unsold = finalized, or ended, without bids
//   ended     = bidding closed with bids but not finalized yet
// "cancelled" is the contract's own word (the marketplace calls it "deleted"). "hidden" is a separate flag.
export const getAuctionAdminStatus = (row, nowSec) => {
  if (row.cancelled) return "cancelled";
  if (row.closed) return row.hasBids ? "sold" : "unsold";
  if (row.endTime > nowSec) return "active";
  return row.hasBids ? "ended" : "unsold";
};

// Mirrors the contract preconditions so the UI only offers actions that can succeed.
export const getAdminActionAvailability = (row, nowSec) => {
  const status = getAuctionAdminStatus(row, nowSec);
  const finalized = Boolean(row.closed) && status !== "cancelled";
  return {
    status,
    editMinimum: status === "active" && !row.hasBids,
    closeNow: status === "active",
    cancel: status !== "cancelled",
    cancelHidesOnly: finalized,
    toggleHidden: true,
  };
};

// Seller edit-minimum has the same preconditions as the admin one, plus the factory toggle.
export const canSellerEditMinimum = ({ row, account, nowSec, allowSellerEdit }) =>
  Boolean(allowSellerEdit) &&
  lower(account) === lower(row.manager) &&
  getAdminActionAvailability(row, nowSec).editMinimum;

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

// Newest-first paging with search over description and address. `rows` is ordered newest first.
export const AUCTION_ADMIN_PAGE_SIZE = 30;
export const pageAuctionRows = ({ rows = [], query = "", visible = AUCTION_ADMIN_PAGE_SIZE } = {}) => {
  const needle = lower(query).trim();
  const matches = needle
    ? rows.filter((row) => lower(row.description).includes(needle) || lower(row.address).includes(needle))
    : rows;
  return { rows: matches.slice(0, visible), total: matches.length, hasMore: matches.length > visible };
};

// Two-second-resolution countdown text; "ended" once the end time has passed.
export const formatCountdown = (endTimeSec, nowSec) => {
  const left = Math.floor(Number(endTimeSec) - Number(nowSec));
  if (!Number.isFinite(left) || left <= 0) return "ended";
  const days = Math.floor(left / 86400);
  const hours = Math.floor((left % 86400) / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = left % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return days ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};
