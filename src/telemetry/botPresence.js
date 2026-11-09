export const LOCAL_BOTS_KEY = "bc:admin-botnet:bots:v1";
export const LOCAL_LOGS_KEY = "bc:admin-botnet:logs:v1";
export const LOCAL_OBSERVATORY_KEY = "bc:admin-botnet:observatory:v1";
export const BOTNET_STATE_EVENT = "bc:admin-botnet:state-change";

export function getBotBidderNames() {
  const names = new Map();
  const addName = (wallet, name) => {
    if (typeof wallet === "string" && /^0x[\da-f]{40}$/i.test(wallet) &&
        typeof name === "string" && name.trim()) {
      names.set(wallet.toLowerCase(), name.trim());
    }
  };
  try {
    const bots = JSON.parse(window.localStorage.getItem(LOCAL_BOTS_KEY) || "[]");
    if (Array.isArray(bots)) bots.forEach(bot => addName(bot?.wallet, bot?.name));
  } catch (_) {
    // Wallet addresses remain available when browser storage cannot be read.
  }
  try {
    const aliases = JSON.parse(process.env.REACT_APP_BIDDER_NAMES || "{}");
    Object.entries(aliases || {}).forEach(([wallet, name]) => addName(wallet, name));
  } catch (_) {
    // An invalid public alias configuration should not interrupt bid history.
  }
  return names;
}

export const getRunningBotDescriptors = () => {
  if (typeof window === "undefined" || !window.localStorage) return [];

  try {
    const bots = JSON.parse(window.localStorage.getItem(LOCAL_BOTS_KEY) || "[]");
    if (!Array.isArray(bots)) return [];

    return bots
      .filter((bot) => bot?.running && bot?.enabled && bot?.wallet)
      .map((bot) => ({
        id: String(bot.id || bot.wallet),
        wallet: String(bot.wallet),
      }));
  } catch (_) {
    return [];
  }
};
