// The addresses of the server-side seller bots, cached in localStorage by the admin panel (SellerBotsCard) so that the
// buyer-bot runtime, which runs without the card, can skip their auctions. Public addresses only; never shown to participants.
export const SELLER_BOTS_KEY = "bc:seller-bots:v1";

const lower = (list) => [...new Set((Array.isArray(list) ? list : []).map((entry) => String(entry || "").trim().toLowerCase()).filter((entry) => /^0x[0-9a-f]{40}$/.test(entry)))];

export const writeSellerBotCache = ({ addresses, allowBuyerBotsOnSellerAuctions }, storage = typeof window !== "undefined" ? window.localStorage : null) => {
  try {
    storage?.setItem(SELLER_BOTS_KEY, JSON.stringify({ addresses: lower(addresses), allow: allowBuyerBotsOnSellerAuctions === true, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
};

export const readSellerBotCache = (storage = typeof window !== "undefined" ? window.localStorage : null) => {
  try {
    const parsed = JSON.parse(storage?.getItem(SELLER_BOTS_KEY) || "null");
    return { addresses: lower(parsed?.addresses), allowBuyerBotsOnSellerAuctions: parsed?.allow === true };
  } catch {
    return { addresses: [], allowBuyerBotsOnSellerAuctions: false };
  }
};

// Fields merged into a buyer bot's strategy.
export const readSellerBotStrategy = (storage) => {
  const { addresses, allowBuyerBotsOnSellerAuctions } = readSellerBotCache(storage);
  return { sellerBotAddresses: addresses, allowBuyerBotsOnSellerAuctions };
};
