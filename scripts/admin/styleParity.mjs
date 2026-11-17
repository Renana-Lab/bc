// Compares computed styles of the marketplace admin cards with the blockchain Admin Zone cards at 1440x1000.
//
//   MARKET_URL=http://localhost:3001/manage-budget CHAIN_URL=http://localhost:3000/manage-budget \
//   [MARKET_STORAGE=market-state.json] [CHAIN_STORAGE=chain-state.json] node scripts/admin/styleParity.mjs
//
// Both pages must already be signed in as admin (pass a Playwright storageState file for each if needed).
// `playwright` is not a project dependency: run it with `npx -p playwright node scripts/admin/styleParity.mjs`
// or install it locally. Exit code 1 when any property differs. No screenshots are written.
import { chromium } from "playwright";

const MARKET_URL = process.env.MARKET_URL || "http://localhost:3001/manage-budget";
const CHAIN_URL = process.env.CHAIN_URL || "http://localhost:3000/manage-budget";

const PROBES = {
  card: { selector: ".adminGlossCard", props: ["borderTopWidth", "borderTopStyle", "borderTopColor", "borderTopLeftRadius", "paddingTop", "paddingLeft", "marginBottom", "boxShadow", "backgroundImage"] },
  title: { selector: ".adminGlossCard h6", props: ["color", "fontWeight", "fontSize", "fontFamily"] },
  collapseButton: { selector: ".adminCollapseButton", props: ["width", "height", "borderTopWidth", "borderTopColor", "borderTopLeftRadius", "color"] },
  tableHead: { selector: ".adminGlossCard .tableScrollWrap th", props: ["fontWeight", "color", "fontSize"] },
  primaryButton: { selector: ".adminGlossCard button.MuiButton-contained", props: ["backgroundColor", "borderTopLeftRadius"] },
  outlinedButton: { selector: ".adminGlossCard button.MuiButton-outlined", props: ["borderTopLeftRadius", "borderTopColor", "color"] },
};

const read = async (url, storageState) => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  // Open every card so tables and buttons exist.
  for (const button of await page.$$('button[aria-label^="Expand "]')) await button.click().catch(() => {});
  await page.waitForTimeout(500);
  const result = await page.evaluate((probes) => {
    const out = {};
    for (const [name, { selector, props }] of Object.entries(probes)) {
      const element = document.querySelector(selector);
      out[name] = element ? Object.fromEntries(props.map((prop) => [prop, getComputedStyle(element)[prop]])) : null;
    }
    return out;
  }, PROBES);
  await browser.close();
  return result;
};

const market = await read(MARKET_URL, process.env.MARKET_STORAGE);
const chain = await read(CHAIN_URL, process.env.CHAIN_STORAGE);
let differences = 0;
for (const name of Object.keys(PROBES)) {
  if (!market[name] || !chain[name]) {
    console.log(`SKIP ${name}: missing on ${!market[name] ? "market" : "blockchain"} page`);
    continue;
  }
  for (const prop of PROBES[name].props) {
    const ok = market[name][prop] === chain[name][prop];
    if (!ok) differences += 1;
    console.log(`${ok ? "ok  " : "DIFF"} ${name}.${prop}: market=${market[name][prop]} chain=${chain[name][prop]}`);
  }
}
console.log(differences ? `${differences} difference(s)` : "styles match");
process.exit(differences ? 1 : 0);
