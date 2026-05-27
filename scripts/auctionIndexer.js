const http = require("http");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const Web3 = require("web3");
const campaignJson = require("../src/real_ethereum/build/Campaign.json");
const factoryJson = require("../src/real_ethereum/build/CampaignFactory.json");
const { loadFactoryAddress } = require("./factoryAddressLoader");

const DEFAULT_RPC_URLS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://1rpc.io/sepolia",
];
const DEFAULT_WS_URL = "wss://sepolia.infura.io/ws/v3/b27d53291ceb44bd864dbf7b0eb55581";
const PORT = Number(process.env.AUCTION_INDEXER_PORT || 8787);
const REFRESH_INTERVAL_MS = Number(process.env.AUCTION_INDEXER_REFRESH_MS || 60000);
const FETCH_CONCURRENCY = Number(process.env.AUCTION_INDEXER_CONCURRENCY || 5);

const RPC_URLS = [
  ...(process.env.RPC_URLS || process.env.REACT_APP_RPC_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
  process.env.RPC_URL,
  process.env.INFURA_KEY ? `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}` : "",
  ...DEFAULT_RPC_URLS,
].filter((url, index, urls) => url && urls.indexOf(url) === index);

const WS_URL =
  process.env.WS_RPC_URL ||
  process.env.REACT_APP_WS_RPC_URL ||
  (process.env.INFURA_KEY ? `wss://sepolia.infura.io/ws/v3/${process.env.INFURA_KEY}` : "") ||
  DEFAULT_WS_URL;
const FACTORY_ADDRESS = loadFactoryAddress();

const web3Clients = RPC_URLS.map((url) => ({ url, web3: new Web3(url) }));
const socketWeb3 = new Web3(new Web3.providers.WebsocketProvider(WS_URL));
let nextRpcIndex = 0;
const auctions = new Map();
let auctionOrder = [];
const subscriptions = new Map();

const normalizeSearchText = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\bwei\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getClient = (offset = 0) =>
  web3Clients[(nextRpcIndex + offset) % web3Clients.length];

const isRateLimitError = (error) => {
  const message = JSON.stringify(error?.message || error || "");
  return message.includes("429") || message.includes("Too Many Requests");
};

async function withRpcRetry(task, retries = web3Clients.length + 1) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const client = getClient(attempt);

    try {
      return await task(client.web3);
    } catch (error) {
      lastError = error;

      if (!isRateLimitError(error) || attempt === retries - 1) {
        throw error;
      }

      nextRpcIndex = (nextRpcIndex + 1) % web3Clients.length;
      await wait(750 * (attempt + 1));
    }
  }

  throw lastError;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

const factoryFor = (web3) => new web3.eth.Contract(factoryJson.abi, FACTORY_ADDRESS);
const campaignFor = (web3, address) =>
  new web3.eth.Contract(campaignJson.abi, address);

async function readAuction(address, userAddress = "") {
  const normalizedUser = userAddress.toLowerCase();

  try {
    const details = await withRpcRetry((web3) =>
      campaignFor(web3, address).methods.getListSummary().call()
    );
    let addresses = [];
    let isRefunded = false;

    if (normalizedUser) {
      const status = await withRpcRetry((web3) =>
        campaignFor(web3, address).methods.getUserAuctionStatus(normalizedUser).call()
      );
      const userParticipated = Boolean(status[0]);
      addresses = userParticipated ? [normalizedUser] : [];
      isRefunded = Boolean(status[2]);
    }

    return {
      address,
      listOrder: auctionOrder.indexOf(address.toLowerCase()),
      minimumContribution: details[0],
      balance: details[1],
      approversCount: details[2],
      manager: details[3],
      highestBid: details[4],
      dataForSell: "",
      dataDescription: details[5],
      highestBidder: details[6],
      addresses,
      endTime: Number(details[7]) * 1000,
      isRefunded,
      closed: Boolean(details[8]),
    };
  } catch (error) {
    const details = await withRpcRetry((web3) =>
      campaignFor(web3, address).methods.getSummary().call()
    );
    const addresses = details[8] || [];
    const auctionEnded = Number(details[9]) * 1000 < Date.now();
    const closed = auctionEnded
      ? await withRpcRetry((web3) =>
          campaignFor(web3, address).methods.getStatus().call()
        )
      : false;
    const isHighestBidder =
      normalizedUser && details[7].toLowerCase() === normalizedUser;
    const isManager = normalizedUser && details[3].toLowerCase() === normalizedUser;
    const userInAuction =
      normalizedUser &&
      addresses.some((participant) => participant.toLowerCase() === normalizedUser);
    let isRefunded = false;

    if (userInAuction && auctionEnded && !isHighestBidder && !isManager) {
      const bid = await withRpcRetry((web3) =>
        campaignFor(web3, address).methods.getBid(normalizedUser).call()
      );
      isRefunded = Number(bid) === 0;
    }

    return {
      address,
      listOrder: auctionOrder.indexOf(address.toLowerCase()),
      minimumContribution: details[0],
      balance: details[1],
      approversCount: details[2],
      manager: details[3],
      highestBid: details[4],
      dataForSell: details[5],
      dataDescription: details[6],
      highestBidder: details[7],
      addresses,
      endTime: Number(details[9]) * 1000,
      isRefunded,
      closed: Boolean(closed),
    };
  }
}

