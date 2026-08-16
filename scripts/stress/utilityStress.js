/* global BigInt */
const assert = require("assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const { pathToFileURL } = require("url");
const babel = require("@babel/core");
const transformModules = require("@babel/plugin-transform-modules-commonjs");
const presetReact = require("@babel/preset-react");

const projectRoot = path.resolve(__dirname, "..", "..");

const loadSourceModule = (relativePath, mocks = {}) => {
  const filename = path.join(projectRoot, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const transformed = babel.transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    presets: [[presetReact, { runtime: "classic" }]],
    plugins: [transformModules],
  });
  const loadedModule = new Module(filename, module);
  loadedModule.filename = filename;
  loadedModule.paths = Module._nodeModulePaths(path.dirname(filename));
  loadedModule.require = (request) =>
    Object.prototype.hasOwnProperty.call(mocks, request)
      ? mocks[request]
      : Module.prototype.require.call(loadedModule, request);
  loadedModule._compile(transformed.code, filename);
  return loadedModule.exports;
};

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

global.window = {
  BigInt,
  localStorage: memoryStorage(),
  setTimeout,
  dispatchEvent: () => {},
  addEventListener: () => {},
};
global.Event = class Event {};

class FakeWeb3 {
  constructor() {
    this.eth = {
      accounts: {
        privateKeyToAccount: (privateKey) => ({
          address: `0x${privateKey.slice(-40)}`,
        }),
      },
    };
  }
}

const noOpComponent = () => null;
const muiMock = new Proxy({}, { get: () => noOpComponent });
const reactMock = {
  createElement: () => null,
  useCallback: (value) => value,
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
};

const bulk = loadSourceModule(
  "src/pages/ManageBudget/bulkAuctionUtils.js"
);
const reports = loadSourceModule("src/pages/ManageBudget/reportUtils.js", {
  "../../real_ethereum/readOnly": { readOnlyCall: async () => null },
});
const activeAuctions = loadSourceModule(
  "src/real_ethereum/activeAuctionRegistry.js",
  {
    "./readOnly": {
      readOnlyCall: async () => [],
      readOnlyBatchCall: async () => [],
      readOnlyExecute: async () => ({ auctions: [], latestBlock: 1, scannedToBlock: 1 }),
    },
    "./marketConfig": {
      getActiveFactoryAddress: () =>
        "0x0000000000000000000000000000000000000001",
    },
  },
);
const bots = loadSourceModule(
  "src/pages/ManageBudget/BotnetControlPanel.js",
  {
    react: reactMock,
    "@mui/material": muiMock,
    "react-hot-toast": { success: () => {}, error: () => {} },
    web3: FakeWeb3,
    "../../real_ethereum/build/CampaignFactory.json": { abi: [] },
    "../../real_ethereum/build/Campaign.json": { abi: [] },
    "../../real_ethereum/marketConfig": {
      getActiveFactoryAddress: () => "0x0000000000000000000000000000000000000001",
    },
    "../../real_ethereum/activeAuctionRegistry": {
      acquireActiveAuctionCoordinatorLease: () => true,
      markAuctionClosed: () => {},
      publishActiveAuctions: () => {},
      refreshActiveAuctionRegistry: async () => [],
      releaseActiveAuctionCoordinatorLease: () => {},
    },
    "../../real_ethereum/rpcConfig": {
      getConfiguredRpcUrls: () => [],
      getFriendlyRpcError: (value) => String(value),
      getRpcErrorMessage: (value) => String(value?.message || value || ""),
      getRpcFailureKind: () => "unknown",
      isRpcProviderFailure: () => false,
    },
  }
);

const timed = async (label, callback) => {
  const startedAt = Date.now();
  await callback();
  return { label, durationMs: Date.now() - startedAt };
};

const makeReport = (index, withBid = false) => ({
  auction: {
    index,
    address: `0x${index.toString(16).padStart(40, "0")}`,
    minimumContribution: "100",
    balance: withBid ? "100" : "0",
    approversCount: withBid ? 1 : 0,
    seller: "0x1111111111111111111111111111111111111111",
    highestBid: withBid ? "100" : "0",
    dataForSell: "payload",
    dataDescription: `Auction ${index}`,
    highestBidder: withBid
      ? "0x2222222222222222222222222222222222222222"
      : "0x0000000000000000000000000000000000000000",
    addresses: withBid
      ? ["0x2222222222222222222222222222222222222222"]
      : [],
    endTime: "1780000000",
    closed: false,
    closedReadError: "",
  },
  ended: true,
  transactions: withBid
    ? [
        {
          bidder: "0x2222222222222222222222222222222222222222",
          bidderKey: "0x2222222222222222222222222222222222222222",
          transactionAmountWei: "100",
          cumulativeBidWei: "100",
          contractCumulativeBidWei: "100",
          budgetBeforeBidWei: "2000",
          budgetAfterBidWei: "1900",
          budgetSnapshotSource: "Contract",
          previousHighestBidder: "0x0000000000000000000000000000000000000000",
          previousHighestBidWei: "0",
          time: "",
          isoTime: "",
          isHighestBid: true,
        },
      ]
    : [],
  bidderStatuses: [],
});

