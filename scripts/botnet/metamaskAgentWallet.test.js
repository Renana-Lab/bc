const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanCliError,
  createMetaMaskAgentWallet,
  findWindowsCommand,
  parseCliJson,
  resolveInvocation,
  toHexQuantity,
} = require("./metamaskAgentWallet");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ADDRESS = `0x${"a".repeat(40)}`;
const TX_HASH = `0x${"b".repeat(64)}`;

function fakeExecutor(responses, calls = []) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { stdout: JSON.stringify(next), stderr: "" };
  };
}

test("parses clean and noisy CLI JSON", () => {
  assert.deepEqual(parseCliJson('{"ok":true}'), { ok: true });
  assert.deepEqual(parseCliJson('notice\n{"ok":true,"data":{"cli":"6.0.0"}}\n'), {
    ok: true,
    data: { cli: "6.0.0" },
  });
});

test("normalizes transaction quantities", () => {
  assert.equal(toHexQuantity(0), "0x0");
  assert.equal(toHexQuantity("2000"), "0x7d0");
  assert.equal(toHexQuantity("0x000a"), "0xa");
});

test("rejects an unauthenticated runner before wallet use", async () => {
  const wallet = createMetaMaskAgentWallet({
    command: "mm",
    execute: fakeExecutor([{ ok: true, data: { authenticated: false, initialized: false } }]),
  });
  await assert.rejects(wallet.assertReady(), /not authenticated/i);
});

test("accepts a healthy runner and extracts nested addresses", async () => {
  const wallet = createMetaMaskAgentWallet({
    command: "mm",
    execute: fakeExecutor([
      { ok: true, data: { authenticated: true, initialized: true, compatible: true } },
      { ok: true, data: { wallet: { address: ADDRESS } } },
    ]),
  });
  await wallet.assertReady();
  assert.equal(await wallet.getAddress(), ADDRESS);
});

test("refuses to use a different Agent Wallet than the pinned address", async () => {
  const wallet = createMetaMaskAgentWallet({
    command: "mm",
    expectedAddress: `0x${"c".repeat(40)}`,
    execute: fakeExecutor([{ ok: true, data: { wallet: { address: ADDRESS } } }]),
  });
  await assert.rejects(wallet.getAddress(), /address mismatch/i);
});

test("accepts a pinned Agent Wallet address case-insensitively", async () => {
  const wallet = createMetaMaskAgentWallet({
    command: "mm",
    expectedAddress: ADDRESS.toUpperCase().replace("0X", "0x"),
    execute: fakeExecutor([{ ok: true, data: { address: ADDRESS } }]),
  });
  assert.equal(await wallet.getAddress(), ADDRESS);
});

test("discovers the global npm CLI shim on Windows without a shell", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-cli-test-"));
  const npmDirectory = path.join(root, "npm");
  const entry = path.join(
    npmDirectory,
    "node_modules",
    "@metamask",
    "agent-wallet",
    "dist",
    "index.js",
  );
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(npmDirectory, "mm.cmd"), "@echo off\r\n", "utf8");
  fs.writeFileSync(entry, "", "utf8");

  const environment = { APPDATA: root, PATH: "" };
  assert.equal(findWindowsCommand("mm.cmd", environment), path.join(npmDirectory, "mm.cmd"));
  assert.deepEqual(resolveInvocation("mm.cmd", ["doctor"], { platform: "win32", environment }), {
    executable: process.execPath,
    args: [entry, "doctor"],
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("builds a shell-free Sepolia contract transaction and extracts its hash", async () => {
  const calls = [];
  const wallet = createMetaMaskAgentWallet({
    command: "mm",
    execute: fakeExecutor([{ ok: true, data: { transactionHash: TX_HASH } }], calls),
  });
  const result = await wallet.sendTransaction({
    to: ADDRESS,
    data: "0x1234",
    value: "500",
    gas: 21000,
    intent: "Place auction bid",
  });

  assert.equal(result.transactionHash, TX_HASH);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "mm");
  assert.equal(calls[0].args.includes("--chain-id"), true);
  assert.equal(calls[0].args[calls[0].args.indexOf("--chain-id") + 1], "11155111");
  const payload = JSON.parse(calls[0].args[calls[0].args.indexOf("--payload") + 1]);
  assert.deepEqual(payload, { to: ADDRESS, data: "0x1234", value: "0x1f4", gas: "0x5208" });
});

test("rejects malformed addresses and calldata before invoking the CLI", async () => {
  const calls = [];
  const wallet = createMetaMaskAgentWallet({ command: "mm", execute: fakeExecutor([], calls) });
  await assert.rejects(wallet.sendTransaction({ to: "bad", data: "0x" }), /valid contract/i);
  await assert.rejects(wallet.sendTransaction({ to: ADDRESS, data: "hello" }), /calldata/i);
  assert.equal(calls.length, 0);
});

test("turns missing CLI and timeout failures into actionable errors", () => {
  assert.match(cleanCliError(Object.assign(new Error("spawn mm ENOENT"), { code: "ENOENT" })), /not found/i);
  assert.match(cleanCliError(Object.assign(new Error("timed out"), { killed: true })), /timed out/i);
});

test("supports concurrent independent wallet calls without mixing payloads", async () => {
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
    return { stdout: JSON.stringify({ ok: true, data: { hash: TX_HASH } }) };
  };
  const wallet = createMetaMaskAgentWallet({ command: "mm", execute });
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      wallet.sendTransaction({ to: ADDRESS, data: "0x1234", value: String(index) }),
    ),
  );
  assert.equal(results.length, 40);
  assert.equal(calls.length, 40);
  const values = calls.map((call) => JSON.parse(call.args[call.args.indexOf("--payload") + 1]).value);
  assert.equal(new Set(values).size, 40);
});
