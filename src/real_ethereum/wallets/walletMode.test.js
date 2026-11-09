import { getWalletMode, WALLET_MODES } from "./walletMode.mjs";
import { guardProvider } from "./sapphireWrap.mjs";

describe("wallet mode", () => {
  test("defaults to metamask and only accepts metamask|privy|local", () => {
    expect(getWalletMode("")).toBe("metamask");
    expect(WALLET_MODES).toEqual(["metamask", "privy", "local"]);
    expect(getWalletMode("LOCAL")).toBe("local");
    expect(() => getWalletMode("apillon")).toThrow(/Unknown REACT_APP_WALLET_MODE/);
  });
});

describe("calldata guard", () => {
  test("refuses plaintext calldata, in data or input, before it reaches the wallet", async () => {
    const request = jest.fn(async () => "0x1");
    const guarded = guardProvider({ request });
    for (const field of ["data", "input"]) {
      await expect(guarded.request({ method: "eth_sendTransaction", params: [{ to: "0x" + "1".repeat(40), [field]: "0xd7bb99ba" }] }))
        .rejects.toThrow(/plaintext calldata/);
    }
    await expect(guarded.request({ method: "wallet_sendCalls", params: [{}] })).rejects.toThrow(/not supported/);
    expect(request).not.toHaveBeenCalled();
    await guarded.request({ method: "eth_sendTransaction", params: [{ to: "0x" + "1".repeat(40), value: "0x1" }] });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
