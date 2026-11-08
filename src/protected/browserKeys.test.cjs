const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

test("browser worker stores nonextractable wallet keys and survives reload", { timeout: 90000 }, async () => {
  let playwright;
  try { playwright = require("playwright"); }
  catch { playwright = require(path.join(process.env.USERPROFILE || process.env.HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5197", "--strictPort"], {
    cwd: process.cwd(), windowsHide: true, stdio: "pipe",
    env: { ...process.env, REACT_APP_PROTECTED_MARKET: "true", REACT_APP_FACTORY_ADDRESS: "0x" + "2".repeat(40), REACT_APP_PROTECTED_API_URL: "https://protected.invalid" },
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Vite did not start")), 20000);
      server.stdout.on("data", chunk => { if (String(chunk).includes("5197")) { clearTimeout(timer); resolve(); } });
      server.once("exit", code => { clearTimeout(timer); reject(new Error(`Vite exited ${code}`)); });
    });
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("http://127.0.0.1:5197/", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><script type="module" src="/@vite/client"></script></body></html>' }));
    await page.goto("http://127.0.0.1:5197/", { waitUntil: "domcontentloaded" });
    const fingerprint = await page.evaluate(async () => {
      const client = await import("/src/protected/client.js");
      return client.getBidKeyFingerprint("0x" + "1".repeat(40), 11155111);
    });
    assert.match(fingerprint, /^0x[0-9a-f]{64}$/);
    const extractable = await page.evaluate(async () => new Promise((resolve, reject) => {
      const open = indexedDB.open("marketplace-protected-keys-v1", 1);
      open.onerror = reject;
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction("keys", "readonly").objectStore("keys").get("11155111:0x" + "1".repeat(40));
        read.onsuccess = () => { resolve(read.result.privateKey.extractable); db.close(); };
      };
    }));
    assert.equal(extractable, false);
    await page.reload({ waitUntil: "domcontentloaded" });
    const again = await page.evaluate(async () => (await import("/src/protected/client.js")).getBidKeyFingerprint("0x" + "1".repeat(40), 11155111));
    assert.equal(again, fingerprint);
    const other = await page.evaluate(async () => (await import("/src/protected/client.js")).getBidKeyFingerprint("0x" + "3".repeat(40), 11155111));
    assert.notEqual(other, fingerprint);
    await context.close();
  } finally {
    await browser?.close();
    server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
  }
});
