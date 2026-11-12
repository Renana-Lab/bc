import { Wallet, id } from "ethers";
import fs from "fs";
import path from "path";
import { webcrypto } from "crypto";
import {
  ADMIN_GATE_NOTE,
  buildAdminGateMessage,
  getExpectedGateContext,
  clearAdminProof,
  getVerifiedAdminAddress,
  isAdminAddress,
  parseAdminAddresses,
  requestAdminProof,
  verifyAdminProof,
} from "./adminGate";

// jsdom has no crypto.getRandomValues, which the SIWE nonce needs.
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

// Deterministic throwaway test wallets derived from labels (no literal keys in the repo).
const admin = new Wallet(id("admin-gate-test-admin"));
const outsider = new Wallet(id("admin-gate-test-outsider"));
const allowlist = parseAdminAddresses(admin.address);
const base = getExpectedGateContext();
const upperHex = (address) => address.toUpperCase().replace("0X", "0x");

const proofFor = async (wallet, now = new Date()) => {
  const message = buildAdminGateMessage({ address: wallet.address, ...base, now });
  return { address: wallet.address, message, signature: await wallet.signMessage(message) };
};

describe("allowlist parsing", () => {
  test("is case-insensitive, trims, dedupes and drops junk", () => {
    const list = parseAdminAddresses(
      ` ${upperHex(admin.address)} ,${admin.address.toLowerCase()};not-an-address, 0x123 ,\n${outsider.address}`
    );
    expect(list).toEqual([admin.address.toLowerCase(), outsider.address.toLowerCase()]);
  });
  test("empty or missing input means nobody is an admin", () => {
    expect(parseAdminAddresses(undefined)).toEqual([]);
    expect(parseAdminAddresses("")).toEqual([]);
    expect(isAdminAddress(admin.address, [])).toBe(false);
  });
  test("membership ignores case", () => {
    expect(isAdminAddress(admin.address.toLowerCase(), allowlist)).toBe(true);
    expect(isAdminAddress(upperHex(admin.address), allowlist)).toBe(true);
    expect(isAdminAddress(outsider.address, allowlist)).toBe(false);
    expect(isAdminAddress("", allowlist)).toBe(false);
  });
});

describe("signature proof", () => {
  beforeEach(() => clearAdminProof());

  test("accepts a fresh signature from an allowlisted wallet", async () => {
    expect(verifyAdminProof({ ...(await proofFor(admin)), allowlist }).ok).toBe(true);
  });
  test("refuses a valid signature from a wallet that is not allowlisted", async () => {
    expect(verifyAdminProof({ ...(await proofFor(outsider)), allowlist })).toEqual({
      ok: false,
      reason: "not-allowlisted",
    });
  });
  test("refuses a signature made by a different key than the claimed address", async () => {
    const proof = await proofFor(admin);
    const forged = await outsider.signMessage(proof.message);
    expect(verifyAdminProof({ ...proof, signature: forged, allowlist }).reason).toBe("bad-signature");
  });
  test("refuses expired proofs", async () => {
    const proof = await proofFor(admin, new Date(Date.now() - 2 * 60 * 60 * 1000));
    expect(verifyAdminProof({ ...proof, allowlist }).reason).toBe("expired");
  });
  test("refuses proofs bound to another chain, domain or URI", async () => {
    const sign = async (context) => {
      const message = buildAdminGateMessage({ address: admin.address, ...context });
      return { address: admin.address, message, signature: await admin.signMessage(message) };
    };
    expect(verifyAdminProof({ ...(await sign({ ...base, chainId: 1 })), allowlist }).reason).toBe("wrong-chain");
    expect(verifyAdminProof({ ...(await sign({ ...base, domain: "evil.example" })), allowlist }).reason).toBe("wrong-domain");
    expect(verifyAdminProof({ ...(await sign({ ...base, uri: "https://evil.example" })), allowlist }).reason).toBe("wrong-uri");
  });
  test("refuses a message that is not the admin gate statement", async () => {
    const message = buildAdminGateMessage({ address: admin.address, ...base }).replace(
      "Unlock the Admin Zone UI",
      "Something else"
    );
    const signature = await admin.signMessage(message);
    expect(verifyAdminProof({ address: admin.address, message, signature, allowlist }).reason).toBe("bad-message");
  });
  test("requestAdminProof never prompts a non-admin wallet", async () => {
    const provider = { request: jest.fn() };
    await expect(
      requestAdminProof({ provider, account: outsider.address, ...base, allowlist })
    ).rejects.toThrow(/not on the admin list/);
    expect(provider.request).not.toHaveBeenCalled();
  });
  test("requestAdminProof signs via personal_sign and stores a verifiable proof", async () => {
    const provider = {
      request: jest.fn(async ({ params: [hex] }) =>
        admin.signMessage(Buffer.from(hex.slice(2), "hex").toString("utf8"))
      ),
    };
    await requestAdminProof({ provider, account: admin.address, ...base, allowlist });
    expect(provider.request.mock.calls[0][0].method).toBe("personal_sign");
    expect(getVerifiedAdminAddress(admin.address, { allowlist })).toBe(admin.address.toLowerCase());
    // A stored proof does not carry over to another connected account or a changed allowlist.
    expect(getVerifiedAdminAddress(outsider.address, { allowlist })).toBe("");
    expect(getVerifiedAdminAddress(admin.address, { allowlist: [] })).toBe("");
  });
  test("tampered stored proof is rejected", async () => {
    const proof = await proofFor(admin);
    window.sessionStorage.setItem(
      "bc:admin-gate:proof:v1",
      JSON.stringify({ ...proof, signature: "0x" + "00".repeat(65) })
    );
    expect(getVerifiedAdminAddress(admin.address, { allowlist })).toBe("");
  });
});

describe("no hard-coded admin secret", () => {
  test("ManageBudgetPage has no 1234 key or key prompt", () => {
    const source = fs.readFileSync(path.join(__dirname, "ManageBudgetPage.js"), "utf8");
    expect(source).not.toMatch(/ADMIN_SECRET/);
    expect(source).not.toMatch(/["']1234["']/);
    expect(source).not.toMatch(/Admin Key/);
  });
  test("the gate states that it is UI-only", () => {
    expect(ADMIN_GATE_NOTE).toMatch(/UI gate only/);
    expect(ADMIN_GATE_NOTE).toMatch(/contract has an admin role/);
  });
});
