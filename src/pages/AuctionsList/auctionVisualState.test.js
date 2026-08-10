import { preserveAuctionUserState } from "./auctionVisualState";

const USER = "0x1111111111111111111111111111111111111111";
const OTHER_USER = "0x2222222222222222222222222222222222222222";
const AUCTION = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const userAuction = {
  address: AUCTION,
  highestBid: "100",
  addresses: [USER],
  isRefunded: true,
  hasUserStatus: true,
  userStatusAddress: USER,
};

test("preserves resolved wallet state while common auction data refreshes", () => {
  const [result] = preserveAuctionUserState(
    [userAuction],
    [
      {
        address: AUCTION,
        highestBid: "250",
        addresses: [],
        isRefunded: false,
        hasUserStatus: false,
        userStatusAddress: "",
      },
    ],
    USER,
  );

  expect(result.highestBid).toBe("250");
  expect(result.addresses).toEqual([USER]);
  expect(result.isRefunded).toBe(true);
});

test("does not carry wallet state across accounts", () => {
  const nextAuction = {
    address: AUCTION,
    addresses: [],
    isRefunded: false,
    hasUserStatus: false,
    userStatusAddress: "",
  };

  const [result] = preserveAuctionUserState(
    [userAuction],
    [nextAuction],
    OTHER_USER,
  );

  expect(result).toBe(nextAuction);
});

test("uses newly resolved wallet state instead of stale state", () => {
  const nextAuction = {
    address: AUCTION,
    addresses: [],
    isRefunded: false,
    hasUserStatus: true,
    userStatusAddress: USER,
  };

  const [result] = preserveAuctionUserState(
    [userAuction],
    [nextAuction],
    USER,
  );

  expect(result).toBe(nextAuction);
  expect(result.isRefunded).toBe(false);
});
