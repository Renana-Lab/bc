import {
  decodeRevertReason,
  filterAuditEvents,
  inspectEventJson,
  joinUrl,
  mapBotConfig,
  mapUserRows,
  mergeAuditEvents,
  normalizeAuditEvent,
  toServiceRow,
} from "./adminCardData";
import { buildCsv, escapeCsvValue } from "./reportUtils";

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);

const budgetEvent = (user, block, logIndex, increase, before, after, amount = "5") => ({
  event: "BudgetChanged",
  address: "0x" + "ff".repeat(20),
  blockNumber: block,
  logIndex,
  transactionHash: `0xtx${block}${logIndex}`,
  returnValues: { 0: "x", campaignAddress: C, user, amount, increase, budgetBefore: before, budgetAfter: after },
});

describe("users and budgets mapper", () => {
  const events = [
    budgetEvent(A, 10, 0, true, "100", "105"),
    budgetEvent(A, 30, 1, false, "105", "100"),
    budgetEvent(B, 20, 0, true, "0", "5"),
  ].map((e) => normalizeAuditEvent(e, "factory"));

  test("orders by latest budget change, then newest registration", () => {
    const rows = mapUserRows({ addresses: [A, B, C], budgets: { [A]: "100", [B]: "5" }, events });
    expect(rows.map((r) => r.address)).toEqual([A, B, C]);
    expect(rows[0].lastChange).toMatchObject({ blockNumber: 30, direction: "decrease", budgetAfter: "100" });
    expect(rows[2].lastChange).toBeNull();
  });
  test("users with no events are newest-registered first", () => {
    const rows = mapUserRows({ addresses: [A, B, C] });
    expect(rows.map((r) => r.address)).toEqual([C, B, A]);
  });
  test("labels and bot flags come from local bot config, case-insensitively", () => {
    const { labels, bots } = mapBotConfig([
      { wallet: A.toUpperCase().replace("0X", "0x"), name: "Bot One" },
      { wallet: "junk" },
      null,
    ]);
    const rows = mapUserRows({ addresses: [A, B], labels, bots });
    expect(rows.find((r) => r.address === A)).toMatchObject({ label: "Bot One", isBot: true });
    expect(rows.find((r) => r.address === B)).toMatchObject({ label: "", isBot: false });
  });
});

describe("audit events", () => {
  test("normalizes every audited event type with a summary and no numeric-index args", () => {
    const failed = normalizeAuditEvent({
      event: "AuctionFinalizationFailed",
      address: "0xFAC",
      blockNumber: "7",
      logIndex: "2",
      transactionHash: "0xt",
      returnValues: { 0: C, 1: "0x", campaignAddress: C, reason: "0x" },
    });
    expect(failed).toMatchObject({ name: "AuctionFinalizationFailed", blockNumber: 7, auction: C });
    expect(Object.keys(failed.args)).toEqual(["campaignAddress", "reason"]);

    const paid = normalizeAuditEvent({
      event: "SellerPaid",
      address: "0xCAMP",
      blockNumber: 1,
      logIndex: 0,
      returnValues: { seller: A, amount: "9" },
    });
    expect(paid.auction).toBe("0xcamp");
    expect(paid.summary).toContain("paid 9");
    const refund = normalizeAuditEvent({
      event: "RefundProcessed",
      address: "0xCAMP",
      blockNumber: 1,
      logIndex: 1,
      returnValues: { contributor: B, amount: "3" },
    });
    expect(refund.actor).toBe(B);
    const created = normalizeAuditEvent({
      event: "AuctionCreatedDetailed",
      address: "0xF",
      blockNumber: 1,
      logIndex: 2,
      returnValues: { campaignAddress: C, seller: A, minimum: "1", endTime: "2", dataDescription: "d" },
    });
    expect(created.summary).toContain("min 1");
  });
  test("merges duplicates and sorts newest first", () => {
    const e1 = normalizeAuditEvent(budgetEvent(A, 1, 0, true, "0", "1"));
    const e2 = normalizeAuditEvent(budgetEvent(A, 2, 0, true, "1", "2"));
    const e3 = normalizeAuditEvent(budgetEvent(A, 2, 5, true, "2", "3"));
    expect(mergeAuditEvents([e1, e2], [e2, e3]).map((e) => e.blockNumber * 10 + e.logIndex)).toEqual([25, 20, 10]);
  });
  test("filters by type and text", () => {
    const events = [
      normalizeAuditEvent(budgetEvent(A, 1, 0, true, "0", "1")),
      normalizeAuditEvent({
        event: "SellerPaid",
        address: "0xCAMP",
        blockNumber: 2,
        logIndex: 0,
        returnValues: { seller: B, amount: "9" },
      }),
    ];
    expect(filterAuditEvents(events, { types: ["SellerPaid"] })).toHaveLength(1);
    expect(filterAuditEvents(events, { query: A.toUpperCase().replace("0X", "") })).toHaveLength(1);
    expect(filterAuditEvents(events, {})).toHaveLength(2);
  });
  test("inspect view is valid JSON containing the raw args", () => {
    const json = JSON.parse(inspectEventJson(normalizeAuditEvent(budgetEvent(A, 4, 1, true, "0", "1"))));
    expect(json).toMatchObject({ event: "BudgetChanged", blockNumber: 4, args: { user: A, increase: "true" } });
  });
  test("decodes Error(string) revert reasons and keeps other bytes as hex", () => {
    const text = "Too early";
    const body = Buffer.from(text).toString("hex").padEnd(64, "0");
    const data = "0x08c379a0" + "20".padStart(64, "0") + text.length.toString(16).padStart(64, "0") + body;
    expect(decodeRevertReason(data)).toBe(text);
    expect(decodeRevertReason("0xdeadbeef")).toBe("0xdeadbeef");
    expect(decodeRevertReason("0x")).toBe("(empty reason)");
  });
});

describe("operations rows", () => {
  test("maps probe results", () => {
    expect(toServiceRow("x", null).status).toBe("not configured");
    expect(toServiceRow("x", { ok: true, detail: "d" })).toEqual({ name: "x", status: "ok", detail: "d" });
    expect(toServiceRow("x", { ok: false }).status).toBe("down");
    expect(joinUrl("https://f.example/", "/status")).toBe("https://f.example/status");
  });
});

describe("CSV escaping", () => {
  test("neutralizes formula injection", () => {
    ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\t=1", '=HYPERLINK("http://x")'].forEach((value) => {
      expect(escapeCsvValue(value).replace(/^"/, "")).toMatch(/^'/);
    });
  });
  test("leaves plain numbers and ordinary text alone", () => {
    expect(escapeCsvValue("-5")).toBe("-5");
    expect(escapeCsvValue("1500000000000000000")).toBe("1500000000000000000");
    expect(escapeCsvValue("hello")).toBe("hello");
    expect(escapeCsvValue(null)).toBe("");
  });
  test("still quotes commas, quotes and newlines", () => {
    expect(escapeCsvValue('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(escapeCsvValue("=a,b")).toBe("\"'=a,b\"");
  });
  test("applies to headers and every cell of a built CSV", () => {
    expect(buildCsv([{ "=evil": "@x", ok: "fine" }])).toBe("'=evil,ok\r\n'@x,fine");
  });
});
