import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ContributeForm, { minimumAcceptedBid, bidRangeMessage } from "./ContributeForm";
import { readOnlyCall } from "../real_ethereum/readOnly";
import { getEthereumAccounts } from "../real_ethereum/ethereumProvider";

const mockSend = jest.fn();
jest.mock("../real_ethereum/campaign", () => () => ({ methods: { contribute: () => ({ send: (...a) => mockSend(...a) }) } }));
jest.mock("../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn(), readOnlyExecute: jest.fn(async () => { throw new Error("offline"); }) }));
jest.mock("../real_ethereum/ethereumProvider", () => ({ getEthereumAccounts: jest.fn() }));

const me = "0x00000000000000000000000000000000000000bb";
const seller = "0x00000000000000000000000000000000000000aa";
const endTime = () => Math.floor(Date.now() / 1000) + 600;
// getListSummary: [minimum, _, approvers, manager, highestBid, desc, highestBidder, endTime, closed]
const mockSummary = (minimum, highest, leader = seller) => readOnlyCall.mockImplementation(async () => [String(minimum), "0", "1", seller, String(highest), "d", leader, String(endTime()), false]);
const setup = (props = {}) => render(
  <ContributeForm address="0xabc" endTime={endTime()} minimumContribution="10" highestBid="50" userBid={0} remainingBudget="200" {...props} />,
);
const bid = async (value) => {
  fireEvent.change(screen.getByLabelText("Total Bid"), { target: { value } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit your bid" })); });
  for (let i = 0; i < 20; i += 1) await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockSend.mockReset().mockResolvedValue({ events: {} });
  getEthereumAccounts.mockResolvedValue([me]);
  mockSummary(10, 50);
});
afterEach(() => jest.useRealTimers());

test("the minimum accepted bid is max(minimum, highest + 1, myBid + 1)", () => {
  expect(minimumAcceptedBid(10, 50, 0)).toBe(51n);
  expect(minimumAcceptedBid(100, 50, 0)).toBe(100n);
  expect(minimumAcceptedBid(10, 5, 70)).toBe(71n);
});

test("the input min/max/step follow the marketplace rules for a non-leader", () => {
  setup();
  const input = screen.getByLabelText("Total Bid");
  expect(input.min).toBe("51");
  expect(input.max).toBe("200");
  expect(input.step).toBe("1");
});

test("a leader may raise up to myBid + budget, capped at 1,000,000,000", () => {
  const first = setup({ isLeader: true, userBid: 60, highestBid: "60", remainingBudget: "200" });
  expect(screen.getByLabelText("Total Bid").max).toBe("260");
  first.unmount();
  setup({ isLeader: true, userBid: 60, remainingBudget: "5000000000" });
  expect(screen.getByLabelText("Total Bid").max).toBe("1000000000");
});

test("the ? tooltip states the minimum accepted and how reservation works", async () => {
  setup();
  const help = screen.getByRole("button", { name: "How total bids work" });
  await act(async () => { fireEvent.mouseOver(help); });
  const tip = await screen.findByText(/Minimum accepted now: 51/);
  expect(tip.textContent).toMatch(/only the increase is reserved/);
});

test("a too-low or unaffordable bid shows the marketplace message and sends nothing", async () => {
  setup();
  await bid("40");
  expect(screen.getByRole("alert").textContent).toBe(bidRangeMessage("51", "200"));
  expect(screen.getByRole("alert").textContent).toBe("Your total bid must be at least 51 and the amount reserved must fit your remaining budget (200).");
  await bid("500");
  expect(screen.getByRole("alert").textContent).toMatch(/at least 51 and the amount reserved must fit/);
  expect(mockSend).not.toHaveBeenCalled();
});

test("a valid bid shows Submitting... then an inline success, with the same contribute() value", async () => {
  let resolve;
  mockSend.mockImplementation(() => new Promise((r) => { resolve = r; }));
  setup();
  await bid("60");
  expect(screen.getByRole("button", { name: /Submitting/ })).toBeTruthy();
  expect(mockSend).toHaveBeenCalledWith({ from: me, value: "60" });
  await act(async () => { resolve({ events: {} }); });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole("status").textContent).toBe("Bid placed successfully!");
});

test("a failed transaction shows an inline error", async () => {
  mockSend.mockRejectedValue(new Error("RPC node unreachable"));
  setup();
  await bid("60");
  expect(screen.getByRole("alert").textContent).toBe("RPC node unreachable");
});

test("a non-leader returning bidder must fit the FULL new total in the budget", async () => {
  mockSummary(10, 50);
  setup({ userBid: 40, highestBid: "50", remainingBudget: "70" });
  await bid("80");
  expect(screen.getByRole("alert").textContent).toBe(
    "Your total bid must be at least 51 and the amount reserved must fit your remaining budget (70).",
  );
  expect(mockSend).not.toHaveBeenCalled();
  await bid("70");
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith({ from: me, value: "30" }); // contract still gets only the increase
});

test("a leader raising a bid only needs the increase to fit the budget", async () => {
  mockSummary(10, 60, me);
  setup({ isLeader: true, userBid: 60, highestBid: "60", remainingBudget: "20" });
  await bid("81");
  expect(screen.getByRole("alert").textContent).toBe(
    "Your total bid must be at least 61 and the increase must fit your remaining budget (20).",
  );
  expect(mockSend).not.toHaveBeenCalled();
  await bid("80");
  expect(mockSend).toHaveBeenCalledWith({ from: me, value: "20" });
});

test("the bid tooltip and errors no longer repeat 'in wei'", async () => {
  mockSummary(10, 50);
  setup();
  await act(async () => { fireEvent.mouseOver(screen.getByRole("button", { name: "How total bids work" })); });
  expect((await screen.findByText(/Minimum accepted now/)).textContent).not.toMatch(/wei/i);
  await bid("1.5");
  expect(screen.getByRole("alert").textContent).toBe("Bid amount must be a whole number");
});

test("the bid field is a required field of a real form: Enter submits it", async () => {
  mockSummary(10, 50);
  setup();
  const input = screen.getByLabelText("Total Bid");
  expect(input.required).toBe(true);
  const form = input.closest("form");
  expect(form).toBeTruthy();
  expect(screen.getByRole("button", { name: "Submit your bid" }).type).toBe("submit");
  fireEvent.change(input, { target: { value: "60" } });
  await act(async () => { fireEvent.submit(form); }); // what the browser fires when Enter is pressed in the field
  for (let i = 0; i < 20; i += 1) await act(async () => { await Promise.resolve(); });
  expect(mockSend).toHaveBeenCalledWith({ from: me, value: "60" });
});

test("native validation never replaces the existing messages (empty field)", async () => {
  mockSummary(10, 50);
  setup();
  const form = screen.getByLabelText("Total Bid").closest("form");
  expect(form.noValidate).toBe(true);
  await act(async () => { fireEvent.submit(form); });
  for (let i = 0; i < 20; i += 1) await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole("alert").textContent).toBe("Bid amount must be a whole number");
  expect(mockSend).not.toHaveBeenCalled();
});

test("the submit button has no fixed minimum width that could push it out of the card", () => {
  setup();
  const button = screen.getByRole("button", { name: "Submit your bid" });
  expect(button.style.minWidth).toBe("");
  expect(button.style.width).toBe("100%");
});
