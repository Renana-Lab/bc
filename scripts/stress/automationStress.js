const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const ganache = require("ganache");
const Web3 = require("web3");

const factoryArtifact = require("../../src/real_ethereum/build/CampaignFactory.json");
const campaignArtifact = require("../../src/real_ethereum/build/Campaign.json");

const rootDir = path.resolve(__dirname, "../..");
const finalizerPath = path.resolve(rootDir, "scripts/autoFinalizeAuctions.js");

const runFinalizer = (environment) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [finalizerPath, "--once"], {
      cwd: rootDir,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Auto-finalizer exited with ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });

const main = async () => {
  const startedAt = Date.now();
  const server = ganache.server({
    logging: { quiet: true },
    wallet: { deterministic: true, totalAccounts: 8, defaultBalance: 1000 },
    miner: { blockGasLimit: 30000000 },
    chain: { chainId: 1338, hardfork: "shanghai" },
  });

  await server.listen(0, "127.0.0.1");
  const address = server.address();
  const rpcUrl = `http://127.0.0.1:${address.port}`;
  const web3 = new Web3(rpcUrl);

  try {
    const accounts = await web3.eth.getAccounts();
    const initialAccounts = server.provider.getInitialAccounts();
    const finalizerKey = initialAccounts[accounts[0].toLowerCase()].secretKey;
    const owner = accounts[0];
    const seller = accounts[1];
    const bidderA = accounts[2];
    const bidderB = accounts[3];

    const factory = await new web3.eth.Contract(factoryArtifact.abi)
      .deploy({ data: factoryArtifact.evm.bytecode.object })
      .send({ from: owner, gas: 15000000 });

    const createAuction = async (description) => {
      await factory.methods
        .createCampaign("10", `${description} payload`, description, "1")
        .send({ from: seller, gas: 12000000 });
      const addresses = await factory.methods.getDeployedCampaigns().call();
      return new web3.eth.Contract(
        campaignArtifact.abi,
        addresses[addresses.length - 1],
      );
    };

    console.log("[automation] creating ended, refund, and still-open scenarios");
    const zeroBidAuction = await createAuction("zero bid");
    const competitiveAuction = await createAuction("competitive");
    await competitiveAuction.methods
      .contribute()
      .send({ from: bidderA, value: "100", gas: 1500000 });
    await competitiveAuction.methods
      .contribute()
      .send({ from: bidderB, value: "200", gas: 1500000 });

    await server.provider.request({ method: "evm_increaseTime", params: [61] });
    await server.provider.request({ method: "evm_mine", params: [] });
    const openAuction = await createAuction("still open");

    const env = {
      RPC_URLS: rpcUrl,
      RPC_URL: rpcUrl,
      FACTORY_ADDRESS: factory.options.address,
      FACTORY_ADDRESSES: factory.options.address,
      PRIVATE_KEY: finalizerKey,
      AUTO_REFUND_BATCH_SIZE: "50",
    };

    const firstRun = await runFinalizer(env);
    assert.match(firstRun.stdout, /Finalized .*:/, "No auctions were finalized");
    assert.strictEqual(
      await zeroBidAuction.methods.getStatus().call(),
      true,
      "Zero-bid auction remained open",
    );
    assert.strictEqual(
      await competitiveAuction.methods.getStatus().call(),
      true,
      "Competitive auction remained open",
    );
    assert.strictEqual(
      await openAuction.methods.getStatus().call(),
      false,
      "Still-active auction was finalized early",
    );
    assert.strictEqual(
      await competitiveAuction.methods.getBid(bidderA).call(),
      "0",
      "Losing bidder refund was not processed",
    );
    assert.strictEqual(
      await factory.methods.getBudget(seller).call(),
      "2200",
      "Seller budget was not credited exactly once",
    );

    console.log("[automation] repeating the cycle to verify idempotency");
    const secondRun = await runFinalizer(env);
    assert.strictEqual(
      await factory.methods.getBudget(seller).call(),
      "2200",
      "Repeated finalizer run credited the seller twice",
    );
    assert.strictEqual(
      await openAuction.methods.getStatus().call(),
      false,
      "Repeated run finalized an active auction",
    );
    assert.doesNotMatch(
      secondRun.stdout,
      /Finalized .*:/,
      "Repeated run attempted to finalize an already closed auction",
    );

    console.log(
      `[automation] PASS: exact production finalizer lifecycle in ${(
        (Date.now() - startedAt) /
        1000
      ).toFixed(1)}s`,
    );
  } finally {
    await server.close();
  }
};

main().catch((error) => {
  console.error("[automation] FAIL", error);
  process.exitCode = 1;
});
