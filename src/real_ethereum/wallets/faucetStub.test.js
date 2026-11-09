import { createFaucet } from "./faucetStub.mjs";
import { getParticipantId, isValidParticipantId } from "./participantId.mjs";

const addr = (n) => `0x${String(n).repeat(40)}`;

describe("participant code", () => {
  test("accepts random codes and rejects anything that looks like personal data", () => {
    expect(isValidParticipantId("K7f3QpX9mA2d")).toBe(true);
    for (const bad of ["a@b.com", "0501234567", "12345678", "short1", "has space abc", "a".repeat(40), ""]) {
      expect(isValidParticipantId(bad)).toBe(false);
    }
  });
  test("reads ?pid= and keeps it only in the given session storage", () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    expect(getParticipantId({ search: "?pid=K7f3QpX9mA2d", storage })).toBe("K7f3QpX9mA2d");
    expect(getParticipantId({ search: "", storage })).toBe("K7f3QpX9mA2d");
    expect(getParticipantId({ search: "?pid=a@b.com", storage: { getItem: () => null, setItem: () => {} } })).toBe("");
  });
});

describe("faucet stub policy", () => {
  test("fixed amount, once per code and per address, invalid input rejected", async () => {
    const send = jest.fn(async () => "0xhash");
    const faucet = createFaucet({ amountWei: 10n, send });
    await expect(faucet.claim("K7f3QpX9mA2d", addr(1))).resolves.toEqual({ hash: "0xhash", amountWei: 10n });
    await expect(faucet.claim("K7f3QpX9mA2d", addr(2))).rejects.toThrow(/already received/);
    await expect(faucet.claim("Z9y8XwV7uT6s", addr(1))).rejects.toThrow(/address already/);
    await expect(faucet.claim("a@b.com", addr(3))).rejects.toThrow(/Invalid participant code/);
    await expect(faucet.claim("Z9y8XwV7uT6s", "0x12")).rejects.toThrow(/Invalid address/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  test("concurrent claims for one code pay once; failed sends can be retried", async () => {
    let calls = 0;
    const faucet = createFaucet({
      amountWei: 1n,
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error("rpc down");
        return "0xok";
      },
    });
    await expect(faucet.claim("AAAAbbbb1111", addr(4))).rejects.toThrow(/rpc down/);
    const results = await Promise.allSettled([faucet.claim("AAAAbbbb1111", addr(4)), faucet.claim("AAAAbbbb1111", addr(4))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  test("allowlist of code digests restricts who may claim", async () => {
    const base = createFaucet({ amountWei: 1n, send: async () => "0x1" });
    const faucet = createFaucet({ amountWei: 1n, send: async () => "0x1", allowlist: new Set([base.digestOf("Allowed12345")]) });
    await expect(faucet.claim("Allowed12345", addr(5))).resolves.toBeTruthy();
    await expect(faucet.claim("Unknown12345", addr(6))).rejects.toThrow(/Unknown participant code/);
  });
});
