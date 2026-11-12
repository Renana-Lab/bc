import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WalletModePanel from "./WalletModePanel";

jest.mock("./localWallet.mjs", () => ({
  createIndexedDbStorage: () => ({}),
  createLocalProvider: () => ({ request: async () => "0x0" }),
  // Fresh in-memory wallet per mount, so tests do not share state.
  createLocalWallet: () => {
    const address = `0x${"1".repeat(40)}`;
    const subscribers = new Set();
    const state = { address: "", present: false };
    const notify = () => subscribers.forEach((listener) => listener());
    return {
      get address() { return state.address; },
      exists: async () => state.present,
      isUnlocked: async () => Boolean(state.address),
      subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); },
      create: async () => { state.present = true; state.address = address; notify(); },
      unlock: async () => { state.address = address; notify(); },
      lock: () => { state.address = ""; notify(); },
      forget: async () => { state.present = false; state.address = ""; notify(); },
      exportEncryptedBackup: async () => "{}",
      importEncryptedBackup: async () => {},
    };
  },
}));
jest.mock("../confidentialData", () => ({ clearConfidentialSessions: () => {} }));

const step = (title) => screen.getByText(title).closest("li");
const create = async () => {
  fireEvent.change(await screen.findByPlaceholderText("Passphrase (12+ chars)", {}, { timeout: 5000 }), { target: { value: "a long passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await screen.findByText(/Unlocked: 0x/, {}, { timeout: 5000 });
};

beforeEach(() => {
  process.env.REACT_APP_WALLET_MODE = "local";
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  jest.spyOn(window, "confirm").mockImplementation(() => true);
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.REACT_APP_WALLET_MODE; });

test("step 2 is not marked done after Forget, and a new wallet starts un-backed-up", async () => {
  render(<WalletModePanel />);
  await create();
  expect(step("Wallet unlocked").textContent).toContain("✓");
  expect(step("Save an encrypted backup").textContent).not.toContain("✓");

  fireEvent.click(screen.getByRole("button", { name: "Download encrypted backup" }));
  await waitFor(() => expect(step("Save an encrypted backup").textContent).toContain("✓"), { timeout: 5000 });

  fireEvent.click(screen.getByRole("button", { name: "Forget" }));
  await screen.findByText("Create your wallet", {}, { timeout: 5000 });
  expect(step("Save an encrypted backup").textContent).not.toContain("✓");

  await create();
  expect(step("Save an encrypted backup").textContent).not.toContain("✓");
});

test("locking the same wallet keeps backup progress", async () => {
  render(<WalletModePanel />);
  await create();
  fireEvent.click(screen.getByRole("button", { name: "Download encrypted backup" }));
  await waitFor(() => expect(step("Save an encrypted backup").textContent).toContain("✓"), { timeout: 5000 });
  fireEvent.click(screen.getByRole("button", { name: "Lock" }));
  await screen.findByText("Unlock your wallet", {}, { timeout: 5000 });
  expect(step("Save an encrypted backup").textContent).toContain("✓");
});

describe("faucet step with a Prolific link", () => {
  const PID = "5f1a2b3c4d5e6f7a8b9c0d1e";
  const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  beforeEach(() => {
    process.env.REACT_APP_FAUCET_URL = "https://faucet.example";
    window.history.pushState({}, "", `/?PROLIFIC_PID=${PID}&STUDY_ID=study1`);
  });
  afterEach(() => { delete process.env.REACT_APP_FAUCET_URL; window.sessionStorage.clear(); });

  test("a closed faucet shows the friendly message (from /status and from a refused claim), never a raw error", async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, init) => {
      calls.push({ url, init });
      return url.endsWith("/status") ? reply(200, { open: false, updatedAt: null }) : reply(403, { error: "faucet_closed" });
    });
    render(<WalletModePanel />);
    await create();
    expect(window.location.search).toBe(""); // pid and study stripped from the address bar
    await screen.findByText("Test funds are not available right now.");
    fireEvent.click(screen.getByRole("button", { name: "Request test funds" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/claim"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/claim")).init.body)).toEqual({ pid: PID, address: `0x${"1".repeat(40)}`, studyId: "study1" });
    expect(screen.queryByRole("alert")?.textContent || "").not.toMatch(/403|faucet_closed|Failed to fetch/);
    expect(screen.getAllByText("Test funds are not available right now.").length).toBeGreaterThan(0);
  });

  test("a network failure shows a friendly message instead of Failed to fetch", async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.endsWith("/status")) return reply(200, { open: true, updatedAt: null });
      throw new TypeError("Failed to fetch");
    });
    render(<WalletModePanel />);
    await create();
    fireEvent.click(await screen.findByRole("button", { name: "Request test funds" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not reach the test-funds service/);
    expect(alert.textContent).not.toMatch(/Failed to fetch/);
  });
});
