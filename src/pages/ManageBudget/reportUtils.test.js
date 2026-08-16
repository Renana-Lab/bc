import {
  buildReportPayload,
  buildReportSheets,
  compareWeiDesc,
  filterReportsByDate,
  getReportDateRangeMs,
  isEndTimeInDateRange,
  mapWithConcurrency,
  shortAddress,
  toAuctionListStateRows,
  toDateInputValue,
} from "./reportUtils";

const makeReport = ({ index = 1, transactions = [], highestBid = "0" } = {}) => ({
  auction: {
    index,
    address: `0x${String(index).padStart(40, "0")}`,
    minimumContribution: "100",
    balance: highestBid,
    approversCount: transactions.length ? 1 : 0,
    seller: "0x1111111111111111111111111111111111111111",
    highestBid,
    dataForSell: "payload",
    dataDescription: `Auction ${index}`,
    highestBidder: transactions.length
      ? "0x2222222222222222222222222222222222222222"
      : "0x0000000000000000000000000000000000000000",
    addresses: transactions.length
      ? ["0x2222222222222222222222222222222222222222"]
      : [],
    endTime: "1780000000",
    closed: false,
    closedReadError: "",
  },
  ended: true,
  transactions,
  bidderStatuses: [],
});

describe("report generation stress cases", () => {
  test("preserves order while enforcing concurrency over hundreds of jobs", async () => {
    let active = 0;
    let peak = 0;
    const values = Array.from({ length: 250 }, (_, index) => index);
    const result = await mapWithConcurrency(values, 7, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value % 3));
      active -= 1;
      return value * 2;
    });

    expect(peak).toBeLessThanOrEqual(7);
    expect(result).toEqual(values.map((value) => value * 2));
  });

  test("a zero concurrency limit cannot silently skip all work", async () => {
    await expect(mapWithConcurrency([1, 2, 3], 0, async (value) => value)).resolves.toEqual([
      1,
      2,
      3,
    ]);
  });

  test("handles date boundaries and invalid timestamps", () => {
    const seconds = Date.parse("2026-05-25T12:00:00.000Z") / 1000;
    expect(isEndTimeInDateRange(seconds, { from: "2026-05-25", to: "2026-05-25" })).toBe(true);
    expect(isEndTimeInDateRange(0, { from: "2026-05-25", to: "2026-05-25" })).toBe(false);
    expect(toDateInputValue(seconds)).toBe("2026-05-25");
    expect(filterReportsByDate([{ auction: { endTime: seconds } }], { from: "2026-05-26", to: "2026-05-27" })).toEqual([]);
    const endOfDay = Date.parse("2026-05-25T23:59:59.999") / 1000;
    expect(isEndTimeInDateRange(endOfDay, { from: "2026-05-25", to: "2026-05-25" })).toBe(true);
    expect(isEndTimeInDateRange(seconds, { from: "not-a-date", to: "2026-05-25" })).toBe(false);
    expect(getReportDateRangeMs({ from: "not-a-date" }).invalidFrom).toBe(true);
  });

  test("sorts wei beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const values = ["9", "100000000000000000000000", "10"];
    expect(values.sort(compareWeiDesc)).toEqual([
      "100000000000000000000000",
      "10",
      "9",
    ]);
  });

  test("keeps zero-bid auctions in sheets and raw payloads", () => {
    const reports = [makeReport({ index: 1 }), makeReport({ index: 2 })];
    const sheets = buildReportSheets(reports, []);
    const payload = buildReportPayload(reports, []);
    const allBids = sheets.find((sheet) => sheet.name === "All Bids");

    expect(payload.auctions).toHaveLength(2);
    expect(allBids.rows).toHaveLength(2);
    expect(allBids.rows.every((row) => row["Row Type"] === "No bids")).toBe(true);
  });

  test("formats empty and valid addresses safely", () => {
    expect(shortAddress("")).toBe("");
    expect(shortAddress("0x1234567890abcdef")).toBe("0x1234...cdef");
  });

  test("includes selected activity history without duplicating it in report options", () => {
    const activityRows = [
      {
        "Time ISO": "2026-08-11T08:30:00.000Z",
        "Users Online": 4,
        "Admins Online": 1,
        "Bots Online": 3,
        "Active Auctions": 2,
        "Browser Sessions": 6,
      },
    ];
    const options = { activityRows, sections: { activity: true } };
    const sheets = buildReportSheets([makeReport()], [], options);
    const payload = buildReportPayload([makeReport()], [], options);

    expect(sheets.find((sheet) => sheet.name === "Site Activity")?.rows).toEqual(
      activityRows
    );
    expect(payload.tables.activityRows).toEqual(activityRows);
    expect(payload.totals.activitySamples).toBe(1);
    expect(payload.options.activityRows).toBeUndefined();
  });

  test("exports the range baseline and every observed auction-list state", () => {
    const rows = toAuctionListStateRows([
      {
        stateId: "state-1",
        observedAtIso: "2026-08-16T10:00:00.000Z",
        boundaryRole: "Baseline at range start",
        factoryAddress: "0xfactory",
        marketLabel: "Production",
        source: "auction-created",
        knownAddressCount: 4,
        unreadableCount: 0,
        activeAuctions: [{
          address: "0xauction",
          manager: "0xseller",
          endTimeSec: 1786878000,
          minimumContribution: "100",
          highestBid: "0",
          highestBidder: "0x0",
          approversCount: 0,
          closed: false,
        }],
        finalizableAuctions: [],
      },
      {
        stateId: "state-2",
        observedAtIso: "2026-08-16T10:05:00.000Z",
        activeAuctions: [],
        finalizableAuctions: [],
      },
    ]);
    const options = { listStateRows: rows, sections: { listState: true } };
    const sheets = buildReportSheets([], [], options);
    const payload = buildReportPayload([], [], options);

    expect(sheets.find((sheet) => sheet.name === "Auction List History")?.rows)
      .toEqual(rows);
    expect(rows[0]["Boundary Role"]).toBe("Baseline at range start");
    expect(rows[1]["List State"]).toBe("No tracked auctions");
    expect(payload.tables.listStateRows).toEqual(rows);
    expect(payload.totals.listStateObservations).toBe(2);
    expect(payload.options.listStateRows).toBeUndefined();
  });

  test("makes an empty observed range explicit instead of dropping the sheet", () => {
    const rows = toAuctionListStateRows([], {
      from: "2026-08-16T00:00:00.000Z",
      to: "2026-08-16T23:59:59.999Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].Status).toBe("No observations");
  });
});
