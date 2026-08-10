import { publishActiveAuctions } from "./activeAuctionRegistry";

describe("active auction registry", () => {
  const factoryAddress = "0x1111111111111111111111111111111111111111";

  beforeEach(() => {
    window.localStorage.clear();
  });

  test("keeps only open auctions and accepts millisecond timestamps from the UI", () => {
    const now = Date.now();
    const snapshot = publishActiveAuctions(factoryAddress, [
      {
        address: "0x2222222222222222222222222222222222222222",
        endTime: now + 60000,
        closed: false,
        minimumContribution: "100",
      },
      {
        address: "0x3333333333333333333333333333333333333333",
        endTime: now - 60000,
        closed: true,
      },
    ]);

    expect(snapshot.activeAuctions).toHaveLength(1);
    expect(snapshot.activeAuctions[0].address).toBe(
      "0x2222222222222222222222222222222222222222",
    );
    expect(snapshot.activeAuctions[0].endTimeSec).toBeGreaterThan(
      Math.floor(now / 1000),
    );
  });

  test("merges newly published auctions with still-active entries", () => {
    const endTime = Date.now() + 60000;
    publishActiveAuctions(factoryAddress, [
      {
        address: "0x4444444444444444444444444444444444444444",
        endTime,
      },
    ]);

    const snapshot = publishActiveAuctions(factoryAddress, [
      {
        address: "0x5555555555555555555555555555555555555555",
        endTime,
      },
    ]);

    expect(snapshot.activeAuctions.map((auction) => auction.address)).toEqual(
      expect.arrayContaining([
        "0x4444444444444444444444444444444444444444",
        "0x5555555555555555555555555555555555555555",
      ]),
    );
  });
});
