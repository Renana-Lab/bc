/** @jest-environment node */
import { createHash } from "crypto";
import { beaconSweep, fetchSweepConfig, fetchSweeps, pidHashFor, postSweep, saveSweepIdleMinutes } from "./sweepClient.mjs";

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("the pid hash matches what the faucet stores for each pid mode", () => {
  expect(pidHashFor({ strictPid: "ABCDEFGH2345XYZ9", pidMode: "allowlist" })).toBe(sha("ABCDEFGH2345XYZ9"));
  expect(pidHashFor({ strictPid: "5F1A2B3C4D5E6F7A8B9C0D1E", pidMode: "prolific" })).toBe(sha("5f1a2b3c4d5e6f7a8b9c0d1e"));
  expect(pidHashFor({ strictPid: "x", openPid: " Any-Id_1 ", pidMode: "open" })).toBe(sha("Any-Id_1"));
  expect(pidHashFor({ pidMode: "open" })).toBe("");
});

test("config and posts never throw", async () => {
  expect(await fetchSweepConfig({ faucetUrl: "https://f.example/", fetchImpl: async () => reply(200, { sweepAddress: "0x1", chainId: 1, pidMode: "open" }) })).toMatchObject({ chainId: 1 });
  expect(await fetchSweepConfig({ faucetUrl: "https://f.example", fetchImpl: async () => { throw new Error("offline"); } })).toBeNull();
  expect(await fetchSweepConfig({ faucetUrl: "https://f.example", fetchImpl: async () => reply(500, {}) })).toBeNull();
  const calls = [];
  const result = await postSweep({ faucetUrl: "https://f.example/", path: "/sweep/arm", payload: { a: 1 }, fetchImpl: async (url, init) => { calls.push([url, init.method]); return reply(200, { status: "armed" }); } });
  expect(result).toEqual({ status: 200, body: { status: "armed" } });
  expect(calls).toEqual([["https://f.example/sweep/arm", "POST"]]);
  expect(await postSweep({ faucetUrl: "x", path: "/p", payload: {}, fetchImpl: async () => { throw new Error("offline"); } })).toEqual({ status: 0, body: {} });
});

test("the beacon is best effort", () => {
  const sendBeacon = jest.fn(() => true);
  expect(beaconSweep({ faucetUrl: "https://f.example", path: "/sweep/arm", payload: { a: 1 }, nav: { sendBeacon } })).toBe(true);
  expect(sendBeacon.mock.calls[0][0]).toBe("https://f.example/sweep/arm");
  expect(beaconSweep({ faucetUrl: "x", path: "/p", payload: {}, nav: {} })).toBe(false);
  expect(beaconSweep({ faucetUrl: "x", path: "/p", payload: {}, nav: { sendBeacon: () => { throw new Error("no"); } } })).toBe(false);
});

test("admin calls send the password in a header or body, and report a wrong password", async () => {
  let seen;
  const list = await fetchSweeps({ faucetUrl: "https://f.example", password: "pw", fetchImpl: async (url, init) => { seen = init; return reply(200, { idleMinutes: 30, sweeps: [] }); } });
  expect(seen.headers["x-admin-password"]).toBe("pw");
  expect(list.idleMinutes).toBe(30);
  await expect(fetchSweeps({ faucetUrl: "x", password: "no", fetchImpl: async () => reply(401, {}) })).rejects.toMatchObject({ code: "unauthorized" });
  expect(await saveSweepIdleMinutes({ faucetUrl: "x", password: "pw", idleMinutes: 45, fetchImpl: async (u, init) => { expect(JSON.parse(init.body)).toEqual({ idleMinutes: 45, password: "pw" }); return reply(200, { idleMinutes: 45 }); } })).toBe(45);
  await expect(saveSweepIdleMinutes({ faucetUrl: "x", password: "pw", idleMinutes: 2, fetchImpl: async () => reply(400, {}) })).rejects.toMatchObject({ code: "failed" });
});
