import { getRunningBotDescriptors, LOCAL_BOTS_KEY } from "./botPresence";
import { toActivityReportRows } from "./presenceClient";

describe("live experiment activity telemetry", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  test("only reports enabled bots that are currently running", () => {
    window.localStorage.setItem(
      LOCAL_BOTS_KEY,
      JSON.stringify([
        { id: "a", wallet: "0xaaa", running: true, enabled: true },
        { id: "b", wallet: "0xbbb", running: false, enabled: true },
        { id: "c", wallet: "0xccc", running: true, enabled: false },
        { id: "missing-wallet", running: true, enabled: true },
      ])
    );

    expect(getRunningBotDescriptors()).toEqual([{ id: "a", wallet: "0xaaa" }]);
  });

  test("converts minute samples into documented report metrics", () => {
    const rows = toActivityReportRows([
      {
        timestampIso: "2026-08-11T10:15:00.000Z",
        users: 5,
        admins: 1,
        bots: 4,
        activeAuctions: 3,
        sessions: 7,
      },
    ]);

    expect(rows[0]).toMatchObject({
      "Time ISO": "2026-08-11T10:15:00.000Z",
      "Users Online": 5,
      "Admins Online": 1,
      "Bots Online": 4,
      "Active Auctions": 3,
      "Browser Sessions": 7,
      "Sample Interval": "1 minute",
    });
  });
});
