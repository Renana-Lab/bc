export const isRunningBrowserBot = (bot) => {
  const key = String(bot?.privateKey || "").trim().replace(/^0x/, "");
  return Boolean(
    bot?.running &&
    bot?.enabled &&
    bot?.walletType !== "metamask-agent" &&
    /^[a-fA-F0-9]{64}$/.test(key),
  );
};

export const hasRunningBrowserBots = (storage, storageKey) => {
  if (!storage) return false;
  try {
    const bots = JSON.parse(storage.getItem(storageKey) || "[]");
    return Array.isArray(bots) && bots.some(isRunningBrowserBot);
  } catch (_) {
    return false;
  }
};

