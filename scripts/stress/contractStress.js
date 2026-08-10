const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const solc = require("solc");
const Web3 = require("web3");

const sourcePath = path.resolve(
  __dirname,
  "../../src/real_ethereum/contracts/Campaign.sol",
);

const compileContracts = () => {
  const input = {
    language: "Solidity",
    sources: {
      "Campaign.sol": { content: fs.readFileSync(sourcePath, "utf8") },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(
    (entry) => entry.severity === "error",
  );

  assert.deepStrictEqual(
    errors,
    [],
    `Solidity compilation failed:\n${errors
      .map((entry) => entry.formattedMessage)
      .join("\n")}`,
  );
  return output.contracts["Campaign.sol"];
};

const expectRevert = async (action, message) => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail(message || "Expected transaction to revert");
};

const main = async () => {
  const startedAt = Date.now();
  const contracts = compileContracts();
  const provider = ganache.provider({
    logging: { quiet: true },
    wallet: {
      deterministic: true,
      totalAccounts: 45,
      defaultBalance: 1000,
    },
    miner: { blockGasLimit: 30000000 },
    chain: { chainId: 1337 },
  });
  const web3 = new Web3(provider);
  const accounts = await web3.eth.getAccounts();
  const owner = accounts[0];
  const seller = accounts[1];
  const bidderA = accounts[2];
  const bidderB = accounts[3];
  let assertions = 0;
  const check = (condition, message) => {
    assert.ok(condition, message);
    assertions += 1;
  };

  const factoryArtifact = contracts.CampaignFactory;
  const campaignArtifact = contracts.Campaign;
  const factory = await new web3.eth.Contract(factoryArtifact.abi)
    .deploy({ data: `0x${factoryArtifact.evm.bytecode.object}` })
    .send({ from: owner, gas: 15000000 });

  const createAuction = async ({
    from = seller,
    minimum = "100",
    data = "private dataset",
    description = "stress auction",
    duration = "1",
  } = {}) => {
    await factory.methods
      .createCampaign(minimum, data, description, duration)
      .send({ from, gas: 12000000 });
    const deployed = await factory.methods.getDeployedCampaigns().call();
    return new web3.eth.Contract(
      campaignArtifact.abi,
      deployed[deployed.length - 1],
    );
  };

  console.log("[stress] validating global budget behavior and input guards");
  check((await factory.methods.getBudget(bidderA).call()) === "2000", "Default budget must be 2000");
  await factory.methods.resetAllBudgets(1999).send({ from: bidderA, gas: 5000000 });
  check(
    (await factory.methods.getBudget(bidderA).call()) === "1999",
    "Public global budget reset did not update the default",
  );
  await factory.methods.resetAllBudgets(2000).send({ from: owner, gas: 5000000 });
  await expectRevert(
    () => factory.methods.resetAllBudgets(0).send({ from: bidderA, gas: 5000000 }),
    "Zero global budget was accepted",
  );
  await expectRevert(
    () => createAuction({ minimum: "0" }),
    "Zero-minimum auction was accepted",
  );
  await expectRevert(
    () => createAuction({ duration: "0" }),
    "Zero-duration auction was accepted",
  );
  await expectRevert(
    () => createAuction({ duration: "31" }),
    "Duration above 30 minutes was accepted",
  );
  await expectRevert(
    () => createAuction({ data: "" }),
    "Empty data payload was accepted",
  );
  await expectRevert(
    () => createAuction({ description: "" }),
    "Empty description was accepted",
  );

  console.log("[stress] exercising complete competitive auction lifecycle");
  const auction = await createAuction();
  await expectRevert(
    () => auction.methods.contribute().send({ from: seller, value: "100", gas: 1500000 }),
    "Seller was able to bid on own auction",
  );
  await expectRevert(
    () => auction.methods.contribute().send({ from: bidderA, value: "0", gas: 1500000 }),
    "Zero-value bid was accepted",
  );
  await expectRevert(
    () => auction.methods.contribute().send({ from: bidderA, value: "99", gas: 1500000 }),
    "Below-minimum bid was accepted",
  );

  await auction.methods.contribute().send({ from: bidderA, value: "100", gas: 1500000 });
  let ledger = await auction.methods.getBidLedger().call();
  check(ledger.length === 1, "First bid was not recorded");
  check(ledger[0].budgetBefore === "2000", "First bid budgetBefore mismatch");
  check(ledger[0].budgetAfter === "1900", "First bid budgetAfter mismatch");

  await auction.methods.contribute().send({ from: bidderA, value: "50", gas: 1500000 });
  check((await factory.methods.getBudget(bidderA).call()) === "1850", "Incremental self-bid budget mismatch");
  await auction.methods.contribute().send({ from: bidderB, value: "200", gas: 1500000 });
  check((await factory.methods.getBudget(bidderA).call()) === "2000", "Outbid user budget was not restored");
  check((await factory.methods.getBudget(bidderB).call()) === "1800", "New leader budget mismatch");

  await auction.methods.contribute().send({ from: bidderA, value: "110", gas: 1500000 });
  check((await auction.methods.highestBid().call()) === "260", "Cumulative re-entry bid mismatch");
  check((await factory.methods.getBudget(bidderA).call()) === "1740", "Re-entry budget mismatch");
  check((await factory.methods.getBudget(bidderB).call()) === "2000", "Second outbid restoration mismatch");
  await expectRevert(
    () => auction.methods.getData().call({ from: bidderA }),
    "Winner accessed data before finalization",
  );

  await provider.request({ method: "evm_increaseTime", params: [61] });
  await provider.request({ method: "evm_mine", params: [] });
  await expectRevert(
    () => auction.methods.contribute().send({ from: bidderB, value: "300", gas: 1500000 }),
    "Bid succeeded after auction end",
  );
  await auction.methods.finalizeAuctionIfNeeded().send({ from: accounts[4], gas: 700000 });
  check(await auction.methods.getStatus().call(), "Auction did not close");
  check((await factory.methods.getBudget(seller).call()) === "2260", "Seller budget was not credited");
  check((await auction.methods.getData().call({ from: bidderA })) === "private dataset", "Winner data access failed");
  await expectRevert(
    () => auction.methods.getData().call({ from: bidderB }),
    "Losing bidder accessed private data",
  );
  await expectRevert(
    () => auction.methods.finalizeAuctionIfNeeded().send({ from: accounts[4], gas: 700000 }),
    "Auction finalized twice",
  );
  await auction.methods.withdrawRefund().send({ from: bidderB, gas: 1500000 });
  check((await auction.methods.getBid(bidderB).call()) === "0", "Loser refund balance was not cleared");
  await expectRevert(
    () => auction.methods.withdrawRefund().send({ from: bidderB, gas: 1500000 }),
    "Duplicate refund succeeded",
  );
  await expectRevert(
    () => auction.methods.withdrawRefund().send({ from: bidderA, gas: 1500000 }),
    "Winner received a refund",
  );

  console.log("[stress] creating 30 auctions and bidding with 30 bots concurrently");
  const parallelAuctions = [];
  for (let index = 0; index < 30; index += 1) {
    parallelAuctions.push(
      await createAuction({
        minimum: "1",
        description: `parallel-${index + 1}`,
      }),
    );
  }
  const parallelResults = await Promise.allSettled(
    parallelAuctions.map((parallelAuction, index) =>
      parallelAuction.methods
        .contribute()
        .send({ from: accounts[index + 5], value: "1", gas: 1500000 }),
    ),
  );
  const parallelFailures = parallelResults.filter(
    (result) => result.status === "rejected",
  );
  check(
    parallelFailures.length === 0,
    `${parallelFailures.length} of 30 parallel bot bids failed`,
  );
  const summaries = await Promise.all(
    parallelAuctions.map((parallelAuction) =>
      parallelAuction.methods.getListSummary().call(),
    ),
  );
  check(
    summaries.every((summary) => summary[2] === "1" && summary[4] === "1"),
    "Parallel auction summaries are inconsistent",
  );

  await provider.request({ method: "evm_increaseTime", params: [61] });
  await provider.request({ method: "evm_mine", params: [] });
  await factory.methods
    .checkEndedAuctionsRange(0, 10)
    .send({ from: accounts[44], gas: 12000000 });
  const firstTenClosed = await Promise.all(
    parallelAuctions.slice(0, 8).map((parallelAuction) =>
      parallelAuction.methods.getStatus().call(),
    ),
  );
  check(firstTenClosed.every(Boolean), "Bounded finalizer did not close its first batch");
  check(
    (await factory.methods.getDeployedCampaigns().call()).length === 31,
    "Factory deployment index lost auctions under load",
  );

  await provider.disconnect();
  console.log(
    `[stress] PASS: ${assertions} invariant groups, 31 auctions, 30 parallel bots in ${(
      (Date.now() - startedAt) /
      1000
    ).toFixed(1)}s`,
  );
};

main().catch((error) => {
  console.error("[stress] FAIL", error);
  process.exitCode = 1;
});
