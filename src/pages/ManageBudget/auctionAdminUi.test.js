import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AuctionRecordDialog from "./AuctionRecordDialog";
import CancelAuctionDialog, { cancelDialogText } from "./CancelAuctionDialog";
import { mapAuctionAdminRow, pageAuctionRows, formatCountdown } from "./adminCardData";

jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn(), readOnlyExecute: jest.fn() }));
jest.mock("../../real_ethereum/marketConfig", () => ({ getActiveFactoryAddress: () => "0x00000000000000000000000000000000000000f0", subscribeToMarketChanges: () => () => {} }));
jest.mock("../../real_ethereum/adminChain", () => ({ readHiddenSet: jest.fn(async () => new Set()), readCancelledSet: jest.fn(async () => new Set()) }));
jest.mock("../../real_ethereum/walletAccess", () => ({ requireWalletAccess: jest.fn() }));
jest.mock("../../real_ethereum/factory", () => ({ __esModule: true, default: { methods: {} } }));
jest.mock("../../real_ethereum/campaign", () => ({ __esModule: true, default: () => ({ methods: {} }) }));

const A = "0x00000000000000000000000000000000000000c1";
const SELLER = "0x4444444444444444444444444444444444444444";
const ZERO = "0x0000000000000000000000000000000000000000";
const future = Math.floor(Date.now() / 1000) + 600;
const row = (overrides = {}) => mapAuctionAdminRow({ address: A, summary: ["10", 0, 0, SELLER, "0", "Dataset A", ZERO, future, false], ...overrides });
const history = (extra = {}) => ({
  bids: [{ id: "b1", bidder: "0xbidder", amount: "12", cumulative: "12", budgetBefore: "100", budgetAfter: "88", timeSec: 1700000000, blockNumber: 5 }],
  ledger: [{ id: "l1", type: "BudgetChanged", who: "0xbidder", detail: "ledger detail", blockNumber: 5 }],
  audit: [{ id: "a1", type: "MinimumChanged", actor: "0xadmin", detail: "audit detail", blockNumber: 4 }],
  originalMinimum: "5", healthNote: "", fromBlock: 1, latest: 9, lookback: 9, ...extra,
});

describe("pageAuctionRows / formatCountdown", () => {
  const rows = Array.from({ length: 75 }, (_, i) => ({ address: `0x${String(i).padStart(40, "0")}`, description: i === 60 ? "Special cohort" : `Auction ${i}` }));
  test("pages newest-first rows 30 at a time and reports whether there is more", () => {
    expect(pageAuctionRows({ rows }).rows).toHaveLength(30);
    expect(pageAuctionRows({ rows, visible: 60 }).hasMore).toBe(true);
    expect(pageAuctionRows({ rows, visible: 90 }).hasMore).toBe(false);
  });
  test("search matches description and address across all rows, not only the first page", () => {
    expect(pageAuctionRows({ rows, query: "special" }).rows.map((r) => r.description)).toEqual(["Special cohort"]);
    expect(pageAuctionRows({ rows, query: rows[70].address.slice(0, 20) + rows[70].address.slice(20) }).rows[0].address).toBe(rows[70].address);
  });
  test("countdown text", () => {
    expect(formatCountdown(100, 100)).toBe("ended");
    expect(formatCountdown(3661, 0)).toBe("01:01:01");
    expect(formatCountdown(90000, 0)).toBe("1d 01:00:00");
  });
});

describe("CancelAuctionDialog", () => {
  test("explains the effect, takes an optional note and cancels through the admin action", async () => {
    const actions = { cancelAuction: jest.fn().mockResolvedValue({}) };
    const onClose = jest.fn();
    render(<CancelAuctionDialog auction={{ address: A, description: "Dataset A" }} actions={actions} onClose={onClose} />);
    expect(screen.getByText("Cancel auction?")).toBeInTheDocument();
    expect(screen.getByText(cancelDialogText("Dataset A"))).toBeInTheDocument();
    expect(cancelDialogText("x")).not.toMatch(/hidden from non-admin/i);
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "dup" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel auction" }));
    await waitFor(() => expect(actions.cancelAuction).toHaveBeenCalledWith(A, "dup"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
  test("a note over 500 bytes disables the confirm button", () => {
    render(<CancelAuctionDialog auction={{ address: A, description: "d" }} actions={{ cancelAuction: jest.fn() }} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "é".repeat(300) } });
    expect(screen.getByRole("button", { name: "Cancel auction" })).toBeDisabled();
  });
});

describe("AuctionRecordDialog", () => {
  const renderDialog = (props = {}) =>
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuctionRecordDialog address={A} canWrite actions={{ setMinimum: jest.fn().mockResolvedValue({}) }} loadRow={async () => row()} loadHistory={async () => history()} onClose={() => {}} {...props} />
      </MemoryRouter>
    );

  test("Record tab shows seller, description, original and adjusted minimum, and never a payload field", async () => {
    renderDialog();
    expect(await screen.findByLabelText("Seller address")).toHaveValue(SELLER);
    expect(screen.getByLabelText("Description")).toHaveValue("Dataset A");
    await waitFor(() => expect(screen.getByLabelText("Original minimum bid")).toHaveValue("5"));
    expect(screen.getByLabelText("Adjusted minimum bid")).toHaveValue("10");
    expect(screen.getByLabelText("Closing time")).toBeInTheDocument();
    expect(screen.queryByLabelText(/payload/i)).toBeNull();
  });

  test("the minimum is editable only for an admin on an auction without bids, and saves through setMinimum", async () => {
    const actions = { setMinimum: jest.fn().mockResolvedValue({}) };
    renderDialog({ actions });
    const field = await screen.findByLabelText("Adjusted minimum bid");
    expect(field).not.toBeDisabled();
    fireEvent.change(field, { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(actions.setMinimum).toHaveBeenCalledWith(A, "42"));
  });

  test("read-only for a non-admin or when bidding started", async () => {
    renderDialog({ canWrite: false });
    expect(await screen.findByLabelText("Adjusted minimum bid")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  test("Bids, Ledger and Audit tabs list the event rows, with an incomplete-history note", async () => {
    renderDialog({ loadHistory: async () => history({ healthNote: "2 of 9 ranges failed" }) });
    fireEvent.click(await screen.findByRole("tab", { name: /Bids \(1\)/ }));
    expect(await screen.findByText("0xbidder")).toBeInTheDocument();
    expect(screen.getByTestId("history-incomplete")).toHaveTextContent("2 of 9 ranges failed");
    fireEvent.click(screen.getByRole("tab", { name: "Ledger" }));
    expect(screen.getByText("ledger detail")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Audit history" }));
    expect(screen.getByText("audit detail")).toBeInTheDocument();
  });
});
