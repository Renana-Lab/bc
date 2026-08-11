/* global BigInt */
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const execFileAsync = promisify(execFile);
const DEFAULT_CHAIN_ID = 11155111;
const DEFAULT_TIMEOUT_MS = 120000;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

function defaultCommand() {
  return process.env.METAMASK_AGENT_WALLET_CLI || (process.platform === "win32" ? "mm.cmd" : "mm");
}

function findWindowsCommand(command, environment = process.env) {
  if (path.isAbsolute(command)) return command;

  const candidates = [
    environment.APPDATA && path.join(environment.APPDATA, "npm", command),
    environment.npm_config_prefix && path.join(environment.npm_config_prefix, command),
    ...String(environment.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, command)),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function resolveInvocation(
  command,
  args,
  { platform = process.platform, environment = process.env } = {},
) {
  if (platform !== "win32" || !/\.cmd$/i.test(command)) {
    return { executable: command, args };
  }

  const commandPath = findWindowsCommand(command, environment);
  if (!commandPath) {
    throw Object.assign(
      new Error("MetaMask Agent Wallet mm.cmd could not be located in the Windows npm or PATH directories."),
      { code: "ENOENT" },
    );
  }
  const entry = path.join(
    path.dirname(commandPath),
    "node_modules",
    "@metamask",
    "agent-wallet",
    "dist",
    "index.js",
  );
  if (!fs.existsSync(entry)) {
    throw Object.assign(new Error(`MetaMask Agent Wallet entry point was not found beside ${commandPath}.`), {
      code: "ENOENT",
    });
  }
  return { executable: process.execPath, args: [entry, ...args] };
}

function parseCliJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("MetaMask Agent Wallet returned an empty response.");

  try {
    return JSON.parse(text);
  } catch (_) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch (_) {}
    }
    throw new Error("MetaMask Agent Wallet returned invalid JSON.");
  }
}

function findMatchingString(value, matcher, preferredKeys = []) {
  if (typeof value === "string" && matcher.test(value)) return value;
  if (!value || typeof value !== "object") return "";

  for (const key of preferredKeys) {
    if (typeof value[key] === "string" && matcher.test(value[key])) return value[key];
  }
  for (const nested of Object.values(value)) {
    const match = findMatchingString(nested, matcher, preferredKeys);
    if (match) return match;
  }
  return "";
}

function toHexQuantity(value) {
  if (value === undefined || value === null || value === "") return "0x0";
  if (typeof value === "string" && /^0x[a-fA-F0-9]+$/.test(value)) {
    return `0x${BigInt(value).toString(16)}`;
  }
  return `0x${BigInt(value).toString(16)}`;
}

function cleanCliError(error) {
  const raw = String(error?.stderr || error?.message || error || "Unknown Agent Wallet error");
  const cleaned = raw
    .replace(/(cliToken|cliRefreshToken|MM_CLI_TOKEN)\s*[:=]\s*[^\s"']+/gi, "$1=[redacted]")
    .trim();

  if (error?.code === "ENOENT") {
    return "MetaMask Agent Wallet CLI was not found. Install @metamask/agent-wallet or set METAMASK_AGENT_WALLET_CLI.";
  }
  if (error?.killed || /timed?\s*out/i.test(cleaned)) {
    return "MetaMask Agent Wallet timed out while waiting for the wallet job or approval.";
  }
  return cleaned || "MetaMask Agent Wallet command failed.";
}

function createMetaMaskAgentWallet({
  command = defaultCommand(),
  chainId = Number(process.env.METAMASK_AGENT_CHAIN_ID || DEFAULT_CHAIN_ID),
  timeoutMs = Number(process.env.METAMASK_AGENT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  expectedAddress = process.env.METAMASK_AGENT_EXPECTED_ADDRESS || "",
  execute = execFileAsync,
} = {}) {
  async function run(args) {
    try {
      const invocation = resolveInvocation(command, args);
      const result = await execute(invocation.executable, invocation.args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: process.env,
      });
      const parsed = parseCliJson(result?.stdout ?? result);
      if (parsed?.ok === false) {
        throw new Error(parsed.error?.message || parsed.error || "MetaMask Agent Wallet command failed.");
      }
      return parsed;
    } catch (error) {
      throw new Error(cleanCliError(error));
    }
  }

  async function doctor() {
    const response = await run(["doctor", "--json"]);
    const data = response.data || response;
    return {
      authenticated: data.authenticated === true,
      initialized: data.initialized === true,
      compatible: data.compatible !== false,
      cliVersion: data.cli || null,
      hints: Array.isArray(data.hints) ? data.hints : [],
    };
  }

  async function assertReady() {
    const health = await doctor();
    if (!health.authenticated) {
      throw new Error("MetaMask Agent Wallet is not authenticated. Run `mm login` on the bot runner.");
    }
    if (!health.initialized) {
      throw new Error("MetaMask Agent Wallet is not initialized. Run `mm init --wallet server-wallet --mode guard` on the bot runner.");
    }
    if (!health.compatible) {
      throw new Error("MetaMask Agent Wallet CLI is not compatible with the active wallet session.");
    }
    return health;
  }

  async function getAddress() {
    const response = await run(["wallet", "address", "--chain-namespace", "evm", "--json"]);
    const address = findMatchingString(response, ADDRESS_PATTERN, ["address", "walletAddress"]);
    if (!address) throw new Error("MetaMask Agent Wallet did not return a valid EVM address.");
    if (expectedAddress) {
      if (!ADDRESS_PATTERN.test(expectedAddress)) {
        throw new Error("METAMASK_AGENT_EXPECTED_ADDRESS is not a valid EVM address.");
      }
      if (address.toLowerCase() !== expectedAddress.toLowerCase()) {
        throw new Error(
          `MetaMask Agent Wallet address mismatch. Expected ${expectedAddress}, received ${address}.`,
        );
      }
    }
    return address;
  }

  async function sendTransaction({ to, data = "0x", value = "0", gas, intent }) {
    if (!ADDRESS_PATTERN.test(String(to || ""))) {
      throw new Error("A valid contract address is required for an Agent Wallet transaction.");
    }
    if (!/^0x[a-fA-F0-9]*$/.test(String(data || ""))) {
      throw new Error("Agent Wallet transaction calldata must be 0x-prefixed hexadecimal data.");
    }

    const payload = {
      to,
      data: data || "0x",
      value: toHexQuantity(value),
    };
    if (gas !== undefined && gas !== null) payload.gas = toHexQuantity(gas);

    const args = [
      "wallet",
      "send-transaction",
      "--chain-id",
      String(chainId),
      "--payload",
      JSON.stringify(payload),
      "--wait",
      "--intent",
      String(intent || "Execute an auction contract transaction"),
      "--json",
    ];
    const response = await run(args);
    const transactionHash = findMatchingString(
      response,
      TX_HASH_PATTERN,
      ["transactionHash", "txHash", "hash"],
    );
    return { ...response, transactionHash: transactionHash || null, payload };
  }

  return {
    assertReady,
    doctor,
    getAddress,
    sendTransaction,
  };
}

module.exports = {
  DEFAULT_CHAIN_ID,
  cleanCliError,
  createMetaMaskAgentWallet,
  findWindowsCommand,
  findMatchingString,
  parseCliJson,
  resolveInvocation,
  toHexQuantity,
};
