import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import WalletModePanel from "./WalletModePanel";
import { setModeProvider } from "./modeProvider";

jest.mock("./modeProvider", () => ({ setModeProvider: jest.fn() }));
jest.mock("../sapphireNetworks", () => ({ getTargetNetwork: () => ({}) }));
jest.mock("../confidentialData", () => ({ clearConfidentialSessions: jest.fn() }));
// CRA sets resetMocks, so the fakes are plain functions and only the spies are jest.fn.
const mockState = {};
jest.mock("./localWallet.mjs", () => ({
  createIndexedDbStorage: () => ({}),
  createLocalWallet: () => mockState.wallet,
  createLocalProvider: () => mockState.provider,
}));

const originalMode = process.env.REACT_APP_WALLET_MODE;
beforeEach(() => {
  process.env.REACT_APP_WALLET_MODE = "local";
  mockState.unsubscribe = jest.fn();
  mockState.provider = { request: async () => [] };
  mockState.wallet = {
    address: "", exists: async () => false, isUnlocked: async () => false,
    subscribe: () => mockState.unsubscribe, lock() {}, async create() {},
  };
});
afterEach(() => { process.env.REACT_APP_WALLET_MODE = originalMode; });
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }); };

test("re-renders do not re-register the provider or clear it", async () => {
  const view = render(<WalletModePanel />);
  await flush();
  expect(setModeProvider).toHaveBeenCalledTimes(1);
  expect(setModeProvider.mock.calls[0][0]).toBe(mockState.provider);

  const input = screen.getByPlaceholderText(/Passphrase/);
  for (const value of ["a", "ab", "abc"]) fireEvent.change(input, { target: { value } }); // state updates re-render
  view.rerender(<WalletModePanel />);
  await flush();

  expect(setModeProvider).toHaveBeenCalledTimes(1);
  expect(setModeProvider).not.toHaveBeenCalledWith(null);
  expect(setModeProvider).not.toHaveBeenCalledWith(null, expect.anything());
});

test("effect cleanup only unsubscribes; it never nulls the mode provider", async () => {
  const view = render(<WalletModePanel />);
  await flush();
  view.unmount();
  expect(mockState.unsubscribe).toHaveBeenCalled();
  expect(setModeProvider.mock.calls.filter(([provider]) => provider === null)).toHaveLength(0);
});
