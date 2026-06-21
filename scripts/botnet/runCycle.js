const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { loadBots, runSelectedBotsOnce } = require("./service");

async function main() {
  const bots = loadBots().filter((bot) => bot.enabled);
  console.log(`BC botnet one-shot cycle: ${bots.length} enabled bot(s)`);

  if (!bots.length) {
    console.log("No enabled bots configured. Set BOTNET_BOTS_JSON or use the API to add bots.");
    return;
  }

  const result = await runSelectedBotsOnce("enabled");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("BC botnet cycle failed:", error);
  process.exit(1);
});
