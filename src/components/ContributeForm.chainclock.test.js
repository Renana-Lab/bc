import React from "react";
import { act, render, screen } from "@testing-library/react";
import ContributeForm from "./ContributeForm";
import { __resetChainClockForTests } from "../real_ethereum/chainClock";

jest.mock("../real_ethereum/campaign", () => () => ({}));
jest.mock("../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn(), readOnlyExecute: jest.fn(async () => { throw new Error("offline"); }) }));
jest.mock("../real_ethereum/ethereumProvider", () => ({ getEthereumAccounts: jest.fn() }));

beforeEach(() => { jest.useFakeTimers(); __resetChainClockForTests(); });
afterEach(() => { __resetChainClockForTests(); jest.useRealTimers(); });

test("the bid button is disabled inside the 2 s safety margin and shows Auction ended at 0", async () => {
  const endTime = Math.floor(Date.now() / 1000) + 10;
  render(<ContributeForm address="0xabc" endTime={endTime} remainingBudget={100} />);
  expect(screen.getByRole("button", { name: "Submit your bid" }).disabled).toBe(false);
  await act(async () => { jest.advanceTimersByTime(8500); });
  expect(screen.getByRole("button", { name: "Submit your bid" }).disabled).toBe(true);
  await act(async () => { jest.advanceTimersByTime(3000); });
  expect(screen.getByRole("button", { name: "Auction ended" }).disabled).toBe(true);
});

test("a zero budget disables bidding with No budget left", () => {
  render(<ContributeForm address="0xabc" endTime={Math.floor(Date.now() / 1000) + 600} remainingBudget={0} noBudget />);
  const button = screen.getByRole("button", { name: "No budget left" });
  expect(button.disabled).toBe(true);
});
