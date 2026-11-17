import { adminSetFromEvents, loadReportChainData } from "./reportChainData";

jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn() }));
jest.mock("../../real_ethereum/marketConfig", () => ({ getActiveFactoryAddress: () => "0x00000000000000000000000000000000000000f0" }));
jest.mock("../../real_ethereum/adminChain", () => ({ readCancelledSet: jest.fn() }));

const U1 = "0x0000000000000000000000000000000000000001";
const U2 = "0x0000000000000000000000000000000000000002";
const event = (name, blockNumber, args, extra = {}) => ({ name, blockNumber, logIndex: 0, transactionHash: `0x${blockNumber}`, args, actor: "", summary: name, auction: "", ...extra });

const call = async (fn) => {
  const spec = fn({ factory: { methods: new Proxy({}, { get: (_, method) => (...args) => ({ method, args }) }) } });
  if (spec.method === "allUsers") {
    if (spec.args[0] === 0) return U1;
    if (spec.args[0] === 1) return U2;
    throw new Error("execution reverted");
  }
  if (spec.method === "getBudget") return spec.args[0] === U1 ? "90" : "50";
  if (spec.method === "heldBy") return spec.args[0] === U1 ? "10" : "0";
  if (spec.method === "disabled") return spec.args[0] === U2;
  return null;
};

test("builds user history, audit rows and the cancelled set from chain reads", async () => {
  const events = [
    event("BudgetChanged", 4, { user: U1 }, { actor: U1 }),
    event("AdminAdded", 5, { admin: U2 }),
    event("AuctionCancelled", 6, { campaign: "0xc" }, { auction: "0xc" }),
  ];
  const result = await loadReportChainData({
    reports: [{ auction: { address: "0xC", closed: true } }, { auction: { address: "0xd", closed: false } }],
    wantUsers: true, wantAudit: true, wantStatus: true, factoryAddress: "0xf",
    deps: { call, snapshot: async () => ({ events }), cancelled: jest.fn(async (addresses) => new Set(addresses.map((a) => a.toLowerCase()))) },
  });
  expect(result.warnings).toEqual([]);
  expect(result.userHistoryRows.map((row) => [row.Address, row.Total, row.Disabled, row.Role])).toEqual([[U1, "100", "No", "participant"], [U2, "50", "Yes", "admin"]]);
  expect(result.userHistoryRows[0]["Last Change Type"]).toBe("BudgetChanged");
  expect(result.auditRows.map((row) => row.Block)).toEqual([6, 5, 4]);
  expect(result.cancelledAddresses).toEqual(["0xc"]); // only closed auctions are checked
});

test("failed reads become warnings, not a failed report", async () => {
  const result = await loadReportChainData({
    reports: [], wantUsers: true, wantAudit: true, factoryAddress: "0xf",
    deps: { call, snapshot: async () => { throw new Error("rpc down"); } },
  });
  expect(result.warnings.join(" ")).toMatch(/Audit events unavailable: rpc down/);
  expect(result.auditRows).toEqual([]);
  expect(result.userHistoryRows).toHaveLength(2); // users still listed, just without last changes
});

test("admin set follows AdminAdded and AdminRemoved after the allowlist", () => {
  const set = adminSetFromEvents([event("AdminAdded", 1, { admin: U1 }), event("AdminRemoved", 2, { admin: U1 }), event("AdminAdded", 3, { admin: U2 })], ["0xAA"]);
  expect([...set].sort()).toEqual(["0xaa", U2].sort());
});
