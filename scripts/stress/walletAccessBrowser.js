/* Production-build regression checks. No wallet transactions are submitted. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { chromium, webkit } = require("playwright");

const root = process.env.WALLET_TEST_BUILD ? path.resolve(process.env.WALLET_TEST_BUILD) : path.resolve(__dirname, "../../build");
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const candidate = path.resolve(root, `.${new URL(req.url, "http://localhost").pathname}`);
  const file = candidate.startsWith(root + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(root, "index.html");
  res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(file).pipe(res);
});
const routes = ["/auctions-list", "/open-auction", "/auction/0x1234567890abcdef1234567890abcdef12345678", "/manage-budget"];
async function run(engine, name) {
  const browser = await engine.launch({ headless: true, ...(name === "chromium" && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    for (const mode of ["absent", "locked", "unsupported", "malformed"]) {
      const context = await browser.newContext();
      await context.addInitScript(({ mode }) => {
        if (mode !== "absent") window.ethereum = {
          isMetaMask: true,
          ...(mode === "unsupported" ? {} : { _metamask: { isUnlocked: async () => mode !== "locked" } }),
          request: async () => mode === "malformed" ? ["bad"] : ["0x1234567890abcdef1234567890abcdef12345678"],
          on() {}, removeListener() {},
        };
        window.protectedContentAppeared = false;
        new MutationObserver(() => {
          if (document.querySelector('input[placeholder*="Search auctions"]') ||
              [...document.querySelectorAll("h1,h2")].some((node) => /^(Create Auction|Admin Zone)$/.test(node.textContent.trim()))) window.protectedContentAppeared = true;
        }).observe(document, { subtree: true, childList: true });
      }, { mode });
      await context.route("**/*", (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
      const page = await context.newPage();
      for (const target of routes) {
        await page.goto(base + target);
        await page.getByRole("heading", { name: "Are you logged in to MetaMask?" }).waitFor();
        assert.equal(await page.evaluate(() => window.protectedContentAppeared), false, `${name} ${mode} ${target}: protected content flashed`);
        await page.reload();
        await page.getByRole("heading", { name: "Are you logged in to MetaMask?" }).waitFor();
        assert.equal(await page.evaluate(() => window.protectedContentAppeared), false);
      }
      await context.close();
    }
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const handlers = new Map();
      let unlocked = true;
      window.ethereum = {
        isMetaMask: true,
        _metamask: { isUnlocked: async () => unlocked },
        request: async ({ method }) => {
          if (method === "eth_chainId") return "0xaa36a7";
          if (method === "eth_accounts") return ["0x1234567890abcdef1234567890abcdef12345678"];
          if (method === "eth_call") return `0x${(2000).toString(16).padStart(64, "0")}`;
          return "0x1";
        },
        on(name, callback) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(callback); },
        removeListener(name, callback) { handlers.get(name)?.delete(callback); },
      };
      window.lockTestWallet = () => { unlocked = false; handlers.get("accountsChanged")?.forEach((callback) => callback([])); };
    });
    await context.route("**/*", (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(base + "/open-auction");
    await page.getByRole("heading", { name: "Create Auction", exact: true }).waitFor();
    await page.evaluate(() => window.lockTestWallet());
    await page.getByRole("heading", { name: "Are you logged in to MetaMask?" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Create Auction", exact: true }).count(), 0);
    await context.close();
    console.log(`${name}: 32 direct-link/reload denial checks plus verified entry and lock revocation passed`);
  } finally { await browser.close(); }
}
let base;
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const requested = process.argv[2] || "chromium";
    await run(requested === "webkit" ? webkit : chromium, requested);
  } finally { server.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
