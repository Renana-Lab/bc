export const LOCAL_BOTS_KEY = "bc:admin-botnet:bots:v1";
export const LOCAL_LOGS_KEY = "bc:admin-botnet:logs:v1";
export const LOCAL_OBSERVATORY_KEY = "bc:admin-botnet:observatory:v1";
export const BOTNET_STATE_EVENT = "bc:admin-botnet:state-change";

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
