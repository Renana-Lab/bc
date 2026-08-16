import { readOnlyBatchCall, readOnlyCall, readOnlyExecute } from "./readOnly";
import {
  __resetActiveAuctionRegistryForTests,
  acquireActiveAuctionCoordinatorLease,
  getActiveAuctionSnapshot,
  getActiveAuctionStateHistory,
  getCreatedAuctionAddress,
  markAuctionClosed,
  publishActiveAuctions,
  refreshActiveAuctionRegistry,
  registerCreatedAuctionReceipt,
  startActiveAuctionRegistrySync,
  subscribeActiveAuctionRegistry,
} from "./activeAuctionRegistry";

jest.mock("./readOnly", () => ({
  readOnlyBatchCall: jest.fn(),
  readOnlyCall: jest.fn(),
  readOnlyExecute: jest.fn(),
}));

describe("active auction registry", () => {
  const factoryAddress = "0x1111111111111111111111111111111111111111";
  const manager = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let now;
  let summaries;
  let requestedAddresses;

  const addressAt = (index) => `0x${index.toString(16).padStart(40, "0")}`;
  const makeAuction = (index, overrides = {}) => ({
    address: addressAt(index),
    minimumContribution: "100",
    approversCount: 0,
    manager,
    highestBid: "0",
    highestBidder: "0x0000000000000000000000000000000000000000",
    endTimeSec: Math.floor(now / 1000) + 300,
    closed: false,
    ...overrides,
  });
  const toSummary = (auction) => [
    auction.minimumContribution,
    "0",
    String(auction.approversCount),
    auction.manager,
    auction.highestBid,
    "description",
    auction.highestBidder,
    String(auction.endTimeSec),
    auction.closed,
  ];

  beforeEach(() => {
    now = 2_000_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    window.localStorage.clear();
    __resetActiveAuctionRegistryForTests();
    summaries = new Map();
    requestedAddresses = [];
    readOnlyCall.mockReset();
    readOnlyBatchCall.mockReset();
    readOnlyExecute.mockReset();
    readOnlyExecute.mockResolvedValue({
      auctions: [],
      latestBlock: 1000,
      scannedToBlock: 1000,
    });
    readOnlyBatchCall.mockImplementation(async (createCalls) => {
      const calls = createCalls({
        campaign: (address) => ({
          methods: {
            getListSummary: () => ({ registryTestAddress: address }),
          },
        }),
      });
      return calls.map((call) => {
        requestedAddresses.push(call.registryTestAddress);
        const summary = summaries.get(call.registryTestAddress.toLowerCase());
        return summary
          ? { status: "fulfilled", value: summary }
          : { status: "rejected", reason: new Error("unreadable") };
      });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("keeps open auctions and accepts millisecond timestamps from the UI", () => {
    const snapshot = publishActiveAuctions(factoryAddress, [
      makeAuction(2, { endTime: now + 60000, endTimeSec: 0 }),
      makeAuction(3, { endTime: now - 60000, endTimeSec: 0, closed: true }),
    ]);

    expect(snapshot.activeAuctions).toHaveLength(1);
    expect(snapshot.activeAuctions[0].address).toBe(addressAt(2));
    expect(snapshot.activeAuctions[0].endTimeSec).toBeGreaterThan(
      Math.floor(now / 1000),
    );
  });

  test("moves ended auctions with bids into the finalization queue", () => {
    publishActiveAuctions(factoryAddress, [makeAuction(4, { approversCount: 2 })]);
    now += 301000;

    const snapshot = getActiveAuctionSnapshot(factoryAddress);
    expect(snapshot.activeAuctions).toHaveLength(0);
    expect(snapshot.finalizableAuctions.map((auction) => auction.address)).toEqual([
      addressAt(4),
    ]);
  });

  test("keeps a just-ended zero-bid auction long enough to verify late bids", () => {
    publishActiveAuctions(factoryAddress, [makeAuction(41)]);
    now += 301000;

    let snapshot = getActiveAuctionSnapshot(factoryAddress);
    expect(snapshot.finalizableAuctions.map((auction) => auction.address)).toContain(
      addressAt(41),
    );

    now += 121000;
    snapshot = getActiveAuctionSnapshot(factoryAddress);
    expect(snapshot.finalizableAuctions.map((auction) => auction.address)).not.toContain(
      addressAt(41),
    );
  });

  test("removes a finalized auction immediately", () => {
    publishActiveAuctions(factoryAddress, [makeAuction(5, { approversCount: 1 })]);
    const snapshot = markAuctionClosed(factoryAddress, addressAt(5));

    expect(snapshot.activeAuctions).toHaveLength(0);
    expect(snapshot.finalizableAuctions).toHaveLength(0);
  });

  test("records deduplicated open, deadline, and close states with a range baseline", () => {
    const auction = makeAuction(52, {
      approversCount: 1,
      endTimeSec: Math.floor(now / 1000) + 10,
    });
    publishActiveAuctions(factoryAddress, [auction], "created-test");
    now += 1000;
    publishActiveAuctions(factoryAddress, [auction], "unchanged-heartbeat");
    expect(getActiveAuctionStateHistory(factoryAddress)).toHaveLength(1);

    const rangeStart = now + 1000;
    now += 9000;
    publishActiveAuctions(factoryAddress, [auction], "deadline-test");
    now += 1000;
    markAuctionClosed(factoryAddress, auction.address, "finalized-test");

    const history = getActiveAuctionStateHistory(factoryAddress, {
      fromMs: rangeStart,
      toMs: now,
      includeBaseline: true,
    });
    expect(history).toHaveLength(3);
    expect(history[0].boundaryRole).toBe("Baseline at range start");
    expect(history[0].activeAuctions).toHaveLength(1);
    expect(history[1].finalizableAuctions).toHaveLength(1);
    expect(history[2].activeAuctions).toHaveLength(0);
    expect(history[2].finalizableAuctions).toHaveLength(0);
  });

  test("keeps list history bounded under unchanged high-frequency refreshes", () => {
    const auction = makeAuction(53);
    for (let index = 0; index < 1000; index += 1) {
      now += 10;
      publishActiveAuctions(factoryAddress, [auction], `heartbeat-${index}`);
    }
    expect(getActiveAuctionStateHistory(factoryAddress)).toHaveLength(1);
  });

  test("reclassifies an auction at its deadline without waiting for a bot cycle", async () => {
    let stop = () => {};
    try {
      const auction = makeAuction(51, {
        approversCount: 1,
        endTimeSec: Math.floor(now / 1000) + 2,
      });
      publishActiveAuctions(factoryAddress, [auction]);
      readOnlyCall.mockResolvedValue([auction.address]);
      summaries.set(auction.address.toLowerCase(), toSummary(auction));

      now += 2200;
      stop = startActiveAuctionRegistrySync(factoryAddress, { intervalMs: 10000 });
      await new Promise((resolve) => setTimeout(resolve, 75));

      const snapshot = getActiveAuctionSnapshot(factoryAddress);
      expect(snapshot.activeAuctions).toHaveLength(0);
      expect(snapshot.finalizableAuctions.map((item) => item.address)).toContain(
        auction.address,
      );
    } finally {
      stop();
    }
  });

  test("merges updates without duplicating auction addresses", () => {
    publishActiveAuctions(factoryAddress, [makeAuction(6)]);
    const snapshot = publishActiveAuctions(factoryAddress, [
      makeAuction(6, { highestBid: "500", approversCount: 1 }),
      makeAuction(7),
    ]);

    expect(snapshot.activeAuctions).toHaveLength(2);
    expect(snapshot.activeAuctions.find((auction) => auction.address === addressAt(6)))
      .toMatchObject({ highestBid: "500", approversCount: 1 });
  });

  test("registers a newly created auction directly from its transaction receipt", () => {
    const receipt = {
      events: {
        AuctionCreatedDetailed: {
          returnValues: { auction: addressAt(8) },
        },
      },
    };
    const listener = jest.fn();
    const unsubscribe = subscribeActiveAuctionRegistry(listener);

    const snapshot = registerCreatedAuctionReceipt(factoryAddress, receipt, makeAuction(8));
    unsubscribe();

    expect(getCreatedAuctionAddress(receipt)).toBe(addressAt(8));
    expect(snapshot.activeAuctions[0].address).toBe(addressAt(8));
    expect(listener).toHaveBeenCalled();
  });

  test("deduplicates simultaneous chain refreshes", async () => {
    const addresses = Array.from({ length: 100 }, (_, index) => addressAt(index + 20));
    addresses.forEach((address, index) => {
      summaries.set(address.toLowerCase(), toSummary(makeAuction(index + 20)));
    });
    readOnlyCall.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(addresses), 10)),
    );

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        refreshActiveAuctionRegistry(factoryAddress, { force: true }),
      ),
    );

    expect(readOnlyCall).toHaveBeenCalledTimes(1);
    expect(results.every((snapshot) => snapshot === results[0])).toBe(true);
    expect(new Set(requestedAddresses).size).toBe(100);
  });

  test("does not drop a creation published while a chain refresh is in flight", async () => {
    const existing = makeAuction(61);
    const createdDuringRefresh = makeAuction(62);
    publishActiveAuctions(factoryAddress, [existing]);
    readOnlyCall.mockResolvedValue([existing.address]);
    summaries.set(existing.address.toLowerCase(), toSummary(existing));

    let releaseBatch;
    let signalBatchStarted;
    const batchStarted = new Promise((resolve) => {
      signalBatchStarted = resolve;
    });
    readOnlyBatchCall.mockImplementationOnce(
      () => new Promise((resolve) => {
        signalBatchStarted();
        releaseBatch = () => resolve([
          { status: "fulfilled", value: toSummary(existing) },
        ]);
      }),
    );
    const refresh = refreshActiveAuctionRegistry(factoryAddress, { force: true });
    await batchStarted;
    registerCreatedAuctionReceipt(
      factoryAddress,
      {
        events: {
          AuctionCreatedDetailed: {
            returnValues: { campaignAddress: createdDuringRefresh.address },
          },
        },
      },
      createdDuringRefresh,
    );
    releaseBatch();
    const snapshot = await refresh;

    expect(snapshot.activeAuctions.map((auction) => auction.address)).toEqual(
      expect.arrayContaining([existing.address, createdDuringRefresh.address]),
    );
  });

  test("repairs historical coverage in bounded rolling pages", async () => {
    const addresses = Array.from({ length: 200 }, (_, index) => addressAt(index + 300));
    addresses.forEach((address, index) => {
      summaries.set(
        address.toLowerCase(),
        toSummary(makeAuction(index + 300, { closed: true })),
      );
    });
    readOnlyCall.mockResolvedValue(addresses);

    let snapshot;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      requestedAddresses = [];
      snapshot = await refreshActiveAuctionRegistry(factoryAddress, { force: true });
      expect(requestedAddresses.length).toBeLessThanOrEqual(120);
      now += 16000;
    }

    expect(snapshot.reconcileCursor).toBe(0);
    expect(snapshot.lastFullReconcileAt).toBeGreaterThan(0);
    expect(snapshot.knownAddressCount).toBe(200);
  });

  test("preserves a tracked auction when one summary read is temporarily unreadable", async () => {
    const auction = makeAuction(900);
    publishActiveAuctions(factoryAddress, [auction]);
    readOnlyCall.mockResolvedValue([auction.address]);
    now += 16000;

    const snapshot = await refreshActiveAuctionRegistry(factoryAddress, { force: true });
    expect(snapshot.activeAuctions.map((item) => item.address)).toContain(auction.address);
    expect(snapshot.unreadableCount).toBe(1);
  });

  test("rejects coordinator leadership while another live tab owns the lease", () => {
    window.localStorage.setItem(
      `data-market:active-auctions:coordinator-lease:${factoryAddress}`,
      JSON.stringify({ owner: "another-tab", expiresAt: now + 60000 }),
    );

    expect(acquireActiveAuctionCoordinatorLease(factoryAddress)).toBe(false);
  });

  test("stress: handles 5000 publications while retaining one row per auction", () => {
    for (let index = 0; index < 5000; index += 1) {
      const auctionIndex = index % 250;
      publishActiveAuctions(factoryAddress, [
        makeAuction(1000 + auctionIndex, {
          highestBid: String(index),
          approversCount: 1,
        }),
      ]);
    }

    const snapshot = getActiveAuctionSnapshot(factoryAddress);
    expect(snapshot.activeAuctions).toHaveLength(250);
    expect(new Set(snapshot.activeAuctions.map((auction) => auction.address)).size).toBe(250);
    expect(snapshot.activeAuctions.every((auction) => Number(auction.highestBid) >= 4750))
      .toBe(true);
  });
});
