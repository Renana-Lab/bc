import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import NewAuctionPage from "./NewAuctionPage";
import factory from "../../real_ethereum/factory";
import { PAYLOAD_MAX_BYTES, utf8ByteLength } from "./auctionLimits";

let mockIsAdmin = false;
const mockSend = jest.fn();
const mockCreate = jest.fn();
jest.mock("../../components/Layout", () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock("../ManageBudget/useAdminAccess", () => ({ useAdminAccess: () => ({ isAdmin: mockIsAdmin }) }));
jest.mock("../../real_ethereum/factory", () => ({ __esModule: true, default: { methods: { createCampaign: (...args) => mockCreate(...args) } } }));
jest.mock("../../real_ethereum/web3", () => ({ __esModule: true, default: { eth: { getAccounts: async () => ["0xme"] } } }));
jest.mock("../../real_ethereum/ethereumProvider", () => ({
  requestEthereumAccounts: async () => ["0x00000000000000000000000000000000000000aa"],
  waitForEthereumProvider: async () => ({}),
}));
jest.mock("../../real_ethereum/activeAuctionRegistry", () => ({
  registerCreatedAuctionReceipt: jest.fn(),
  getCreatedAuctionAddress: (receipt = {}) => receipt.events?.AuctionCreated?.returnValues?.auction || "",
}));
jest.mock("../../real_ethereum/marketConfig", () => ({
  getActiveMarket: () => ({ address: "0xfactory00000000000000000000000000000001", label: "Test market" }),
  getMarketOptions: () => [],
  subscribeToMarketChanges: () => () => {},
}));
jest.mock("react-hot-toast", () => ({ __esModule: true, default: Object.assign(() => {}, { loading: () => "t", success: () => {}, error: () => {} }) }));

const NEW = "0x00000000000000000000000000000000000000d1";
const receipt = { events: { AuctionCreated: { returnValues: { auction: NEW } } } };
const renderPage = () => render(
  <MemoryRouter initialEntries={["/open-auction"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Routes>
      <Route path="/open-auction" element={<NewAuctionPage />} />
      <Route path="/auction/:address" element={<h1>Created auction page</h1>} />
      <Route path="/auctions-list" element={<h1>List page</h1>} />
    </Routes>
  </MemoryRouter>,
);
const field = (name) => screen.getAllByLabelText(name).find((el) => el.tagName === "INPUT");
const type = (name, value) => fireEvent.change(field(name), { target: { value } });
const fillValid = () => {
  type("Description of the Data", "my shoe size");
  type("Data for sale", "42");
  type("Minimum Bid", "100");
};
const submit = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create auction" })); }); };

beforeEach(() => { mockIsAdmin = false; mockCreate.mockReset().mockImplementation(() => ({ send: mockSend })); mockSend.mockReset().mockResolvedValue(receipt); });

test("fields are in marketplace order, labelled, and duration defaults to 10", async () => {
  renderPage();
  const order = ["Description of the Data", "Data for sale", "Minimum Bid", "Auction Duration (1–30 minutes)"];
  const inputs = order.map((label) => field(label));
  for (let i = 1; i < inputs.length; i += 1) {
    expect(inputs[i - 1].compareDocumentPosition(inputs[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  inputs.forEach((input) => expect(input.required).toBe(true));
  expect(field("Auction Duration (1–30 minutes)").value).toBe("10");
  expect(screen.getByRole("button", { name: "Create auction" }).textContent).toBe("CREATE AUCTION");
  expect(screen.getByRole("button", { name: "RETURN TO AUCTIONS MAIN SCREEN" })).toBeTruthy();
  expect(screen.getByText(`0 / ${PAYLOAD_MAX_BYTES} bytes`)).toBeTruthy();
});

test.each([
  ["Description of the Data", "Description of the Data"],
  ["Data For Sell", "Data For Sell"],
  ["Minimum Bid", "Minimum Bid"],
  ["Auction Duration (1–30 minutes)", "Auction Duration (1–30 minutes)"],
])("the ? help for %s toggles its text", (label) => {
  renderPage();
  const help = screen.getByRole("button", { name: `Info about ${label}` });
  expect(help.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(help);
  expect(help.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(help);
  expect(help.getAttribute("aria-expanded")).toBe("false");
});

test("the minimum bid help mentions wei and no longer promises price changes", () => {
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Info about Minimum Bid" }));
  expect(screen.getByText(/\(in wei\)/)).toBeTruthy();
  expect(screen.queryByText(/change this price/)).toBeNull();
});

test.each([
  ["a number-only description", "Description of the Data", "12345", "The data description must include words, not only numbers"],
  ["a description over 300 chars", "Description of the Data", "a".repeat(301), /at most 300 characters/],
  ["a payload over the byte limit", "Data for sale", "x".repeat(PAYLOAD_MAX_BYTES + 1), new RegExp(`at most ${PAYLOAD_MAX_BYTES} bytes`)],
  ["1001 Hebrew letters (2002 bytes, under 2000 characters)", "Data for sale", "א".repeat(1001), new RegExp(`at most ${PAYLOAD_MAX_BYTES} bytes`)],
  ["a minimum of 0", "Minimum Bid", "0", /from 1 to 1,000,000,000/],
  ["a minimum above 1,000,000,000", "Minimum Bid", "1000000001", /from 1 to 1,000,000,000/],
  ["a duration of 0", "Auction Duration (1–30 minutes)", "0", /from 1 to 30/],
  ["a duration of 31", "Auction Duration (1–30 minutes)", "31", /from 1 to 30/],
])("%s is rejected inline and nothing is sent", async (_name, label, value, message) => {
  renderPage();
  fillValid();
  type(label, value);
  await submit();
  expect(screen.getByText(message)).toBeTruthy();
  expect(mockCreate).not.toHaveBeenCalled();
});

test("a Hebrew description with letters is accepted", async () => {
  renderPage();
  fillValid();
  type("Description of the Data", "מידה של נעליים");
  await submit();
  expect(mockCreate).toHaveBeenCalledTimes(1);
});

test("the description is trimmed and the contract receives the same arguments in the same order", async () => {
  renderPage();
  type("Description of the Data", "  my shoe size  ");
  type("Data for sale", "42");
  type("Minimum Bid", "100");
  type("Auction Duration (1–30 minutes)", "15");
  await submit();
  expect(mockCreate).toHaveBeenCalledWith("100", "42", "my shoe size", "15");
  expect(mockSend).toHaveBeenCalledWith({ from: "0x00000000000000000000000000000000000000aa" });
  expect(factory.methods.createCampaign).toBeDefined();
});

test("after success it opens the created auction from the receipt", async () => {
  renderPage();
  fillValid();
  await submit();
  await waitFor(() => expect(screen.getByText("Created auction page")).toBeTruthy());
});

test("without an address in the receipt it falls back to the auctions list", async () => {
  mockSend.mockResolvedValue({ events: {} });
  renderPage();
  fillValid();
  await submit();
  await waitFor(() => expect(screen.getByText("List page")).toBeTruthy());
});

test("the factory address panel is for admins only", () => {
  const view = renderPage();
  expect(screen.queryByText("Auction destination")).toBeNull();
  expect(view.container.textContent).not.toMatch(/0xfactory/);
  view.unmount();
  mockIsAdmin = true;
  renderPage();
  expect(screen.getByText("Auction destination")).toBeTruthy();
  expect(screen.getByText(/0xfactory/)).toBeTruthy();
});

test("PAYLOAD_MAX_BYTES defaults to 2000 and the counter shows UTF-8 bytes", () => {
  expect(PAYLOAD_MAX_BYTES).toBe(2000);
  expect(utf8ByteLength("abc")).toBe(3);
  expect(utf8ByteLength("שלום")).toBe(8);
  renderPage();
  type("Data for sale", "שלום");
  expect(screen.getByText("8 / 2000 bytes")).toBeTruthy();
});

test("exactly 1000 Hebrew letters (2000 bytes) is accepted", async () => {
  renderPage();
  fillValid();
  type("Data for sale", "א".repeat(1000));
  await submit();
  expect(mockCreate).toHaveBeenCalledTimes(1);
});