async function refreshAuction(address) {
  try {
    const auction = await readAuction(address);
    auctions.set(address.toLowerCase(), auction);
    subscribeToAuction(address);
    return auction;
  } catch (error) {
    console.warn(`Failed to refresh auction ${address}:`, error.message || error);
    return null;
  }
}

async function refreshAllAuctions() {
  const deployed = await withRpcRetry((web3) =>
    factoryFor(web3).methods.getDeployedCampaigns().call()
  );
  auctionOrder = deployed.map((address) => address.toLowerCase());

  await mapWithConcurrency(deployed, FETCH_CONCURRENCY, refreshAuction);
  console.log(`Indexed ${auctions.size} auctions`);
}

function subscribeToAuction(address) {
  const key = address.toLowerCase();
  if (subscriptions.has(key)) return;

  try {
    const campaign = campaignFor(socketWeb3, address);
    const eventNames = ["BidAdded", "RefundProcessed", "SellerPaid"];
    const activeSubscriptions = eventNames.map((eventName) =>
      campaign.events[eventName]()
        .on("data", () => refreshAuction(address))
        .on("error", (error) =>
          console.warn(`${eventName} subscription failed for ${address}:`, error)
        )
    );
    subscriptions.set(key, activeSubscriptions);
  } catch (error) {
    console.warn(`Could not subscribe to auction ${address}:`, error.message || error);
  }
}

function subscribeToFactory() {
  try {
    const factory = new socketWeb3.eth.Contract(factoryJson.abi, FACTORY_ADDRESS);

    factory.events
      .AuctionCreated()
      .on("data", (event) => {
        const address = event.returnValues.campaignAddress;
        auctionOrder.push(address.toLowerCase());
        refreshAuction(address);
      })
      .on("error", (error) =>
        console.warn("AuctionCreated subscription failed:", error)
      );
  } catch (error) {
    console.warn("Could not subscribe to factory events:", error.message || error);
  }
}

function filterAuctions(data, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return data;

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

  return data.filter((auction) => {
    const searchText = normalizeSearchText(
      [
        auction.address,
        auction.manager,
        auction.highestBidder,
        auction.dataDescription,
        auction.highestBid,
        `${auction.highestBid} wei`,
        auction.minimumContribution,
        `${auction.minimumContribution} wei`,
        auction.approversCount,
        ...(auction.addresses || []),
      ].join(" ")
    );

    return (
      searchText.includes(normalizedQuery) ||
      tokens.every((token) => searchText.includes(token))
    );
  });
}

async function getAuctionResponse(params) {
  const limit = Math.max(1, Number(params.get("limit") || 20));
  const user = (params.get("user") || "").toLowerCase();
  const query = params.get("q") || "";
  const ordered = auctionOrder
    .map((address) => auctions.get(address))
    .filter(Boolean);
  const withUserState = user
    ? await mapWithConcurrency(ordered, FETCH_CONCURRENCY, (auction) =>
        readAuction(auction.address, user)
      )
    : ordered;
  const filtered = filterAuctions(withUserState.filter(Boolean), query);

  return {
    data: filtered.slice(-limit),
    total: filtered.length,
    indexedTotal: auctions.size,
    updatedAt: Date.now(),
  };
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, indexedTotal: auctions.size }));
      return;
    }

    if (url.pathname === "/auctions") {
      const payload = await getAuctionResponse(url.searchParams);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error("Request failed:", error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Internal server error" }));
  }
});

async function start() {
  if (!web3Clients.length) {
    throw new Error("No RPC URLs configured");
  }

  await refreshAllAuctions();
  subscribeToFactory();
  setInterval(refreshAllAuctions, REFRESH_INTERVAL_MS);

  server.listen(PORT, () => {
    console.log(`Auction indexer listening on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Auction indexer failed to start:", error);
  process.exit(1);
});
