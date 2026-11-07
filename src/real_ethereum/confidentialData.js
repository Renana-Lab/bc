import { getFactoryContract } from "./factory";
import campaign from "./campaign";
import { requireWalletAccess } from "./walletAccess";
import { ensureTargetChain, getTargetNetwork } from "./sapphireNetworks";
import { buildSiweMessage, splitSignature, utf8ToHex, SIWE_SESSION_MINUTES } from "./siwe.mjs";

// In-memory only: a bearer token must never be persisted.
const sessions = new Map();
const REFRESH_MARGIN_MS = 60 * 1000;

const sessionKey = (account) =>
  `${getFactoryContract().options.address}:${String(account).toLowerCase()}`;

export const clearConfidentialSessions = () => sessions.clear();

// One MetaMask signature per session (SIWE_SESSION_MINUTES); later reads reuse the token.
export const getConfidentialToken = async (account) => {
  const key = sessionKey(account);
  const cached = sessions.get(key);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;

  const session = await requireWalletAccess();
  if (session.account.toLowerCase() !== String(account).toLowerCase()) {
    throw new Error("The wallet account changed. Reconnect and retry.");
  }
  const network = await ensureTargetChain(session.provider, getTargetNetwork());
  const factory = getFactoryContract();
  const domain = await factory.methods.domain().call();
  // The factory only accepts SIWE messages for its configured domain; fail clearly
  // instead of showing MetaMask a message the contract will reject.
  if (typeof window !== "undefined" && domain !== window.location.host) {
    throw new Error(
      `This factory only accepts sign-in on "${domain}" but the app is open on "${window.location.host}". Open the app on that host or redeploy the factory with FACTORY_SIWE_DOMAIN=${window.location.host}.`
    );
  }
  const now = new Date();
  const message = buildSiweMessage({
    domain,
    address: session.account,
    uri: typeof window !== "undefined" ? window.location.origin : `https://${domain}`,
    chainId: network.chainId,
    now,
  });
  const signature = await session.provider.request({
    method: "personal_sign",
    params: [utf8ToHex(message), session.account],
  });
  const token = await factory.methods.login(message, splitSignature(signature)).call();
  sessions.set(key, {
    token,
    expiresAt: now.getTime() + SIWE_SESSION_MINUTES * 60 * 1000,
  });
  return token;
};

// Payloads never change after the auction closes, so successful reads are kept in memory.
const payloads = new Map();
const rejectedUntil = new Map();
const REJECT_COOLDOWN_MS = 60 * 1000;

// Winner-only read of the confidential payload (auction must be finalized).
export const readWinnerData = async (auctionAddress, account) => {
  const key = `${auctionAddress}:${String(account).toLowerCase()}`.toLowerCase();
  if (payloads.has(key)) return payloads.get(key);
  // Do not re-prompt MetaMask on every refresh after the user declined to sign.
  if ((rejectedUntil.get(key) || 0) > Date.now()) return "";

  try {
    const token = await getConfidentialToken(account);
    const data = await campaign(auctionAddress).methods.getDataWithToken(token).call();
    payloads.set(key, data);
    return data;
  } catch (error) {
    if (error?.code === 4001) rejectedUntil.set(key, Date.now() + REJECT_COOLDOWN_MS);
    throw error;
  }
};
