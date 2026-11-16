import { ADMIN_GAS_RESERVE_WEI, parseNative } from "../../real_ethereum/wallets/nativeBalance";
import {
  addressesFromEvents, buildParticipantRows, loadManualAddresses, planTopUp, runTopUps, saveManualAddresses, selectLowRows,
} from "./participantsGasData";
import { readNativeBalances } from "./participantsGasReaders";

jest.mock("./participantsGasReaders", () => ({ ...jest.requireActual("./participantsGasReaders") }));

const a = (n) => `0x${String(n).repeat(40)}`;
const TEST = (text) => parseNative(text);

describe("building the participant list", () => {
  test("merges factory users, bidders/sellers from events, manual addresses and bots, de-duplicated case-insensitively", () => {
    const events = [
      { actor: a(2).toUpperCase().replace("0X", "0x"), blockNumber: 10, args: {} },
      { actor: a(2), blockNumber: 25, args: {} },
      { actor: "", blockNumber: 30, args: { seller: a(3) } },
      { actor: "not-an-address", blockNumber: 31, args: {} },
    ];
    const rows = buildParticipantRows({
      users: [a(1), a(2).toUpperCase().replace("0X", "0x")], events, manual: [a(1), a(4)], bots: new Set([a(5)]),
      labels: { [a(5)]: "bot-1" }, latestBlock: 100,
    });
    expect(rows.map((row) => row.address).sort()).toEqual([a(1), a(2), a(3), a(4), a(5)]);
    expect(new Set(rows.map((row) => row.address)).size).toBe(rows.length);
    const two = rows.find((row) => row.address === a(2));
    expect(two.sources.sort()).toEqual(["activity", "factory"]);
    expect(two.lastBlock).toBe(25);
    expect(two.blocksAgo).toBe(75);
    expect(rows.find((row) => row.address === a(5))).toMatchObject({ isBot: true, label: "bot-1" });
    expect(rows.find((row) => row.address === a(4)).sources).toEqual(["manual"]);
    expect(rows.find((row) => row.address === a(1)).sources.sort()).toEqual(["factory", "manual"]);
  });

  test("pid stays blank unless a participant list provides it", () => {
    const rows = buildParticipantRows({ users: [a(1), a(2)], pidByAddress: { [a(2)]: "abc" } });
    expect(rows.find((row) => row.address === a(1)).pid).toBe("");
    expect(rows.find((row) => row.address === a(2)).pid).toBe("abc");
  });

  test("addressesFromEvents keeps the latest block per address", () => {
    const found = addressesFromEvents([{ actor: a(1), blockNumber: 3 }, { actor: a(1), blockNumber: 9 }, { actor: a(1), blockNumber: 5 }]);
    expect(found.get(a(1))).toBe(9);
  });

  test("rows below the threshold are flagged low and sorted first; unknown balances are never flagged", () => {
    const rows = buildParticipantRows({
      users: [a(1), a(2), a(3), a(4)],
      balances: { [a(1)]: TEST("0.5"), [a(2)]: TEST("0.05"), [a(3)]: TEST("0.1"), [a(4)]: null },
      thresholdWei: TEST("0.1"),
    });
    expect(rows.map((row) => row.address)).toEqual([a(2), a(3), a(1), a(4)]);
    expect(rows.map((row) => row.low)).toEqual([true, false, false, false]); // exactly at the threshold is not low
    expect(selectLowRows(rows).map((row) => row.address)).toEqual([a(2)]);
  });

  test("manual addresses persist in localStorage, valid and unique only", () => {
    window.localStorage.clear();
    saveManualAddresses([a(1), a(1), "junk", a(2).toUpperCase().replace("0X", "0x")]);
    expect(loadManualAddresses()).toEqual([a(1), a(2)]);
  });

  test("planTopUp: count and total", () => {
    expect(planTopUp({ rows: [1, 2, 3], amountText: "0.5" })).toEqual({ amountWei: TEST("0.5"), count: 3, totalWei: TEST("1.5") });
    expect(planTopUp({ rows: [1], amountText: "x" }).amountWei).toBeNull();
  });
});

