// Mobile (390x900) layout check for the participant UI in local wallet mode. NOT part of the required CI jobs:
// it needs a browser and a running app.
//
//   REACT_APP_WALLET_MODE=local REACT_APP_NETWORK=sapphire-localnet npx vite --port 3000
//   PLAYWRIGHT_CORE_PATH=/path/to/playwright-core CHROME_PATH=/path/to/chrome \
//     [AUCTION_ADDRESS=0x... (an auction on the connected chain)] [APP=http://localhost:3000] \
//     node scripts/e2e/participantResponsive.mjs
//
// Checks per page: the document is never wider than the viewport. Create page: the submit button is fully
// inside the viewport. Auction page (when AUCTION_ADDRESS is set): the bid submit button lies inside the bid card.
// The chain is whatever the app is pointed at (a localnet, or an RPC you mock with page.route); the page
// loads are read-only, nothing is submitted.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const APP = process.env.APP || "http://localhost:3000";
const VIEWPORT = { width: 390, height: 900 };
const AUCTION = process.env.AUCTION_ADDRESS;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message.slice(0, 160)));

const failures = [];
const check = async (name, route, ready, extra) => {
  try {
    await page.goto(`${APP}${route}`);
    await page.waitForSelector(ready, { timeout: 60000 });
    await page.waitForTimeout(1500); // let lazy content settle
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(metrics.scrollWidth <= VIEWPORT.width, `${name}: documentElement scrollWidth ${metrics.scrollWidth} > ${VIEWPORT.width}`);
    assert.ok(metrics.bodyScrollWidth <= VIEWPORT.width, `${name}: body scrollWidth ${metrics.bodyScrollWidth} > ${VIEWPORT.width}`);
    await extra?.();
    console.log("PASS", name);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log("FAIL", name, "-", error.message.slice(0, 300));
  }
};

await check("home", "/", "text=Welcome to our data marketplace");
await check("auctions list", "/auctions-list", "text=Showing");
await check("create", "/open-auction", "button[type=submit]", async () => {
  const box = await page.locator("button[type=submit]").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= VIEWPORT.width, `create submit button outside the viewport (${box.x}..${box.x + box.width})`);
});
if (AUCTION) {
  await check("auction", `/auction/${AUCTION}`, "h1", async () => {
    const submit = page.locator("button[type=submit]");
    if (await submit.count()) {
      const [button, card] = await Promise.all([submit.boundingBox(), page.locator("form").first().locator("xpath=ancestor::div[1]").boundingBox()]);
      assert.ok(button.x >= card.x && button.x + button.width <= card.x + card.width + 1, "bid submit button is outside the bid card");
    }
  });
} else {
  console.log("SKIP auction page (set AUCTION_ADDRESS)");
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
