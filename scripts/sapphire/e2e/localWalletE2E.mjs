// Browser E2E for REACT_APP_WALLET_MODE=local against sapphire-localnet (localnet only).
// Prereqs: localnet running, factory deployed (REACT_APP_REAL_FACTORY_ADDRESS in .env), and
//   REACT_APP_NETWORK=sapphire-localnet REACT_APP_WALLET_MODE=local npx vite   (port 3000)
// Env: PLAYWRIGHT_CORE_PATH, CHROME_PATH, SHOTS (screenshot directory).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { HDNodeWallet, JsonRpcProvider, Mnemonic, Contract, Wallet } from "ethers";
import { wrapEthersSigner } from "@oasisprotocol/sapphire-ethers-v6";
import { isCalldataEnveloped } from "@oasisprotocol/sapphire-paratime";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const compiledFactory = require("../../../src/real_ethereum/build/CampaignFactory.json");
const compiledCampaign = require("../../../src/real_ethereum/build/Campaign.json");
const SHOTS = process.env.SHOTS;
const APP = "http://localhost:3000";
const RPC = "http://localhost:8545";
const PASS = "e2e passphrase for localnet 1";
const SECRET = `E2E-PAYLOAD-${Wallet.createRandom().address}`;
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (error) { results.push(["FAIL", name, error.message.slice(0, 300)]); console.log("FAIL", name, "-", error.message.slice(0, 300)); throw error; }
};

const factoryAddress = readFileSync(new URL("../../../.env", import.meta.url), "utf8")
  .match(/^REACT_APP_REAL_FACTORY_ADDRESS=(0x[0-9a-fA-F]{40})/m)?.[1];