describe("runTopUps", () => {
  const setup = ({ balance = TEST("100"), failOn = null } = {}) => {
    const sent = [];
    const order = [];
    let current = balance;
    return {
      sent, order,
      send: jest.fn(async (to, amount) => {
        order.push(`start:${to}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (failOn === to) throw Object.assign(new Error("rejected"), { code: 4001 });
        sent.push([to, amount]);
        current -= amount;
        order.push(`end:${to}`);
        return `0x${sent.length}`;
      }),
      waitFor: jest.fn(async () => true),
      getAdminBalance: jest.fn(async () => current),
    };
  };

  test("sends exactly the selected rows, one transaction each, strictly sequentially, with live statuses", async () => {
    const t = setup();
    const statuses = [];
    const results = await runTopUps({ targets: [a(1), a(2), a(3)], amountWei: TEST("0.5"), ...t, onStatus: (address, status) => statuses.push([address, status.state]) });
    expect(t.sent).toEqual([[a(1), TEST("0.5")], [a(2), TEST("0.5")], [a(3), TEST("0.5")]]);
    expect(t.order).toEqual([`start:${a(1)}`, `end:${a(1)}`, `start:${a(2)}`, `end:${a(2)}`, `start:${a(3)}`, `end:${a(3)}`]);
    expect(results.map((r) => r.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(statuses.filter(([address]) => address === a(1)).map(([, state]) => state)).toEqual(["sending", "sent", "confirmed"]);
  });

  test("stops when the admin balance cannot cover the next transfer plus the gas reserve; the rest is skipped", async () => {
    const t = setup({ balance: TEST("1.2") + ADMIN_GAS_RESERVE_WEI - 1n });
    const results = await runTopUps({ targets: [a(1), a(2), a(3)], amountWei: TEST("0.5"), ...t });
    expect(t.sent.map(([to]) => to)).toEqual([a(1), a(2)]); // 1.2 covers two 0.5 sends, then the reserve is short
    expect(results.map((r) => r.state)).toEqual(["confirmed", "confirmed", "skipped"]);
    expect(results[2].error).toMatch(/too low/i);
  });

  test("does not start at all when the admin balance is already too low", async () => {
    const t = setup({ balance: 1n });
    const results = await runTopUps({ targets: [a(1), a(2)], amountWei: TEST("0.5"), ...t });
    expect(t.send).not.toHaveBeenCalled();
    expect(results.map((r) => r.state)).toEqual(["skipped", "skipped"]);
  });

  test("a rejected signature stops the run (no more prompts)", async () => {
    const t = setup({ failOn: a(2) });
    const results = await runTopUps({ targets: [a(1), a(2), a(3)], amountWei: TEST("0.5"), ...t });
    expect(results.map((r) => r.state)).toEqual(["confirmed", "failed", "skipped"]);
    expect(t.send).toHaveBeenCalledTimes(2);
  });

  test("an unreadable admin balance stops the run instead of guessing", async () => {
    const t = setup();
    t.getAdminBalance.mockRejectedValue(new Error("rpc down"));
    const results = await runTopUps({ targets: [a(1)], amountWei: TEST("0.5"), ...t });
    expect(results[0]).toMatchObject({ state: "skipped" });
    expect(t.send).not.toHaveBeenCalled();
  });
});

describe("readNativeBalances batching", () => {
  test("reads in batches of 25 addresses, never one call per address", async () => {
    const addresses = Array.from({ length: 60 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const execute = jest.fn(async (operation) => {
      const requests = [];
      const web3 = { BatchRequest: function Batch() { this.add = (r) => requests.push(r); this.execute = () => requests.forEach((r) => r()); }, eth: { getBalance: { request: (address, _tag, cb) => () => cb(null, "0x10") } } };
      return operation({ web3 });
    });
    const balances = await readNativeBalances(addresses, { execute });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(Object.keys(balances)).toHaveLength(60);
    expect(balances[addresses[0]]).toBe(16n);
  });
  test("a failed batch yields null (shown as a dash), not zero", async () => {
    const balances = await readNativeBalances([a(1)], { execute: async () => { throw new Error("rpc down"); } });
    expect(balances[a(1)]).toBeNull();
  });
});