const run = async () => {
  const results = [];
  const planner = await import(
    pathToFileURL(path.join(projectRoot, "src", "botnet", "cyclePlanner.mjs")).href
  );

  results.push(
    await timed("bulk parsing and validation", async () => {
      const [quoted] = bulk.parseBulkAuctions(
        '"Study, phase 1","payload, private",100,10'
      );
      assert.equal(quoted.dataDescription, "Study, phase 1");
      assert.equal(quoted.dataForSell, "payload, private");

      const rows = bulk.makeBulkAuctionRows({
        rowCount: bulk.BULK_MAX_AUCTIONS,
        minimumContribution: "999999999999999999999999999999999999",
        auctionDuration: "30",
        descriptionPrefix: 'Stress | "quoted"',
        dataPrefix: "Payload",
      });
      const roundTrip = bulk.parseBulkAuctions(
        bulk.serializeBulkAuctions(rows)
      );
      assert.equal(roundTrip.length, bulk.BULK_MAX_AUCTIONS);
      assert.equal(roundTrip[29].dataDescription, rows[29].dataDescription);
      assert.match(
        bulk.getAuctionValidationError({
          minimumContribution: "1",
          auctionDuration: "1",
        }),
        /data for sale/i
      );
      assert.match(
        bulk.getAuctionValidationError({
          minimumContribution: "1.5",
          auctionDuration: "1",
          dataForSell: "data",
          dataDescription: "description",
        }),
        /whole number/i
      );

      const tenThousandRows = Array.from(
        { length: 10000 },
        (_, index) => `Auction ${index},Data ${index},${index + 1},30`
      ).join("\n");
      assert.equal(bulk.parseBulkAuctions(tenThousandRows).length, 10000);
    })
  );

  results.push(
    await timed("report concurrency and export integrity", async () => {
      let active = 0;
      let peak = 0;
      const input = Array.from({ length: 5000 }, (_, index) => index);
      const mapped = await reports.mapWithConcurrency(input, 32, async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return value * 2;
      });
      assert.equal(mapped.length, input.length);
      assert.equal(mapped[4999], 9998);
      assert.ok(peak <= 32);
      assert.deepEqual(
        await reports.mapWithConcurrency([1, 2, 3], 0, async (value) => value),
        [1, 2, 3]
      );
      assert.deepEqual(
        ["9", "100000000000000000000000", "10"].sort(
          reports.compareWeiDesc
        ),
        ["100000000000000000000000", "10", "9"]
      );
      assert.equal(reports.toDateInputValue(Number.POSITIVE_INFINITY), "");

      const reportRows = Array.from({ length: 500 }, (_, index) =>
        makeReport(index + 1, index % 3 === 0)
      );
      const sheets = reports.buildReportSheets(reportRows, []);
      const payload = reports.buildReportPayload(reportRows, []);
      const allBids = sheets.find((sheet) => sheet.name === "All Bids");
      assert.equal(payload.auctions.length, 500);
      assert.equal(allBids.rows.length, 500);
      assert.equal(
        allBids.rows.filter((row) => row["Row Type"] === "No bids").length,
        payload.totals.zeroBidAuctions
      );
    })
  );

  results.push(
    await timed("shared active-auction registry", async () => {
      const factoryAddress = "0x0000000000000000000000000000000000000001";
      activeAuctions.__resetActiveAuctionRegistryForTests();
      for (let index = 0; index < 5000; index += 1) {
        const auctionIndex = index % 250;
        activeAuctions.publishActiveAuctions(factoryAddress, [
          {
            address: `0x${(auctionIndex + 1).toString(16).padStart(40, "0")}`,
            minimumContribution: "100",
            approversCount: 1,
            highestBid: String(index),
            endTimeSec: Math.floor(Date.now() / 1000) + 1800,
            closed: false,
          },
        ]);
      }
      const snapshot = activeAuctions.getActiveAuctionSnapshot(factoryAddress);
      assert.equal(snapshot.activeAuctions.length, 250);
      assert.equal(
        new Set(snapshot.activeAuctions.map((auction) => auction.address)).size,
        250,
      );
    }),
  );

  results.push(
    await timed("bot key ingestion and bid decisions", async () => {
      const privateKeys = Array.from({ length: 1000 }, (_, index) =>
        BigInt(index + 1).toString(16).padStart(64, "0")
      );
      const keyText = privateKeys
        .flatMap((key, index) => [`BOT_${index}=0x${key}`, key])
        .join("\n");
      const extracted = bots.extractPrivateKeysFromText(keyText);
      assert.equal(extracted.length, 1000);
      assert.ok(extracted.every(bots.isValidPrivateKey));

      const normalized = bots.normalizeBot({
        id: "stale",
        name: "Stale",
        privateKey: privateKeys[0],
        running: true,
        status: "running-cycle",
        lastCycleAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });
      assert.equal(normalized.status, "running");
      assert.match(normalized.lastError, /interrupted/i);

      const strategy = {
        maxBidWei: 2000n,
        outbidByWei: 10n,
        maxMinContributionWei: 2000n,
        minTimeRemainingSec: 20,
        skipIfWinning: true,
      };
      let seed = 0x12345678;
      const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed;
      };

      for (let index = 0; index < 20000; index += 1) {
        const highestBid = BigInt(random() % 2300);
        const myBid = BigInt(random() % (Number(highestBid) + 1));
        const budget = BigInt(random() % 2500);
        const candidate = {
          isActive: random() % 5 !== 0,
          isManager: random() % 13 === 0,
          secondsLeft: random() % 300,
          isWinner: random() % 7 === 0,
          minimumContribution: BigInt((random() % 2200) + 1),
          approversCount: random() % 20,
          highestBid,
          myBid,
        };
        const decision = bots.getBidDecision(candidate, budget, strategy);
        if (decision.bid) {
          assert.ok(candidate.isActive);
          assert.ok(!candidate.isManager);
          assert.ok(!candidate.isWinner);
          assert.ok(decision.amountWei > 0n);
          assert.ok(decision.amountWei <= budget);
          assert.ok(decision.targetBid <= strategy.maxBidWei);
          assert.ok(
            candidate.minimumContribution <= strategy.maxMinContributionWei
          );
        }
      }
    })
  );

  results.push(
    await timed("coordinated bot planner at scale", async () => {
      const makeAddress = (index) =>
        `0x${index.toString(16).padStart(40, "0")}`;
      const historical = Array.from({ length: 1000 }, (_, index) => ({
        address: makeAddress(index + 1),
        closed: true,
        endTimeSec: 1900000000,
      }));
      const active = Array.from({ length: 50 }, (_, index) => ({
        address: makeAddress(index + 2000),
        minimumContribution: "100",
        approversCount: 0,
        manager: makeAddress(index + 5000),
        highestBid: "0",
        highestBidder: makeAddress(0),
        endTimeSec: 2000001000 + index,
        closed: false,
      }));
      const plannerBots = Array.from({ length: 100 }, (_, index) => ({
        id: `bot-${index}`,
        wallet: makeAddress(index + 100),
        strategy: {
          maxBidsPerCycle: (index % 5) + 1,
          maxBidWei: 2000n,
          outbidByWei: 10n,
          maxMinContributionWei: 2000n,
          minTimeRemainingSec: 20,
          skipIfWinning: true,
        },
      }));

      let cursor = 0;
      for (let round = 0; round < 1000; round += 1) {
        const plan = planner.allocateCycleCandidates({
          bots: plannerBots,
          auctions: active,
          cursor,
          nowSec: 2000000000,
        });
        cursor = plan.nextCursor;
        const assigned = Object.values(plan.assignments).flatMap((assignment) => [
          ...assignment.primary,
          ...assignment.reserve,
        ]);
        assert.ok(assigned.length <= active.length);
        assert.equal(new Set(assigned.map((auction) => auction.address)).size, assigned.length);
        assert.ok(plan.candidatesEvaluated < plannerBots.length * (historical.length + active.length));
      }
    })
  );

  const totalMs = results.reduce((total, result) => total + result.durationMs, 0);
  results.forEach(({ label, durationMs }) => {
    console.log(`[stress] PASS ${label} (${durationMs}ms)`);
  });
  console.log(
    `[stress] PASS: 5 utility groups, 10,000 imports, 5,000 report jobs, 500 report auctions, 5,000 registry updates, 1,000 keys, 20,000 bot decisions, 100,000 bot-round plans (${totalMs}ms)`
  );
};

run().catch((error) => {
  console.error("[stress] FAIL", error);
  process.exitCode = 1;
});
