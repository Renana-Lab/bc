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
    expect(await fetchFaucetStatus({ faucetUrl: "https://f.example", fetchImpl: async () => reply(200, { open: true, updatedAt: "2026-01-01T00:00:00.000Z" }) })).toEqual({ open: true, updatedAt: "2026-01-01T00:00:00.000Z" });
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
