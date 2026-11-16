import { byteLength, createAdminActions, validateMinimum, validateNote } from "./adminActions";

jest.mock("../../real_ethereum/factory", () => ({ __esModule: true, default: {} }));
jest.mock("../../real_ethereum/campaign", () => ({ __esModule: true, default: () => ({}) }));
jest.mock("../../real_ethereum/walletAccess", () => ({ requireWalletAccess: async () => ({ account: "0xabc" }) }));

const ADDR = "0x1111111111111111111111111111111111111111";
const CAMPAIGN = "0x2222222222222222222222222222222222222222";

const makeDeps = () => {
  const sends = [];
  const method = (name) =>
    jest.fn((...args) => ({
      send: jest.fn(async (options) => {
        sends.push({ name, args, options });
        return { status: true };
      }),
    }));
  const names = [
    "resetAllBudgets",
    "setUserBudget",
    "setMinimum",
    "closeNow",
    "cancelAuction",
    "setHidden",
    "setDisabled",
    "setAllowSellerEdit",
    "addAdmin",
    "removeAdmin",
  ];
  const factory = { methods: Object.fromEntries(names.map((name) => [name, method(name)])) };
  const campaignMethods = { sellerSetMinimum: method("sellerSetMinimum") };
  return {
    sends,
    deps: { factory, campaign: () => ({ methods: campaignMethods }), requestAccount: async () => ADDR },
  };
};

describe("admin actions", () => {
  test("every action sends from the connected account with validated arguments", async () => {
    const { sends, deps } = makeDeps();
    const actions = createAdminActions(deps);
    await actions.resetAllBudgets("500");
    await actions.setUserBudget(ADDR, "0");
    await actions.setMinimum(CAMPAIGN, 25);
    await actions.sellerSetMinimum(CAMPAIGN, 30);
    await actions.closeNow(CAMPAIGN);
    await actions.cancelAuction(CAMPAIGN, " bad listing ");
    await actions.setHidden(CAMPAIGN, true);
    await actions.setDisabled(ADDR, true);
    await actions.setAllowSellerEdit(false);
    await actions.addAdmin(ADDR);
    await actions.removeAdmin(ADDR);
    expect(sends.map((entry) => [entry.name, entry.args])).toEqual([
      ["resetAllBudgets", ["500"]],
      ["setUserBudget", [ADDR, "0"]],
      ["setMinimum", [CAMPAIGN, "25"]],
      ["sellerSetMinimum", ["30"]],
      ["closeNow", [CAMPAIGN]],
      ["cancelAuction", [CAMPAIGN, "bad listing"]],
      ["setHidden", [CAMPAIGN, true]],
      ["setDisabled", [ADDR, true]],
      ["setAllowSellerEdit", [false]],
      ["addAdmin", [ADDR]],
      ["removeAdmin", [ADDR]],
    ]);
    sends.forEach((entry) => expect(entry.options).toEqual({ from: ADDR }));
  });

  test("global reset rejects 0 (no unlimited budget) and junk", () => {
    const { sends, deps } = makeDeps();
    const actions = createAdminActions(deps);
    expect(() => actions.resetAllBudgets(0)).toThrow(/between 1/);
    expect(() => actions.resetAllBudgets("-3")).toThrow(/whole number/);
    expect(() => actions.resetAllBudgets("1.5")).toThrow(/whole number/);
    expect(sends).toHaveLength(0);
  });

  test("minimum is 1..1e9; notes are capped at 500 bytes (multibyte counted)", () => {
    expect(() => validateMinimum(0)).toThrow();
    expect(() => validateMinimum(1_000_000_001)).toThrow();
    expect(validateMinimum(1_000_000_000)).toBe("1000000000");
    expect(validateNote("x".repeat(500))).toHaveLength(500);
    expect(() => validateNote("x".repeat(501))).toThrow(/500 bytes/);
    expect(byteLength("é")).toBe(2);
    expect(() => validateNote("é".repeat(251))).toThrow(/500 bytes/);
  });

  test("invalid addresses never reach the contract", () => {
    const { sends, deps } = makeDeps();
    const actions = createAdminActions(deps);
    expect(() => actions.addAdmin("0x123")).toThrow(/valid address/);
    expect(() => actions.setHidden("nope", true)).toThrow(/valid address/);
    expect(sends).toHaveLength(0);
  });
});
