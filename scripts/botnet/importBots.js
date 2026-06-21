const fs = require("fs");
const path = require("path");

const { BOTS_PATH } = require("./service");

const DEFAULT_SOURCE = "C:\\Users\\Programmers\\Desktop\\bc_SUPERBOT\\files\\data\\bots.json";

const sourcePath = path.resolve(
  process.argv[2] || process.env.BOTNET_IMPORT_PATH || DEFAULT_SOURCE
);

const normalizePrivateKey = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("0x") ? raw : `0x${raw}`;
};

const isValidPrivateKey = (value) =>
  /^0x[a-fA-F0-9]{64}$/.test(normalizePrivateKey(value));

const normalizeBot = (bot, index) => {
  const privateKey = normalizePrivateKey(bot.privateKey);
  const validKey = isValidPrivateKey(privateKey);

  return {
    id: String(bot.id || `imported-bot-${index + 1}`).trim(),
    name: String(bot.name || `Imported Bot ${index + 1}`).trim(),
    privateKey,
    enabled: Boolean(bot.enabled) && validKey,
    overrides: {
      AUTO_TRADE_INTERVAL_SEC: "60",
      MAX_BID_WEI: "2000",
      OUTBID_BY_WEI: "10",
      MAX_MIN_CONTRIBUTION_WEI: "2000",
      MIN_TIME_REMAINING_SEC: "20",
      SKIP_IF_WINNING: "true",
      ENABLE_BIDDING: "true",
      ENABLE_FINALIZE: "true",
      ...(bot.overrides || {}),
    },
    createdAt: bot.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    importWarning: validKey ? "" : "Imported privateKey is not a valid 32-byte key; bot disabled.",
  };
};

function main() {
  const raw = fs.readFileSync(sourcePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Bot import file must contain a JSON array.");
  }

  const bots = parsed.map(normalizeBot);
  fs.mkdirSync(path.dirname(BOTS_PATH), { recursive: true });
  fs.writeFileSync(BOTS_PATH, `${JSON.stringify(bots, null, 2)}\n`, "utf8");

  const enabledCount = bots.filter((bot) => bot.enabled).length;
  const disabledCount = bots.length - enabledCount;
  const disabledNames = bots
    .filter((bot) => !bot.enabled)
    .map((bot) => bot.name)
    .join(", ");

  console.log(`Imported ${bots.length} bot(s) into ${BOTS_PATH}`);
  console.log(`Enabled: ${enabledCount}; disabled: ${disabledCount}`);
  if (disabledNames) {
    console.log(`Disabled bots needing review: ${disabledNames}`);
  }
}

main();
