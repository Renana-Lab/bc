import { getBotBidderNames, LOCAL_BOTS_KEY } from "./botPresence";

const A = "0x" + "a".repeat(40);
const B = "0x" + "B".repeat(40);

describe("getBotBidderNames", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete process.env.REACT_APP_BIDDER_NAMES;
  });

  test("maps bot wallets from local storage, lower-cased", () => {
    window.localStorage.setItem(LOCAL_BOTS_KEY, JSON.stringify([{ wallet: B, name: " Bot 1 " }, { wallet: "bad", name: "x" }]));
    const names = getBotBidderNames();
    expect(names.get(B.toLowerCase())).toBe("Bot 1");
    expect(names.size).toBe(1);
  });

  test("merges REACT_APP_BIDDER_NAMES aliases", () => {
    process.env.REACT_APP_BIDDER_NAMES = JSON.stringify({ [A]: "Alice" });
    expect(getBotBidderNames().get(A)).toBe("Alice");
  });

  test("tolerates invalid JSON", () => {
    window.localStorage.setItem(LOCAL_BOTS_KEY, "{oops");
    process.env.REACT_APP_BIDDER_NAMES = "{oops";
    expect(getBotBidderNames().size).toBe(0);
  });
});