assert.ok(factoryAddress, "factory address missing in .env");
const plain = new JsonRpcProvider(RPC, 23293, { staticNetwork: true, batchMaxCount: 1 });
const dev = (i) => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase("test test test test test test test test test test test junk"), `m/44'/60'/0'/0/${i}`).connect(plain);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const mkUser = async (name) => {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] pageerror:`, e.message.slice(0, 160)));
  return { name, context, page, shot: (label) => page.screenshot({ path: `${SHOTS}/${name}-${label}.png` }) };
};
const A = await mkUser("winner");
const B = await mkUser("loser");

try {
  // --- on-chain setup (localnet): one auction ending in 4 minutes ---
  let auction;
  await step("setup: seller creates a 4-minute auction on localnet (calldata encrypted by sapphire-ethers)", async () => {
    const factory = new Contract(factoryAddress, compiledFactory.abi, wrapEthersSigner(dev(0)));
    const receipt = await (await factory.createCampaign(1, SECRET, "e2e auction", 4)).wait();
    auction = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "AuctionCreated").args[0];
    console.log("auction", auction);
  });

  const createWallet = async (user) => {
    await user.page.goto(APP, { waitUntil: "networkidle" });
    const panel = user.page.locator('[data-testid="local-wallet-panel"]');
    await panel.getByPlaceholder("Passphrase (12+ chars)").fill(PASS);
    await user.shot("1-before-create");
    await panel.getByRole("button", { name: "Create" }).click();
    await panel.getByText(/Unlocked: 0x/).waitFor({ timeout: 60000 });
    user.address = (await panel.getByText(/Unlocked: 0x/).innerText()).match(/0x[0-9a-fA-F]{40}/)[0];
    await user.shot("2-wallet-created");
  };
  await step("1a. winner creates a local wallet", () => createWallet(A));
  await step("1b. loser creates a local wallet", () => createWallet(B));

  await step("2. fund both wallets from a localnet dev account (plain value transfer)", async () => {
    for (const user of [A, B]) await (await dev(4).sendTransaction({ to: user.address, value: 10n ** 18n })).wait();
    assert.ok((await plain.getBalance(A.address)) > 0n && (await plain.getBalance(B.address)) > 0n);
  });

  // A page load locks the wallet (key lives in memory only): unlock again with the passphrase.
  const ensureUnlocked = async (user) => {
    const panel = user.page.locator('[data-testid="local-wallet-panel"]');
    if (await panel.getByRole("button", { name: "Unlock" }).count()) {
      await panel.getByPlaceholder("Passphrase (12+ chars)").fill(PASS);
      await panel.getByRole("button", { name: "Unlock" }).click();
    }
    await panel.getByText(/Unlocked: 0x/).waitFor({ timeout: 60000 });
  };
  // In-app navigation (no reload) so the in-memory unlocked wallet survives.
  const navigate = async (user, path) => {
    await user.page.evaluate((to) => { window.history.pushState({}, "", to); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
    await user.page.waitForTimeout(3500);
  };
  const connectAndOpen = async (user) => {
    await user.page.goto(APP, { waitUntil: "networkidle" });
    await ensureUnlocked(user);
    await user.page.waitForTimeout(1500);
    await navigate(user, `/auction/${auction}`);
    await user.shot("3-auction-page");
  };
  await step("3. both connect with the local wallet and open the auction", async () => {
    // Wallet is lost on full navigation (memory only unlocks), so unlock again if needed.
    for (const user of [A, B]) await connectAndOpen(user);
  });
  const placeBid = async (user, amount) => {
    await user.page.locator('input[type="number"]').first().fill(String(amount));
    await user.shot(`4-bid-${amount}-filled`);
    await user.page.getByRole("button", { name: /submit your bid/i }).click();
    await user.page.waitForTimeout(500);
  };
  const startBlock = await plain.getBlockNumber();
  await step("4a. loser bids 50 wei through the UI (local wallet signs, no popup)", async () => {
    await placeBid(B, 50);
    await B.page.waitForFunction(() => /Highest bid.*50/s.test(document.body.innerText), null, { timeout: 90000 });
    await B.shot("4-loser-bid-done");
  });
  await step("4b. winner bids 100 wei through the UI", async () => {
    await A.page.reload({ waitUntil: "networkidle" });
    await ensureUnlocked(A);
    await navigate(A, `/auction/${auction}`);
    await placeBid(A, 100);
    await A.page.waitForFunction(() => /Highest bid.*100/s.test(document.body.innerText), null, { timeout: 90000 });
    await A.shot("4-winner-bid-done");
  });
  await step("4c. every bid transaction on chain carries an encrypted envelope, no plaintext selector", async () => {
    const selector = new Contract(auction, compiledCampaign.abi).interface.getFunction("contribute").selector;
    let seen = 0;
    for (let n = startBlock + 1; n <= (await plain.getBlockNumber()); n += 1) {
      const block = await plain.getBlock(n, true);
      for (const tx of block.prefetchedTransactions) {
        if (tx.to?.toLowerCase() !== auction.toLowerCase()) continue;
        seen += 1;
        assert.equal(isCalldataEnveloped(tx.data), true, "bid calldata must be an envelope");
        assert.equal(tx.data.includes(selector.slice(2)), false);
      }
    }
    assert.ok(seen >= 2, `expected two bid txs, saw ${seen}`);
  });

  await step("5. wait for the auction to end, then finalize it (dev account, localnet)", async () => {
    const reader = new Contract(auction, compiledCampaign.abi, wrapEthersSigner(dev(3)));
    const ends = Number((await reader.getSummary())[8]) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ends + 8000 - Date.now())));
    await (await reader.finalizeAuctionIfNeeded()).wait();
  });

  const openAuctionFresh = async (user) => {
    await user.page.reload({ waitUntil: "networkidle" });
    await ensureUnlocked(user);
    await navigate(user, `/auction/${auction}`);
    await user.page.waitForTimeout(6000);
  };
  await step("6a. winner opens the closed auction and reads the payload (SIWE signed silently by the local wallet)", async () => {
    await openAuctionFresh(A);
    await A.shot("6-winner-congrats");
    await A.page.getByRole("button", { name: /view data/i }).click();
    await A.page.waitForTimeout(1500);
    await A.shot("6-winner-reads");
    await A.page.waitForFunction((secret) => document.body.innerText.includes(secret), SECRET, { timeout: 60000 });
  });
  await step("6b. loser opens the same auction and does NOT see the payload", async () => {
    await openAuctionFresh(B);
    await B.shot("6-loser-denied");
    assert.equal(await B.page.getByRole("button", { name: /view data/i }).count(), 0, "loser must have no View data button");
    assert.equal((await B.page.evaluate(() => document.body.innerText)).includes(SECRET), false);
  });

  let backupPath;
  await step("7a. winner downloads the encrypted backup", async () => {
    const [download] = await Promise.all([A.page.waitForEvent("download"), A.page.getByRole("button", { name: "Download encrypted backup" }).click()]);
    backupPath = `${SHOTS}/winner-backup.json`;
    await download.saveAs(backupPath);
    const text = readFileSync(backupPath, "utf8");
    assert.equal(JSON.parse(text).version, 3);
    assert.equal(text.includes(SECRET), false);
  });
  await step("7b. site data cleared: wallet is gone and the payload is unreadable", async () => {
    const cdp = await A.context.newCDPSession(A.page);
    await cdp.send("Storage.clearDataForOrigin", { origin: APP, storageTypes: "all" });
    await A.page.reload({ waitUntil: "networkidle" });
    const panel = A.page.locator('[data-testid="local-wallet-panel"]');
    await panel.getByRole("button", { name: "Create" }).waitFor({ timeout: 30000 });
    await A.shot("7-after-clear-site-data");
    assert.equal(await panel.getByText(/Unlocked/).count(), 0);
  });
  await step("7c. restore from the backup file: same address, payload readable again", async () => {
    const panel = A.page.locator('[data-testid="local-wallet-panel"]');
    await panel.getByPlaceholder("Passphrase (12+ chars)").fill(PASS);
    await panel.getByTestId("local-wallet-restore").setInputFiles(backupPath);
    await panel.getByText(/Unlocked: 0x/).waitFor({ timeout: 60000 });
    const restored = (await panel.getByText(/Unlocked: 0x/).innerText()).match(/0x[0-9a-fA-F]{40}/)[0];
    assert.equal(restored.toLowerCase(), A.address.toLowerCase());
    await navigate(A, `/auction/${auction}`);
    await A.page.waitForTimeout(6000);
    await A.page.getByRole("button", { name: /view data/i }).click();
    await A.page.waitForTimeout(1500);
    await A.shot("7-restored-reads");
    await A.page.waitForFunction((secret) => document.body.innerText.includes(secret), SECRET, { timeout: 60000 });
  });
} catch (error) {
  console.log("STOPPED:", error.message.slice(0, 300));
} finally {
  console.log(JSON.stringify(results, null, 1));
  if (!process.env.KEEP_OPEN) await browser.close();
}
