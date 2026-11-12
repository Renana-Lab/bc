import { describeBidError } from "./ContributeForm";

jest.mock("../real_ethereum/campaign", () => () => ({}));
jest.mock("../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn() }));
jest.mock("../real_ethereum/ethereumProvider", () => ({ getEthereumAccounts: jest.fn() }));

test.each([
  [{ message: "execution reverted: Bid must exceed current highest" }, false, /outbid/],
  [{ message: "insufficient funds for gas * price + value" }, false, /network fee/],
  [{ code: 4100, message: "locked" }, false, /locked/],
  [{ message: "Wallet verification expired. Retry the connection." }, false, /verification expired/],
  [{ code: 4001, message: "User rejected" }, false, /cancel your bid/],
  [{ message: "execution reverted: Auction ended" }, true, /deadline/],
])("%p maps to a specific message", (error, closed, expected) => {
  expect(describeBidError(error, closed)).toMatch(expected);
});

test("an unknown failure shows the real message, not 'outbid'", () => {
  const message = describeBidError(new Error("RPC node unreachable"), false);
  expect(message).toBe("RPC node unreachable");
  expect(message).not.toMatch(/outbid/);
});
