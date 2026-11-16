import { claimFunds, fetchFaucetStatus, setFaucetState, FAUCET_MESSAGES, NETWORK_MESSAGE } from "./faucetClient.mjs";

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const PID = "5f1a2b3c4d5e6f7a8b9c0d1e";
const base = { faucetUrl: "https://faucet.example/", pid: PID, address: "0x0000000000000000000000000000000000000001", sleep: async () => {} };

describe("faucet client", () => {
  test("POSTs { pid, address, studyId, experimentCode } to /claim and resolves on paid or already_paid", async () => {
    const fetchImpl = jest.fn(async () => reply(200, { status: "paid" }));
    await expect(claimFunds({ ...base, studyId: "S1", experimentCode: "E1", fetchImpl })).resolves.toBe("paid");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://faucet.example/claim");
    expect(JSON.parse(init.body)).toEqual({ pid: PID, address: base.address, studyId: "S1", experimentCode: "E1" });
    const bare = jest.fn(async () => reply(200, { status: "already_paid" }));
    await expect(claimFunds({ ...base, fetchImpl: bare })).resolves.toBe("already_paid");
    expect(JSON.parse(bare.mock.calls[0][1].body)).toEqual({ pid: PID, address: base.address });
  });

  test("a closed faucet shows the friendly message, not a raw error", async () => {
    const fetchImpl = async () => reply(403, { error: "faucet_closed" });
    await expect(claimFunds({ ...base, fetchImpl })).rejects.toMatchObject({ code: "faucet_closed", message: "Test funds are not available right now." });
  });

  test("budget_exhausted, not_eligible and network failures have friendly messages", async () => {
    await expect(claimFunds({ ...base, fetchImpl: async () => reply(403, { error: "budget_exhausted" }) })).rejects.toThrow(FAUCET_MESSAGES.budget_exhausted);
    await expect(claimFunds({ ...base, fetchImpl: async () => reply(403, { error: "not_eligible" }) })).rejects.toThrow(FAUCET_MESSAGES.not_eligible);
    const failed = claimFunds({ ...base, fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    await expect(failed).rejects.toThrow(NETWORK_MESSAGE);
    await expect(failed).rejects.not.toThrow(/Failed to fetch/);
  });

  test("busy answers are retried, then reported", async () => {
    const answers = [reply(202, { status: "pending" }), reply(409, { error: "in_progress" }), reply(200, { status: "paid" })];
    const onBusy = jest.fn();
    await expect(claimFunds({ ...base, onBusy, fetchImpl: async () => answers.shift() })).resolves.toBe("paid");
    expect(onBusy).toHaveBeenCalledTimes(2);
    await expect(claimFunds({ ...base, fetchImpl: async () => reply(429, null) })).rejects.toThrow(/busy/);
  });

  test("/status is read as { open, updatedAt } and failures mean unknown, never an exception", async () => {
    expect(await fetchFaucetStatus({ faucetUrl: "https://f.example", fetchImpl: async () => reply(200, { open: true, updatedAt: "2026-01-01T00:00:00.000Z" }) })).toEqual({ open: true, updatedAt: "2026-01-01T00:00:00.000Z", pidMode: null });
    for (const pidMode of ["allowlist", "prolific", "open"]) {
      expect((await fetchFaucetStatus({ faucetUrl: "https://f.example", fetchImpl: async () => reply(200, { open: true, updatedAt: null, pidMode }) })).pidMode).toBe(pidMode);
    }
    expect((await fetchFaucetStatus({ faucetUrl: "https://f.example", fetchImpl: async () => reply(200, { open: true, pidMode: "weird" }) })).pidMode).toBeNull();
    expect((await fetchFaucetStatus({ faucetUrl: "https://f.example", fetchImpl: async () => { throw new Error("offline"); } })).open).toBeNull();
    expect((await fetchFaucetStatus({ faucetUrl: "https://f.example", fetchImpl: async () => reply(500, {}) })).open).toBeNull();
  });

  test("admin state: sends { open, password }; 401 and 429 have friendly messages", async () => {
    const fetchImpl = jest.fn(async () => reply(200, { open: true, updatedAt: null }));
    await expect(setFaucetState({ faucetUrl: "https://f.example", open: true, password: "pw", fetchImpl })).resolves.toEqual({ open: true, updatedAt: null });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://f.example/admin/state");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ open: true, password: "pw" });
    await expect(setFaucetState({ faucetUrl: "https://f.example", open: true, password: "x", fetchImpl: async () => reply(401, { error: "unauthorized" }) })).rejects.toThrow("Wrong password.");
    await expect(setFaucetState({ faucetUrl: "https://f.example", open: true, password: "x", fetchImpl: async () => reply(429, {}) })).rejects.toThrow(/Too many attempts/);
    await expect(setFaucetState({ faucetUrl: "https://f.example", open: true, password: "x", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } })).rejects.toThrow(NETWORK_MESSAGE);
  });
});

describe("faucet admin status and payout limit", () => {
  const { fetchFaucetAdminStatus, setFaucetMaxPayouts } = require("./faucetClient.mjs");
  const respond = (status, body) => jest.fn(async () => ({ status, ok: status < 300, json: async () => body }));

  test("status sends the password in a header, never in the URL", async () => {
    const fetchImpl = respond(200, { open: true, payoutsUsed: 1, maxPayouts: 5, faucetAddress: "0xabc", payoutAmount: "1" });
    const result = await fetchFaucetAdminStatus({ faucetUrl: "https://f.example/", password: "secret pw", fetchImpl });
    expect(result.maxPayouts).toBe(5);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://f.example/admin/status");
    expect(url).not.toContain("secret");
    expect(init).toMatchObject({ method: "GET", headers: { "x-admin-password": "secret pw" } });
  });

  test("status maps 401, 429, network and other failures to friendly errors", async () => {
    await expect(fetchFaucetAdminStatus({ faucetUrl: "https://f.example", password: "x", fetchImpl: respond(401, {}) })).rejects.toThrow("Wrong password.");
    await expect(fetchFaucetAdminStatus({ faucetUrl: "https://f.example", password: "x", fetchImpl: respond(429, {}) })).rejects.toThrow(/Too many attempts/);
    await expect(fetchFaucetAdminStatus({ faucetUrl: "https://f.example", password: "x", fetchImpl: respond(500, {}) })).rejects.toThrow(/could not be read/);
    await expect(fetchFaucetAdminStatus({ faucetUrl: "https://f.example", password: "x", fetchImpl: jest.fn(async () => { throw new TypeError("Failed to fetch"); }) })).rejects.toThrow(/Could not reach/);
  });

  test("setting the limit posts { value, password } and maps the server's refusals", async () => {
    const ok = respond(200, { payoutsUsed: 3, maxPayouts: 60 });
    expect(await setFaucetMaxPayouts({ faucetUrl: "https://f.example", value: 60, password: "pw", fetchImpl: ok })).toEqual({ payoutsUsed: 3, maxPayouts: 60 });
    expect(ok.mock.calls[0][0]).toBe("https://f.example/admin/max-payouts");
    expect(JSON.parse(ok.mock.calls[0][1].body)).toEqual({ value: 60, password: "pw" });
    await expect(setFaucetMaxPayouts({ faucetUrl: "https://f.example", value: 1, password: "pw", fetchImpl: respond(400, { error: "below_used" }) })).rejects.toThrow(/cannot be lower/);
    await expect(setFaucetMaxPayouts({ faucetUrl: "https://f.example", value: 1, password: "pw", fetchImpl: respond(400, { error: "not_applicable" }) })).rejects.toThrow(/no payout limit/);
    await expect(setFaucetMaxPayouts({ faucetUrl: "https://f.example", value: 5000, password: "pw", fetchImpl: respond(400, { error: "bad_request" }) })).rejects.toThrow(/up to 1000/);
    await expect(setFaucetMaxPayouts({ faucetUrl: "https://f.example", value: 5, password: "bad", fetchImpl: respond(401, {}) })).rejects.toThrow("Wrong password.");
  });
});
