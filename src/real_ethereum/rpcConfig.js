const LEGACY_INFURA_PROJECT_ID = "6426761d274542bb9652e9a5aff35a0c";

const DEFAULT_RPC_URLS = [
  `https://sepolia.infura.io/v3/${LEGACY_INFURA_PROJECT_ID}`,
  "https://rpc.sepolia.org",
];

export const getConfiguredRpcUrls = () =>
  (
    process.env.REACT_APP_RPC_URLS ||
    process.env.REACT_APP_RPC_URL ||
    DEFAULT_RPC_URLS.join(",")
  )
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url, index, urls) => urls.indexOf(url) === index);

export const getRpcErrorMessage = (error) =>
  String(
    error?.message ||
      error?.data?.message ||
      error?.error?.message ||
      error ||
      "",
  );

export const getRpcFailureKind = (error) => {
  const message = getRpcErrorMessage(error).toLowerCase();

  if (
    message.includes("chain is not available") ||
    message.includes("free plan") ||
    message.includes("upgrade to paid") ||
    message.includes("unsupported chain")
  ) {
    return "unsupported-plan";
  }

  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("usage limit") ||
    message.includes("current plan") ||
    message.includes("higher limits") ||
    message.includes("429")
  ) {
    return "capacity";
  }

  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("failed to fetch") ||
    message.includes("network error") ||
    message.includes("connection error") ||
    message.includes("connection not open") ||
    message.includes("couldn't connect") ||
    message.includes("could not connect") ||
    message.includes("connection refused") ||
    message.includes("econnrefused") ||
    message.includes("enotfound")
  ) {
    return "network";
  }

  return "other";
};
export const isRpcProviderFailure = (error) =>
  getRpcFailureKind(error) !== "other";

export const getFriendlyRpcError = (error) => {
  const kind = getRpcFailureKind(error);

  if (kind === "unsupported-plan") {
    return "An RPC endpoint does not support Sepolia on its current plan and has been disabled for this session.";
  }

  if (kind === "capacity") {
    return "RPC capacity was reached. That endpoint is cooling down while the system uses another connection.";
  }

  if (kind === "network") {
    return "An RPC endpoint is temporarily unreachable. The system will retry through another connection.";
  }

  return getRpcErrorMessage(error) || "Unknown blockchain connection error.";
};
