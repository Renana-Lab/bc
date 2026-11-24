import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SellerBotsCardBody, isLowBalance, presenceLabel, utf8Length } from "./SellerBotsCard";
import { clearSessionPassword } from "./faucetSessionPassword";
import { SELLER_BOTS_KEY } from "../../botnet/sellerBotList";

const mockAccess = { account: "" };
jest.mock("../../real_ethereum/walletAccess", () => ({
  getWalletAccess: () => ({ status: mockAccess.account ? "connected" : "unavailable", account: mockAccess.account }),
  subscribeWalletAccess: () => () => {},
}));

const BOT = `0x${"a".repeat(40)}`;
const serverState = (over = {}) => ({
  version: 3,
  config: {
    enabled: false, presenceMode: "sweep", minActiveParticipants: 1, activeWindowMinutes: 5, idleGraceMinutes: 5, allowBuyerBotsOnSellerAuctions: false, nextSlot: 2,
    bots: [{
      id: "bot-1", running: true, maxConcurrentOpen: 1, spacingSeconds: 60, minNativeBalance: 0.5, address: BOT, balanceWei: (3n * 10n ** 18n).toString(), openAuctions: 1, lastError: null,
      items: [{ slot: 1, description: "a public description", payloadBytes: 40, minimumBid: 5, durationMinutes: 2, quantity: 4, seqBase: 0, created: 2 }],
    }],
    ...(over.config || {}),
  },
  presence: { state: "active", count: 3, mode: "sweep" }, lastRunAt: "2026-01-01T10:00:00.000Z", botAddresses: [BOT], fundingEnabled: false,
  ...over,
});
const makeDeps = (state = serverState()) => ({
  fetchSellerBots: jest.fn(async () => state),
  saveSellerBots: jest.fn(async () => ({ version: state.version + 1 })),
  stopAllSellerBots: jest.fn(async () => ({ enabled: false })),
});
const render_ = (deps, props = {}) => render(<SellerBotsCardBody faucetUrl="https://faucet.example" deps={deps} refreshMs={10_000_000} {...props} />);
const loadWithPassword = async () => {
  fireEvent.change(screen.getByLabelText("Seller bots admin password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: "Load seller bots" }));
  await screen.findByTestId("presence-chip");
  await waitFor(() => expect(screen.getByRole("button", { name: "Reload" }).disabled).toBe(false)); // the request has finished
};

beforeEach(() => { mockAccess.account = ""; window.localStorage.clear(); clearSessionPassword(); jest.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => jest.restoreAllMocks());

describe("helpers", () => {
  test("byte counter counts UTF-8 bytes, not characters", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
  });
  test("presence chip labels and the low-balance rule", () => {
    expect(presenceLabel({ state: "active", count: 3 })).toBe("Active 3");
    expect(presenceLabel({ state: "idle", count: 0 })).toBe("Idle");
    expect(presenceLabel({ state: "unknown", count: null })).toBe("Unknown");
    expect(presenceLabel(null)).toBe("Unknown");
    expect(isLowBalance({ balanceWei: (4n * 10n ** 17n).toString(), minNativeBalance: 0.5 })).toBe(true);
    expect(isLowBalance({ balanceWei: (6n * 10n ** 17n).toString(), minNativeBalance: 0.5 })).toBe(false);
    expect(isLowBalance({ balanceWei: null, minNativeBalance: 0.5 })).toBe(false);
  });
});

describe("states", () => {
  test("loads with the password, shows presence, balance, progress and the open count", async () => {
    const deps = makeDeps();
    render_(deps);
    await loadWithPassword();
    expect(deps.fetchSellerBots).toHaveBeenCalledWith(expect.objectContaining({ faucetUrl: "https://faucet.example", password: "pw" }));
    expect(screen.getByTestId("presence-chip").textContent).toBe("Active 3");
    expect(screen.getByTestId("balance-bot-1").textContent).toMatch(/3\.0000 TEST/);
    expect(screen.queryByTestId("low-balance-bot-1")).toBeNull();
    expect(screen.getByTestId("progress-bot-1-0").textContent).toBe("2 / 4 created");
    expect(screen.getByText(/Open auctions: 1/)).toBeTruthy();
  });

  test("the card caches the seller-bot addresses for the buyer-bot runtime", async () => {
    render_(makeDeps());
    await loadWithPassword();
    expect(JSON.parse(window.localStorage.getItem(SELLER_BOTS_KEY))).toMatchObject({ addresses: [BOT], allow: false });
  });

  test("404 shows 'Seller bots are not deployed yet'", async () => {
    const deps = makeDeps();
    deps.fetchSellerBots.mockRejectedValue(Object.assign(new Error("Seller bots are not deployed yet."), { code: "not_deployed" }));
    render_(deps);
    fireEvent.change(screen.getByLabelText("Seller bots admin password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Load seller bots" }));
    expect((await screen.findByTestId("seller-not-deployed")).textContent).toBe("Seller bots are not deployed yet.");
    expect(screen.queryByTestId("presence-chip")).toBeNull();
  });

  test("idle, unknown, low balance and a paused bot's last error", async () => {
    const state = serverState({ presence: { state: "unknown", count: null } });
    state.config.bots[0].balanceWei = (10n ** 17n).toString();
    state.config.bots[0].running = false;
    state.config.bots[0].lastError = "rpc";
    render_(makeDeps(state));
    await loadWithPassword();
    expect(screen.getByTestId("presence-chip").textContent).toBe("Unknown");
    expect(screen.getByTestId("low-balance-bot-1")).toBeTruthy();
    expect(screen.getByTestId("last-error-bot-1").textContent).toMatch(/Last error: rpc \(paused\)/);
  });

  test("a wrong password shows the server message", async () => {
    const deps = makeDeps();
    deps.fetchSellerBots.mockRejectedValue(Object.assign(new Error("Wrong password."), { code: "unauthorized" }));
    render_(deps);
    fireEvent.change(screen.getByLabelText("Seller bots admin password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Load seller bots" }));
    expect((await screen.findByTestId("seller-message")).textContent).toBe("Wrong password.");
  });
});

