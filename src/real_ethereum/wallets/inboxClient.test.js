/** @jest-environment node */
import { Wallet, verifyMessage } from "ethers";
import { ackInbox, fetchAdminMessages, fetchInbox, sendAdminMessage } from "./inboxClient.mjs";
import { sweepMessage } from "./autoSweep.mjs";

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const wallet = new Wallet(`0x${"1".repeat(64)}`);
const PID = "ab".repeat(32);
const signMessage = (message) => wallet.signMessage(message);

test("the inbox request is signed with the heartbeat scheme (action inbox), carries no secret header and returns clean messages", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, init]); return reply(200, { messages: [{ id: "m1", body: "hi", createdAt: 5 }, { id: 7, body: "bad" }, null], serverTime: 1234 }); };
  const result = await fetchInbox({ faucetUrl: "https://f.example/", address: wallet.address, pidHash: PID, signMessage, now: () => 1_700_000_000_000, fetchImpl });
  expect(result).toEqual({ ok: true, messages: [{ id: "m1", body: "hi", createdAt: 5 }], serverTime: 1234 });
  const [url, init] = calls[0];
  expect(init).toEqual({ method: "GET" });
  const query = new URL(url).searchParams;
  expect(url.startsWith("https://f.example/inbox?")).toBe(true);
  expect(query.get("pidHash")).toBe(PID);
  expect(query.get("address")).toBe(wallet.address);
  expect(query.get("ts")).toBe("1700000000000");
  expect(verifyMessage(sweepMessage("inbox", wallet.address, PID, 1_700_000_000_000), query.get("sig"))).toBe(wallet.address);
});

test("ack posts the ids with an ack signature; failures never throw", async () => {
  const calls = [];
  const ok = await ackInbox({ faucetUrl: "https://f.example", address: wallet.address, pidHash: PID, ids: ["m1"], signMessage, now: () => 42, fetchImpl: async (url, init) => { calls.push([url, init]); return reply(200, { acked: 1 }); } });
  expect(ok).toBe(true);
  const body = JSON.parse(calls[0][1].body);
  expect(calls[0][0]).toBe("https://f.example/inbox/ack");
  expect(body).toMatchObject({ pidHash: PID, address: wallet.address, ids: ["m1"], ts: 42 });
  expect(verifyMessage(sweepMessage("ack", wallet.address, PID, 42), body.sig)).toBe(wallet.address);
  expect(await ackInbox({ faucetUrl: "x", address: wallet.address, pidHash: PID, ids: ["m1"], signMessage, fetchImpl: async () => reply(403, {}) })).toBe(false);
  expect(await ackInbox({ faucetUrl: "x", address: wallet.address, pidHash: PID, ids: ["m1"], signMessage, fetchImpl: async () => { throw new Error("offline"); } })).toBe(false);
  expect(await fetchInbox({ faucetUrl: "x", address: wallet.address, pidHash: PID, signMessage, fetchImpl: async () => { throw new Error("offline"); } })).toEqual({ ok: false, messages: [], serverTime: null });
  expect((await fetchInbox({ faucetUrl: "x", address: wallet.address, pidHash: PID, signMessage, fetchImpl: async () => reply(429, {}) })).ok).toBe(false);
  expect((await fetchInbox({ faucetUrl: "x", address: wallet.address, pidHash: PID, signMessage: async () => { throw new Error("locked"); }, fetchImpl: async () => reply(200, { messages: [] }) })).ok).toBe(false);
});

test("admin calls keep the password in a header, never in the URL", async () => {
  const calls = [];
  const fetchImpl = (status, body) => async (url, init) => { calls.push([url, init]); return reply(status, body); };
  expect(await sendAdminMessage({ faucetUrl: "https://f.example", password: "pw", pidHash: PID, body: "hello", fetchImpl: fetchImpl(200, { id: "x" }) })).toEqual({ id: "x" });
  expect(calls[0][0]).toBe("https://f.example/admin/messages");
  expect(calls[0][1].headers["x-admin-password"]).toBe("pw");
  expect(JSON.parse(calls[0][1].body)).toEqual({ pidHash: PID, body: "hello" });
  await sendAdminMessage({ faucetUrl: "https://f.example", password: "pw", all: true, body: "everyone", fetchImpl: fetchImpl(200, { id: "y" }) });
  expect(JSON.parse(calls[1][1].body)).toEqual({ all: true, body: "everyone" });
  await expect(sendAdminMessage({ faucetUrl: "x", password: "bad", all: true, body: "z", fetchImpl: fetchImpl(401, {}) })).rejects.toMatchObject({ code: "unauthorized", message: "Wrong password." });
  await expect(sendAdminMessage({ faucetUrl: "x", password: "pw", pidHash: PID, body: "z", fetchImpl: fetchImpl(404, {}) })).rejects.toMatchObject({ code: "failed" });

  const history = { broadcasts: [], participants: [] };
  expect(await fetchAdminMessages({ faucetUrl: "https://f.example", password: "pw", pidHash: PID, fetchImpl: fetchImpl(200, history) })).toEqual(history);
  expect(calls.at(-1)[0]).toBe(`https://f.example/admin/messages?pidHash=${PID}`);
  expect(calls.at(-1)[0]).not.toContain("pw");
  await fetchAdminMessages({ faucetUrl: "https://f.example", password: "pw", fetchImpl: fetchImpl(200, history) });
  expect(calls.at(-1)[0]).toBe("https://f.example/admin/messages");
  await expect(fetchAdminMessages({ faucetUrl: "x", password: "pw", fetchImpl: fetchImpl(500, {}) })).rejects.toMatchObject({ code: "failed" });
});
