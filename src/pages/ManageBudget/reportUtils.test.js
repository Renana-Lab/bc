import {
  buildSalesSummary,
  deriveAuctionStatus,
  toAuditRows,
  toUserHistoryRows,
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

describe("status, sales summary, users and audit tabs", () => {
  const BIDDER = "0x2222222222222222222222222222222222222222";
  const tx = [{ bidderKey: BIDDER, transactionAmountWei: "5" }];
  const soldReport = (index, highestBid) => {
    const report = makeReport({ index, transactions: tx, highestBid });
    report.auction.closed = true;
    return report;
  };

  test("derives the Admin Zone status vocabulary", () => {
    const open = makeReport({ transactions: tx }).auction;
    expect(deriveAuctionStatus(open, { ended: false })).toBe("active");
    expect(deriveAuctionStatus(open, { ended: true })).toBe("ended");
    expect(deriveAuctionStatus(makeReport().auction, { ended: true })).toBe("unsold");
    expect(deriveAuctionStatus({ ...open, closed: true }, { ended: true })).toBe("sold");
    expect(deriveAuctionStatus({ ...makeReport().auction, closed: true }, { ended: true })).toBe("unsold");
    expect(deriveAuctionStatus({ ...open, closed: true }, { ended: true, cancelled: true })).toBe("cancelled");
  });

  test("sales summary counts sold, unsold and cancelled and sums the highest bid of sold auctions only", () => {
    const sold1 = soldReport(1, "100");
    const sold2 = soldReport(2, "250");
    const unsold = makeReport({ index: 3 });
    const cancelled = soldReport(4, "999");
    const summary = buildSalesSummary([sold1, sold2, unsold, cancelled], new Set([cancelled.auction.address]));
    expect(summary).toMatchObject({ sold: 2, unsold: 1, cancelled: 1, totalSalesWei: "350" });
  });

  test("Auction Summary gets a Status column and sales summary rows; JSON totals carry the sales", () => {
    const reports = [soldReport(1, "100"), makeReport({ index: 2 })];
    const sheets = buildReportSheets(reports, []);
    const summary = sheets.find((sheet) => sheet.name === "Auction Summary").rows;
    expect(summary.filter((row) => row["Auction Address"]).map((row) => row.Status)).toEqual(["sold", "unsold"]);
    const sales = summary.filter((row) => row.Description === "Sales summary");
    expect(sales.map((row) => [row.Status, row["Number Of Auctions"], row["Total Sales (wei)"]])).toEqual([
      ["sold", 1, "100"], ["unsold", 1, ""], ["cancelled", 0, ""],
    ]);
    const payload = buildReportPayload(reports, []);
    expect(payload.totals.sales).toMatchObject({ sold: 1, unsold: 1, totalSalesWei: "100" });
    expect(payload.tables.salesSummaryRows).toHaveLength(3);
  });

  test("users and audit rows are built from normalized events", () => {
    const A = "0x00000000000000000000000000000000000000a1";
    const B = "0x00000000000000000000000000000000000000b2";
    const ADMIN = "0x00000000000000000000000000000000000000ad";
    const event = (name, blockNumber, actor, summary) => ({ name, blockNumber, logIndex: 0, transactionHash: `0x${blockNumber}`, actor, summary, auction: "" });
    const events = [
      event("BudgetChanged", 5, A, "A: -10 (100 -> 90)"),
      event("UserBudgetSet", 9, A, "A: total 500, available 500 by admin"),
      event("MinimumChanged", 7, "", "min"),
    ];
    const rows = toUserHistoryRows({
      addresses: [A, B, ADMIN], budgets: { [A]: "90", [B]: "100", [ADMIN]: "5" }, held: { [A]: "10" },
      disabled: new Set([B]), events, labels: { [A]: "Alice" }, bots: new Set([B]), admins: new Set([ADMIN]),
    });
    expect(rows.map((row) => [row.Label, row.Role, row.Available, row.Held, row.Total, row.Disabled])).toEqual([
      ["Alice", "participant", "90", "10", "100", "No"], ["", "bot", "100", "0", "100", "Yes"], ["", "admin", "5", "0", "5", "No"],
    ]);
    expect(rows[0]["Last Change Type"]).toBe("UserBudgetSet"); // the newest of BudgetChanged / UserBudgetSet
    expect(rows[1]["Last Change"]).toBe("");
    expect(toAuditRows(events).map((row) => row.Block)).toEqual([9, 7, 5]);
  });

  test("the new tabs appear in sheets, README and JSON, and honor the section selection", () => {
    const options = {
      userHistoryRows: [{ Address: "0xa", Role: "admin" }],
      auditRows: [{ Event: "AuctionCancelled", Block: 3 }],
    };
    const sheets = buildReportSheets([makeReport()], [], options);
    expect(sheets.find((sheet) => sheet.name === "Users and budget history").rows).toEqual(options.userHistoryRows);
    expect(sheets.find((sheet) => sheet.name === "Audit events").rows).toEqual(options.auditRows);
    const terms = sheets.find((sheet) => sheet.name === "README").rows.map((row) => row.Term);
    expect(terms).toEqual(expect.arrayContaining(["Status", "Sales summary", "Users and budget history", "Audit events"]));
    const payload = buildReportPayload([makeReport()], [], options);
    expect(payload.tables.userHistoryRows).toEqual(options.userHistoryRows);
    expect(payload.tables.auditRows).toEqual(options.auditRows);
    expect(payload.options.userHistoryRows).toBeUndefined();
    const off = buildReportSheets([makeReport()], [], { ...options, sections: { users: false, audit: false } });
    expect(off.some((sheet) => sheet.name === "Audit events")).toBe(false);
    expect(buildReportPayload([makeReport()], [], { ...options, sections: { users: false, audit: false } }).tables.auditRows).toBeUndefined();
  });
});
