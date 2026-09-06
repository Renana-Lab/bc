/* eslint-env node */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const Web3Package = require("web3");
const Web3 = Web3Package.Web3 || Web3Package;
const factoryArtifact = require("../../src/real_ethereum/build/CampaignFactory.json");
const campaignArtifact = require("../../src/real_ethereum/build/Campaign.json");

const ROOT = path.resolve(__dirname, "../..");
const RUN_DIR = path.join(ROOT, "experiment-data", "runs");
const DEFAULT_RPC_URLS = [
  "https://sepolia.gateway.tenderly.co",
  "https://sepolia.rpc.thirdweb.com",
  "https://ethereum-sepolia-rpc.publicnode.com",
];
const WRITE_CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.EXPERIMENT_WRITE_CONCURRENCY || 3)));
const POLL_MS = Math.max(1000, Number(process.env.EXPERIMENT_POLL_MS || 2500));

const getArg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (value) => String(value || "").toLowerCase();
const asBigInt = (value) => BigInt(value?.toString?.() || value || 0);
const percentile = (values = [], ratio = 0.5) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
};

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  async use(operation) {
    if (this.active >= this.limit) await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
    try { return await operation(); } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

const rpcUrls = () => {
  const infuraKey = String(process.env.INFURA_KEY || process.env.REACT_APP_INFURA_KEY || "").trim();
  return [...new Set([
    ...String(process.env.RPC_URLS || process.env.REACT_APP_RPC_URLS || "").split(","),
    process.env.RPC_URL,
    process.env.REACT_APP_RPC_URL,
    infuraKey ? `https://sepolia.infura.io/v3/${infuraKey}` : "",
    ...DEFAULT_RPC_URLS,
  ].map((url) => String(url || "").trim()).filter(Boolean))];
};

class RpcPool {
  constructor() {
    this.providers = rpcUrls().map((url) => ({
      url,
      web3: new Web3(new Web3.providers.HttpProvider(url, { timeout: 15_000 })),
      cooldownUntil: 0,
    }));
    this.cursor = 0;
  }
  ordered() {
    const now = Date.now();
    const available = this.providers.filter((provider) => provider.cooldownUntil <= now);
    const source = available.length ? available : this.providers;
    return source.map((_provider, index) => source[(this.cursor + index) % source.length]);
  }
  async call(operation) {
    const failures = [];
    for (const provider of this.ordered()) {
      try {
        const result = await operation(provider.web3, provider.url);
        this.cursor = (this.providers.indexOf(provider) + 1) % this.providers.length;
        return result;
      } catch (error) {
        const message = String(error.message || error);
        if (!/429|rate limit|timeout|connection|network|capacity|free plan|unavailable|invalid json/i.test(message)) throw error;
        provider.cooldownUntil = Date.now() + (/free plan/i.test(message) ? 86_400_000 : /429|rate limit|capacity/i.test(message) ? 120_000 : 30_000);
        failures.push(`${new URL(provider.url).hostname}: ${message}`);
      }
    }
    throw new Error(`RPC pool exhausted. ${failures.join(" | ")}`);
  }
  async batch(methodFactory, blockNumber = "latest") {
    return this.call((web3) => new Promise((resolve, reject) => {
      const methods = methodFactory(web3);
      if (!methods.length) return resolve([]);
      const batch = new web3.BatchRequest();
      const results = new Array(methods.length);
      let remaining = methods.length;
      methods.forEach((method, index) => {
        const callback = (error, value) => {
          results[index] = error
            ? { status: "rejected", reason: error }
            : { status: "fulfilled", value };
          remaining -= 1;
          if (!remaining) resolve(results);
        };
        batch.add(method.call.request({}, blockNumber, callback));
      });
      try { batch.execute(); } catch (error) { reject(error); }
    }));
  }
}

class ExperimentRunner {
  constructor(config, core, planner) {
    this.config = config;
    this.core = core;
    this.planner = planner;
    this.pool = new RpcPool();
    this.writeSemaphore = new Semaphore(WRITE_CONCURRENCY);
    this.walletQueues = new Map();
    this.contractCaches = new WeakMap();
    this.accountCache = new Map();
    this.stopRequested = false;
    this.auctions = [];
    this.metrics = {
      snapshots: 0,
      reads: 0,
      batches: 0,
      attempted: 0,
      sent: 0,
      mined: 0,
      reverted: 0,
      failovers: 0,
      actorHeartbeatSamples: 0,
      botCyclesScheduled: 0,
      botCyclesCompleted: 0,
      humanReconsiderations: 0,
      roundDurationsMs: [],
    };
    fs.mkdirSync(RUN_DIR, { recursive: true });
    this.logPath = path.join(RUN_DIR, `${config.experimentId}.jsonl`);
    this.statePath = path.join(RUN_DIR, `${config.experimentId}.state.json`);
  }
  log(type, payload = {}) {
    const row = { timeIso: new Date().toISOString(), experimentId: this.config.experimentId, type, ...payload };
    fs.appendFileSync(this.logPath, `${JSON.stringify(row)}\n`, "utf8");
    console.log(`[experiment:${type}] ${payload.message || payload.actorId || payload.auctionId || ""}`.trim());
  }
  saveState(extra = {}) {
    fs.writeFileSync(this.statePath, `${JSON.stringify({
      experimentId: this.config.experimentId,
      phase: extra.phase,
      updatedAtIso: new Date().toISOString(),
      auctions: this.auctions,
      metrics: this.metrics,
      ...extra,
    }, null, 2)}\n`, "utf8");
  }
  savePublicManifest() {
    const publicDir = path.join(ROOT, "experiment-data", "public");
    fs.mkdirSync(publicDir, { recursive: true });
    const manifest = {
      schemaVersion: this.config.schemaVersion,
      experimentId: this.config.experimentId,
      seed: this.config.seed,
      createdAtIso: this.config.createdAtIso,
      chainId: this.config.chainId,
      factoryAddress: this.config.factoryAddress,
      actorRunMinutes: this.config.actorRunMinutes,
      auctionDurationMinutes: this.config.auctionDurationMinutes,
      participants: this.config.participants,
      auctionSpecs: this.config.auctionSpecs.map((spec) => {
        const auction = this.auctions.find((candidate) => candidate.auctionId === spec.id);
        return {
          ...spec,
          address: auction?.address || "",
          createTransactionHash: auction?.createTransactionHash || "",
        };
      }),
    };
    fs.writeFileSync(
      path.join(publicDir, `${this.config.experimentId}.manifest.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }
  wallet(role, predicate = () => true) {
    return this.config.wallets.filter((wallet) => wallet.role === role && predicate(wallet));
  }
  contract(web3, artifact, address) {
    if (!this.contractCaches.has(web3)) this.contractCaches.set(web3, new Map());
    const cache = this.contractCaches.get(web3);
    const key = `${artifact.contractName || "contract"}:${normalize(address)}`;
    if (!cache.has(key)) cache.set(key, new web3.eth.Contract(artifact.abi, address));
    return cache.get(key);
  }
  factory(web3) {
    return this.contract(web3, factoryArtifact, this.config.factoryAddress);
  }
  campaign(web3, address) {
    return this.contract(web3, campaignArtifact, address);
  }
  account(web3, wallet) {
    const key = normalize(wallet.address);
    if (!this.accountCache.has(key)) {
      this.accountCache.set(key, web3.eth.accounts.privateKeyToAccount(wallet.privateKey));
    }
    return this.accountCache.get(key);
  }
  enqueueWallet(address, operation) {
    const key = normalize(address);
    const previous = this.walletQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (this.stopRequested) throw Object.assign(new Error("Stopped before queued transaction"), { cancelled: true });
      return this.writeSemaphore.use(operation);
    });
    const settled = next.finally(() => {
      if (this.walletQueues.get(key) === settled) this.walletQueues.delete(key);
    });
    this.walletQueues.set(key, settled);
    return settled;
  }
  async sendMethod(wallet, methodFactory, { to, value = "0", label }) {
    return this.enqueueWallet(wallet.address, async () => {
      const signed = await this.pool.call(async (web3) => {
        const account = this.account(web3, wallet);
        const method = methodFactory(web3);
        const [nonce, gasPrice, gasEstimate] = await Promise.all([
          web3.eth.getTransactionCount(account.address, "pending"),
          web3.eth.getGasPrice(),
          method.estimateGas({ from: account.address, value }),
        ]);
        return account.signTransaction({
          from: account.address,
          to,
          value,
          data: method.encodeABI(),
          gas: Math.ceil(Number(gasEstimate) * 1.2),
          gasPrice,
          nonce,
          chainId: this.core.EXPERIMENT_CHAIN_ID,
        });
      });
      this.metrics.attempted += 1;
      let receipt;
      try {
        receipt = await this.pool.call((web3) => web3.eth.sendSignedTransaction(signed.rawTransaction));
      } catch (error) {
        if (!/already known|nonce too low|known transaction|replacement transaction/i.test(String(error.message || error))) {
          throw error;
        }
        const deadline = Date.now() + 120_000;
        while (!receipt && Date.now() < deadline) {
          receipt = await this.pool.call((web3) => web3.eth.getTransactionReceipt(signed.transactionHash));
          if (!receipt) await wait(2000);
        }
        if (!receipt) throw new Error(`Transaction ${signed.transactionHash} was accepted but its receipt timed out.`);
      }
      this.metrics.sent += 1;
      this.metrics.mined += receipt.status ? 1 : 0;
      this.metrics.reverted += receipt.status ? 0 : 1;
      this.log("transaction", { label, wallet: wallet.address, transactionHash: receipt.transactionHash, status: Boolean(receipt.status) });
      return receipt;
    });
  }
  async validateConfig() {
    const errors = this.core.validateRoleIsolation(this.config.participants || this.config.wallets);
    if (errors.length) throw new Error(errors.join("; "));
    if (this.wallet("seller").length !== 10 || this.wallet("synthetic-human").length !== 20 || this.wallet("standard-bot").length !== 10) {
      throw new Error("Private config must contain 10 sellers, 20 humans, and 10 bots.");
    }
    await this.pool.call(async (web3) => {
      const chainId = Number(await web3.eth.getChainId());
      if (chainId !== this.core.EXPERIMENT_CHAIN_ID) throw new Error(`Wrong chain ${chainId}`);
      const factory = this.factory(web3);
      const actors = this.wallet("synthetic-human").concat(this.wallet("standard-bot"));
      const budgets = await Promise.all(actors.map((wallet) => factory.methods.getBudget(wallet.address).call()));
      if (budgets.some((budget) => String(budget) !== String(this.core.REQUIRED_BUDGET_WEI))) {
        throw new Error("At least one actor budget is no longer exactly 2000. Re-run preparation.");
      }
    });
  }
  async createAuctions() {
    this.saveState({ phase: "creating-auctions" });
    const before = await this.pool.call((web3) => this.factory(web3).methods.getDeployedCampaigns().call());
    const specs = this.config.auctionSpecs;
    const createHashes = new Map();
    await Promise.all(specs.map(async (spec) => {
      const seller = this.wallet("seller", (wallet) => wallet.auctionId === spec.id)[0];
      const receipt = await this.sendMethod(
        seller,
        (web3) => this.factory(web3).methods.createCampaign(
          String(spec.minimumBidWei),
          `Dummy payload for ${this.config.experimentId} ${spec.id}`,
          spec.description,
          String(spec.durationMinutes),
        ),
        { to: this.config.factoryAddress, label: `create:${spec.id}` },
      );
      this.log("auction-create-confirmed", { auctionId: spec.id, seller: seller.address, transactionHash: receipt.transactionHash });
      createHashes.set(spec.id, receipt.transactionHash);
    }));
    const after = await this.pool.call((web3) => this.factory(web3).methods.getDeployedCampaigns().call());
    const prior = new Set(before.map(normalize));
    const created = after.filter((address) => !prior.has(normalize(address)));
    if (created.length !== 10) throw new Error(`Expected 10 new auction addresses; found ${created.length}.`);
    const summaries = await Promise.all(created.map((address) => this.readSummary(address)));
    this.auctions = summaries.map((auction) => {
      const spec = specs.find((candidate) => candidate.description === auction.dataDescription);
      if (!spec) throw new Error(`Unexpected new auction ${auction.address} (${auction.dataDescription}).`);
      return {
        ...auction,
        auctionId: spec.id,
        description: spec.description,
        createTransactionHash: createHashes.get(spec.id) || "",
      };
    }).sort((a, b) => a.auctionId.localeCompare(b.auctionId));
    await this.assertStartBoundary();
    this.savePublicManifest();
    this.saveState({ phase: "auctions-ready" });
  }
  async readSummary(address, blockNumber = "latest") {
    this.metrics.reads += 1;
    return this.pool.call(async (web3) => {
      const result = await this.campaign(web3, address).methods.getListSummary().call({}, blockNumber);
      return {
        address,
        minimumContribution: String(result[0]),
        approversCount: Number(result[2]),
        manager: result[3],
        highestBid: String(result[4]),
        dataDescription: result[5],
        highestBidder: result[6],
        endTimeSec: Number(result[7]),
        closed: Boolean(result[8]),
      };
    });
  }
  async snapshot() {
    const blockNumber = await this.pool.call((web3) => web3.eth.getBlockNumber());
    const results = await this.pool.batch(
      (web3) => this.auctions.map((auction) =>
        this.campaign(web3, auction.address).methods.getListSummary(),
      ),
      blockNumber,
    );
    this.metrics.batches += 1;
    this.metrics.reads += this.auctions.length;
    const summaries = results.map((result, index) => {
      if (result.status !== "fulfilled") throw result.reason;
      const row = result.value;
      return {
        address: this.auctions[index].address,
        minimumContribution: String(row[0]),
        approversCount: Number(row[2]),
        manager: row[3],
        highestBid: String(row[4]),
        dataDescription: row[5],
        highestBidder: row[6],
        endTimeSec: Number(row[7]),
        closed: Boolean(row[8]),
      };
    });
    this.metrics.snapshots += 1;
    this.auctions = summaries.map((summary) => ({
      ...this.auctions.find((auction) => normalize(auction.address) === normalize(summary.address)),
      ...summary,
    }));
    this.log("active-list-state", {
      blockNumber,
      active: this.auctions.filter((auction) => !auction.closed && auction.endTimeSec > Math.floor(Date.now() / 1000)).map((auction) => auction.address),
      finalizable: this.auctions.filter((auction) => !auction.closed && auction.endTimeSec <= Math.floor(Date.now() / 1000)).map((auction) => auction.address),
    });
    return { blockNumber, auctions: this.auctions };
  }
  async assertStartBoundary() {
    const snapshot = await this.snapshot();
    const nowSec = Math.floor(Date.now() / 1000);
    const active = snapshot.auctions.filter((auction) => !auction.closed && auction.endTimeSec - nowSec >= this.core.MINIMUM_START_REMAINING_SECONDS);
    if (active.length !== 10) throw new Error(`Start boundary failed: only ${active.length} auctions have at least 20 minutes remaining.`);
  }
  async readActorState(actor, auction, blockNumber) {
    this.metrics.reads += 2;
    return this.pool.call(async (web3) => {
      const factory = this.factory(web3);
      const campaign = this.campaign(web3, auction.address);
      const [budget, myBid] = await Promise.all([
        factory.methods.getBudget(actor.address).call({}, blockNumber),
        campaign.methods.getBid(actor.address).call({}, blockNumber),
      ]);
      return { budget: asBigInt(budget), myBid: asBigInt(myBid) };
    });
  }
  async readRoundActorStates(work, blockNumber) {
    if (!work.length) return new Map();
    const calls = work.flatMap((item) => [
      { key: `${item.actor.actorId}:${item.auction.address}`, kind: "budget", item },
      { key: `${item.actor.actorId}:${item.auction.address}`, kind: "bid", item },
    ]);
    const results = await this.pool.batch(
      (web3) => calls.map((call) => call.kind === "budget"
        ? this.factory(web3).methods.getBudget(call.item.actor.address)
        : this.campaign(web3, call.item.auction.address).methods.getBid(call.item.actor.address)),
      blockNumber,
    );
    this.metrics.batches += 1;
    this.metrics.reads += calls.length;
    const states = new Map();
    calls.forEach((call, index) => {
      if (!states.has(call.key)) states.set(call.key, {});
      if (results[index].status === "fulfilled") {
        states.get(call.key)[call.kind] = asBigInt(results[index].value);
      }
    });
    return states;
  }
  async executeDecision(actor, auction, strategy, blockNumber, source, prefetchedState) {
    const state = prefetchedState?.budget !== undefined && prefetchedState?.bid !== undefined
      ? { budget: prefetchedState.budget, myBid: prefetchedState.bid }
      : await this.readActorState(actor, auction, blockNumber);
    const nowSec = Math.floor(Date.now() / 1000);
    const decision = this.planner.getBidDecision({
      ...auction,
      isActive: !auction.closed && auction.endTimeSec > nowSec,
      secondsLeft: Math.max(0, auction.endTimeSec - nowSec),
      isManager: normalize(auction.manager) === normalize(actor.address),
      isWinner: normalize(auction.highestBidder) === normalize(actor.address),
      myBid: state.myBid,
    }, state.budget, strategy);
    this.log("decision", {
      actorId: actor.actorId,
      cohort: actor.role,
      archetype: actor.archetype || "standard-bot",
      auctionId: auction.auctionId,
      source,
      decision: decision.bid ? "bid" : "skip",
      reason: decision.reason || "",
      budgetBeforeWei: state.budget.toString(),
      amountWei: decision.amountWei?.toString?.() || "",
    });
    if (!decision.bid || this.stopRequested) return false;
    try {
      const receipt = await this.sendMethod(
        actor,
        (web3) => this.campaign(web3, auction.address).methods.contribute(),
        { to: auction.address, value: decision.amountWei.toString(), label: `bid:${actor.actorId}:${auction.auctionId}` },
      );
      auction.highestBid = decision.targetBid.toString();
      auction.highestBidder = actor.address;
      auction.approversCount = Math.max(1, Number(auction.approversCount || 0));
      this.log("bid-mined", {
        actorId: actor.actorId,
        cohort: actor.role,
        archetype: actor.archetype || "standard-bot",
        walletAddress: actor.address,
        auctionId: auction.auctionId,
        auctionAddress: auction.address,
        transactionHash: receipt.transactionHash,
        etherscanUrl: `https://sepolia.etherscan.io/tx/${receipt.transactionHash}`,
        incrementalBidWei: decision.amountWei.toString(),
        cumulativeBidWei: decision.targetBid.toString(),
        budgetBeforeWei: state.budget.toString(),
        budgetAfterWei: (state.budget - decision.budgetCostWei).toString(),
      });
      return true;
    } catch (error) {
      if (!error.cancelled) this.log("bid-failed", { actorId: actor.actorId, auctionId: auction.auctionId, error: error.message });
      return false;
    }
  }
  async runActors() {
    const startAtMs = Date.now();
    const stopAtMs = startAtMs + this.core.ACTOR_RUN_MS;
    const humans = this.wallet("synthetic-human");
    const bots = this.wallet("standard-bot");
    const schedules = new Map(humans.map((actor) => [actor.actorId, this.core.buildHumanSchedule(actor, {
      seed: this.config.seed,
      startAtMs,
      stopAtMs,
    })]));
    const scheduleCursors = new Map(humans.map((actor) => [actor.actorId, 0]));
    const nextBotAt = new Map(bots.map((bot) => [bot.actorId, startAtMs]));
    let allocationCursor = 0;
    let nextHeartbeatAt = startAtMs;
    this.log("run-start", { startAtMs, stopAtMs, actors: 30 });
    this.saveState({ phase: "running", startAtMs, stopAtMs });

    while (!this.stopRequested && Date.now() < stopAtMs) {
      const roundStartedAt = Date.now();
      const now = Date.now();
      if (now >= nextHeartbeatAt) {
        this.log("cohort-heartbeat", { healthyActors: 30, totalActors: 30, queuedWallets: this.walletQueues.size });
        this.metrics.actorHeartbeatSamples += 1;
        nextHeartbeatAt = now + 15_000;
      }
      const { blockNumber, auctions } = await this.snapshot();
      const byId = new Map(auctions.map((auction) => [auction.auctionId, auction]));
      const humanWork = [];
      humans.forEach((actor) => {
        const schedule = schedules.get(actor.actorId);
        let cursor = scheduleCursors.get(actor.actorId);
        while (cursor < schedule.length && schedule[cursor].atMs <= now) {
          humanWork.push({ actor, step: schedule[cursor] });
          cursor += 1;
        }
        scheduleCursors.set(actor.actorId, cursor);
      });
      const dueBots = bots.filter((bot) => Number(nextBotAt.get(bot.actorId)) <= now);
      this.metrics.botCyclesScheduled += dueBots.length;
      this.metrics.humanReconsiderations += humanWork.length;
      dueBots.forEach((bot) => nextBotAt.set(bot.actorId, now + 60_000));
      const active = auctions.filter((auction) => !auction.closed && auction.endTimeSec > Math.floor(now / 1000));
      const allocation = this.planner.allocateCycleCandidates({
        bots: dueBots.map((bot) => ({
          id: bot.actorId,
          wallet: bot.address,
          strategy: { maxBidsPerCycle: 1, maxMinContributionWei: 2000, maxBidWei: 2000, outbidByWei: 10, minTimeRemainingSec: 20, skipIfWinning: true },
        })),
        auctions: active,
        cursor: allocationCursor,
      });
      allocationCursor = allocation.nextCursor;
      const work = [
        ...humanWork.map(({ actor, step }) => ({
          actor,
          auction: byId.get(step.auctionId),
          strategy: {
            maxMinContributionWei: step.willingnessWei,
            maxBidWei: step.willingnessWei,
            outbidByWei: 10,
            minTimeRemainingSec: 20,
            skipIfWinning: true,
          },
          source: `human-reconsideration-${step.reconsideration}`,
        })),
        ...dueBots.flatMap((actor) => {
          const assignment = allocation.assignments[actor.actorId]?.primary?.[0];
          return assignment ? [{
            actor,
            auction: byId.get(assignment.auctionId) || assignment,
            strategy: { maxMinContributionWei: 2000, maxBidWei: 2000, outbidByWei: 10, minTimeRemainingSec: 20, skipIfWinning: true },
            source: "coordinated-bot-cycle",
          }] : [];
        }),
      ].filter((item) => item.auction);
      const roundStates = await this.readRoundActorStates(work, blockNumber);
      await Promise.all(work.map((item) => this.executeDecision(
        item.actor,
        item.auction,
        item.strategy,
        blockNumber,
        item.source,
        roundStates.get(`${item.actor.actorId}:${item.auction.address}`),
      )));
      this.metrics.botCyclesCompleted += dueBots.length;
      const roundDurationMs = Date.now() - roundStartedAt;
      this.metrics.roundDurationsMs.push(roundDurationMs);
      this.log("coordinated-round", {
        durationMs: roundDurationMs,
        activeAuctions: active.length,
        dueBots: dueBots.length,
        humanReconsiderations: humanWork.length,
        candidatesEvaluated: allocation.candidatesEvaluated,
        assignedBotAuctions: allocation.reservedAuctionCount,
      });
      this.saveState({ phase: "running", startAtMs, stopAtMs });
      await wait(Math.min(POLL_MS, Math.max(0, stopAtMs - Date.now())));
    }
    this.stopRequested = true;
    this.log("run-stop", { stoppedAtMs: Date.now(), reason: Date.now() >= stopAtMs ? "20-minute boundary" : "operator stop" });
    await Promise.allSettled([...this.walletQueues.values()]);
    this.saveState({ phase: "actor-run-complete", startAtMs, stopAtMs });
  }
  async finalize() {
    this.stopRequested = false;
    const latestEndMs = Math.max(...this.auctions.map((auction) => auction.endTimeSec * 1000));
    if (Date.now() < latestEndMs) {
      this.log("finalization-wait", { untilIso: new Date(latestEndMs).toISOString() });
      await wait(latestEndMs - Date.now() + 1000);
    }
    const finalizations = await Promise.allSettled(this.auctions.map(async (auction) => {
      const seller = this.wallet("seller", (wallet) => normalize(wallet.address) === normalize(auction.manager))[0];
      const receipt = await this.sendMethod(
        seller,
        (web3) => this.campaign(web3, auction.address).methods.finalizeAuctionIfNeeded(),
        { to: auction.address, label: `finalize:${auction.auctionId}` },
      );
      this.log("auction-finalized", { auctionId: auction.auctionId, auctionAddress: auction.address, transactionHash: receipt.transactionHash });
      return receipt;
    }));
    const failed = finalizations.filter((result) => result.status === "rejected");
    const closingSnapshot = await this.snapshot();
    const unfinalized = closingSnapshot.auctions.filter((auction) => !auction.closed);
    const acceptance = {
      auctionCount: closingSnapshot.auctions.length,
      allAuctionsClosedAndFinalized: unfinalized.length === 0,
      unfinalizedAuctions: unfinalized.map((auction) => auction.address),
      distinctSellers: new Set(this.wallet("seller").map((wallet) => normalize(wallet.address))).size,
      distinctActors: new Set(
        this.wallet("synthetic-human").concat(this.wallet("standard-bot"))
          .map((wallet) => normalize(wallet.address)),
      ).size,
      roleIsolationErrors: this.core.validateRoleIsolation(this.config.participants || []),
      actorHeartbeatSamples: this.metrics.actorHeartbeatSamples,
      cycleDurationP50Ms: percentile(this.metrics.roundDurationsMs, 0.5),
      cycleDurationP95Ms: percentile(this.metrics.roundDurationsMs, 0.95),
      metrics: this.metrics,
    };
    const flagged = failed.length || !acceptance.allAuctionsClosedAndFinalized || acceptance.roleIsolationErrors.length;
    this.log("acceptance", acceptance);
    this.saveState({
      phase: flagged ? "completed-with-flags" : "completed",
      finalizationFailures: failed.map((result) => result.reason?.message || String(result.reason)),
      acceptance,
    });
  }
  requestStop() {
    this.stopRequested = true;
    this.log("operator-stop-requested");
  }
}

const main = async () => {
  const configPath = path.resolve(getArg("config") || "");
  if (!getArg("config") || !fs.existsSync(configPath)) throw new Error("Use --config <private-experiment-config>.");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (getArg("confirm") !== config.experimentId) {
    throw new Error(`Production launch blocked. Add --confirm ${config.experimentId}`);
  }
  const core = await import(path.join(ROOT, "src", "experiment", "experimentCore.mjs"));
  const planner = await import(path.join(ROOT, "src", "botnet", "cyclePlanner.mjs"));
  const runner = new ExperimentRunner(config, core, planner);
  process.once("SIGINT", () => runner.requestStop());
  process.once("SIGTERM", () => runner.requestStop());
  await runner.validateConfig();
  await runner.createAuctions();
  await runner.runActors();
  await runner.finalize();
};

main().catch((error) => {
  console.error(`Experiment failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
