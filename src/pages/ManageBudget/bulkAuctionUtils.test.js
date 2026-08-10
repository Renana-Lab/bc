import {
  BULK_MAX_AUCTIONS,
  getAuctionValidationError,
  getTransactionErrorMessage,
  makeBulkAuctionRows,
  parseBulkAuctions,
  serializeBulkAuctions,
} from "./bulkAuctionUtils";

describe("bulk auction import stress cases", () => {
  test.each(["|", "\t", ","])("parses %s-delimited rows and removes a header", (delimiter) => {
    const rows = parseBulkAuctions(
      [
        ["Description", "Data", "Minimum", "Duration"].join(delimiter),
        ["Auction 1", "Dataset 1", "100", "10"].join(delimiter),
      ].join("\n"),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dataDescription: "Auction 1",
      dataForSell: "Dataset 1",
      minimumContribution: "100",
      auctionDuration: "10",
    });
  });

  test("parses quoted CSV fields containing commas", () => {
    const [row] = parseBulkAuctions(
      '"Study, phase 1","payload, private",100,10',
    );

    expect(row.dataDescription).toBe("Study, phase 1");
    expect(row.dataForSell).toBe("payload, private");
    expect(row.minimumContribution).toBe("100");
    expect(row.auctionDuration).toBe("10");
  });

  test("generates and round-trips the maximum supported batch", () => {
    const rows = makeBulkAuctionRows({
      rowCount: BULK_MAX_AUCTIONS,
      minimumContribution: "999999999999999999999999",
      auctionDuration: "30",
      descriptionPrefix: "Stress",
      dataPrefix: "Payload",
    });
    const reparsed = parseBulkAuctions(serializeBulkAuctions(rows));

    expect(rows).toHaveLength(BULK_MAX_AUCTIONS);
    expect(reparsed).toHaveLength(BULK_MAX_AUCTIONS);
    expect(reparsed[29]).toMatchObject(rows[29]);
  });

  test("validation handles malformed and extreme values without throwing", () => {
    expect(
      getAuctionValidationError({
        minimumContribution: "1",
        auctionDuration: "1",
      }),
    ).toMatch(/data for sale/i);
    expect(
      getAuctionValidationError({
        minimumContribution: "999999999999999999999999999999999999",
        auctionDuration: "30",
        dataForSell: "data",
        dataDescription: "description",
      }),
    ).toBe("");
    expect(
      getAuctionValidationError({
        minimumContribution: "1.5",
        auctionDuration: "1",
        dataForSell: "data",
        dataDescription: "description",
      }),
    ).toMatch(/whole number/i);
  });

  test("normalizes common wallet transaction failures", () => {
    expect(getTransactionErrorMessage({ code: 4001 })).toMatch(/rejected/i);
    expect(
      getTransactionErrorMessage({ message: "replacement transaction underpriced" }),
    ).toMatch(/pending transaction/i);
  });
});