describe("editing", () => {
  test("byte counters, write-only payload ('leave empty to keep') and what is saved", async () => {
    const deps = makeDeps();
    render_(deps);
    await loadWithPassword();
    expect(screen.getByTestId("payload-bytes-bot-1-0").textContent).toMatch(/Stored: 40 bytes\. Leave empty to keep/);
    expect(screen.queryByDisplayValue(/secret/)).toBeNull();
    expect(screen.getByTestId("desc-bytes-bot-1-0").textContent).toBe("20 / 1200 bytes");
    fireEvent.change(screen.getByLabelText("Description bot-1 1"), { target: { value: "é".repeat(10) } });
    expect(screen.getByTestId("desc-bytes-bot-1-0").textContent).toBe("20 / 1200 bytes");
    fireEvent.change(screen.getByLabelText("Payload bot-1 1"), { target: { value: "€€€" } });
    expect(screen.getByTestId("payload-bytes-bot-1-0").textContent).toBe("9 / 2000 bytes");
    fireEvent.change(screen.getByLabelText("Payload bot-1 1"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(deps.saveSellerBots).toHaveBeenCalled());
    const call = deps.saveSellerBots.mock.calls[0][0];
    expect(call.version).toBe(3);
    expect(call.config.bots[0].items[0]).toEqual({ slot: 1, description: "é".repeat(10), payload: "", minimumBid: 5, durationMinutes: 2, quantity: 6 });
    expect(call.config.bots[0]).not.toHaveProperty("address");
    expect(call.config.bots[0]).not.toHaveProperty("balanceWei");
  });

  test("a bot's running switch, the global switch and a new item are saved", async () => {
    const deps = makeDeps();
    render_(deps);
    await loadWithPassword();
    fireEvent.click(screen.getByLabelText("Seller bots enabled"));
    fireEvent.click(screen.getByLabelText("bot-1 running"));
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByLabelText("Description bot-1 2"), { target: { value: "second" } });
    fireEvent.change(screen.getByLabelText("Payload bot-1 2"), { target: { value: "data" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(deps.saveSellerBots).toHaveBeenCalled());
    const { config } = deps.saveSellerBots.mock.calls[0][0];
    expect(config.enabled).toBe(true);
    expect(config.bots[0].running).toBe(false);
    expect(config.bots[0].items[1]).toMatchObject({ description: "second", payload: "data" });
    expect(config.bots[0].items[1]).not.toHaveProperty("slot");
  });

  test("Stop all asks for confirmation and calls the kill switch", async () => {
    const deps = makeDeps();
    render_(deps);
    await loadWithPassword();
    fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
    await waitFor(() => expect(deps.stopAllSellerBots).toHaveBeenCalled());
    expect(window.confirm).toHaveBeenCalled();
    expect((await screen.findByTestId("seller-message")).textContent).toBe("Seller bots are stopped.");
  });

  test("a version conflict is shown and the edit is kept", async () => {
    const deps = makeDeps();
    deps.saveSellerBots.mockRejectedValue(Object.assign(new Error("The configuration changed elsewhere. Reload and apply your edit again."), { code: "version_conflict" }));
    render_(deps);
    await loadWithPassword();
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByTestId("seller-message")).textContent).toMatch(/changed elsewhere/);
    expect(screen.getByLabelText("Quantity").value).toBe("9");
  });

  test("the buyer-bot permission is a checkbox that is saved and cached", async () => {
    const deps = makeDeps();
    render_(deps);
    await loadWithPassword();
    fireEvent.click(screen.getByLabelText("Allow buyer bots on seller auctions"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(deps.saveSellerBots).toHaveBeenCalled());
    expect(deps.saveSellerBots.mock.calls[0][0].config.allowBuyerBotsOnSellerAuctions).toBe(true);
  });
});
