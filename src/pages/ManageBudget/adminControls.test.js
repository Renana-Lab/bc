import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  canSellerEditMinimum,
  getAdminActionAvailability,
  getAuctionAdminStatus,
  mapAuctionAdminRow,
  mapUserRows,
  normalizeAuditEvent,
} from "./adminCardData";
import { filterHiddenAuctions, auctionBadges } from "../AuctionsList/auctionAdminFlags";

jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn(), readOnlyExecute: jest.fn(), readOnlyBatchCall: jest.fn() }));
jest.mock("../../real_ethereum/socketFactory", () => ({ canUseLiveEvents: () => false, factorySocket: { events: {} } }));
jest.mock("../../real_ethereum/adminChain", () => ({
  readCancelledSet: jest.fn(async () => new Set()),
  readHiddenSet: jest.fn(async () => new Set()),
  readFactoryOwner: jest.fn(async () => "0xowner"),
  readIsFactoryAdmin: jest.fn(async () => true),
}));
jest.mock("../../real_ethereum/factory", () => ({ __esModule: true, default: {} }));
jest.mock("../../real_ethereum/campaign", () => ({ __esModule: true, default: () => ({}) }));
jest.mock("../../real_ethereum/walletAccess", () => ({
  requireWalletAccess: async () => ({ account: "0xabc" }),
  getWalletAccess: () => ({ status: "disconnected" }),
  subscribeWalletAccess: () => () => {},
}));
jest.mock("../../telemetry/presenceClient", () => ({ getLivePresence: jest.fn(), isPresenceConfigured: () => false }));

// eslint-disable-next-line import/first
import { MemoryRouter } from "react-router-dom";
// eslint-disable-next-line import/first
import { AdminOpsCards, AdminsCard, AuctionControlsCard, MarketSettingsCard, UsersBudgetsCard } from "./AdminOpsCards";
// eslint-disable-next-line import/first
import { readOnlyBatchCall, readOnlyCall } from "../../real_ethereum/readOnly";
// eslint-disable-next-line import/first
import { chainImplementations } from "./chainTestHelpers";

const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";
const A3 = "0x3333333333333333333333333333333333333333";
const SELLER = "0x4444444444444444444444444444444444444444";
const ZERO = "0x0000000000000000000000000000000000000000";
const NOW = 1_000_000;

const summary = ({ min = 10, bidder = ZERO, end = NOW + 600, closed = false } = {}) => [min, 0, 0, SELLER, 0, "desc", bidder, end, closed];

describe("pure admin row logic", () => {
  test("status and available actions mirror the contract preconditions", () => {
    const live = mapAuctionAdminRow({ address: A1, summary: summary() });
    expect(getAdminActionAvailability(live, NOW)).toMatchObject({ status: "active", editMinimum: true, closeNow: true, cancel: true });

    const bid = mapAuctionAdminRow({ address: A1, summary: summary({ bidder: A2 }) });
    expect(getAdminActionAvailability(bid, NOW)).toMatchObject({ editMinimum: false, closeNow: true });

    const ended = mapAuctionAdminRow({ address: A1, summary: summary({ end: NOW - 1 }) });
    // ended without bids counts as unsold; ended with bids waits for finalization
    expect(getAdminActionAvailability(ended, NOW)).toMatchObject({ status: "unsold", editMinimum: false, closeNow: false, cancel: true });
    const endedWithBid = mapAuctionAdminRow({ address: A1, summary: summary({ end: NOW - 1, bidder: A2 }) });
    expect(getAdminActionAvailability(endedWithBid, NOW)).toMatchObject({ status: "ended", closeNow: false, cancel: true });

    const sold = mapAuctionAdminRow({ address: A1, summary: summary({ end: NOW - 1, closed: true, bidder: A2 }) });
    expect(getAdminActionAvailability(sold, NOW)).toMatchObject({ status: "sold", cancel: true, cancelHidesOnly: true });
    const unsold = mapAuctionAdminRow({ address: A1, summary: summary({ end: NOW - 1, closed: true }) });
    expect(getAdminActionAvailability(unsold, NOW)).toMatchObject({ status: "unsold", cancelHidesOnly: true });

    const cancelled = mapAuctionAdminRow({ address: A1, summary: summary({ closed: true }), cancelled: true });
    expect(getAuctionAdminStatus(cancelled, NOW)).toBe("cancelled");
    expect(getAdminActionAvailability(cancelled, NOW)).toMatchObject({ cancel: false, editMinimum: false, closeNow: false });
  });

  test("seller may edit the minimum only when allowed, as the seller, before any bid and before the end", () => {
    const row = mapAuctionAdminRow({ address: A1, summary: summary() });
    const base = { row, account: SELLER.toUpperCase().replace("0X", "0x"), nowSec: NOW, allowSellerEdit: true };
    expect(canSellerEditMinimum(base)).toBe(true);
    expect(canSellerEditMinimum({ ...base, allowSellerEdit: false })).toBe(false);
    expect(canSellerEditMinimum({ ...base, account: A2 })).toBe(false);
    expect(canSellerEditMinimum({ ...base, nowSec: NOW + 601 })).toBe(false);
    const withBid = mapAuctionAdminRow({ address: A1, summary: summary({ bidder: A2 }) });
    expect(canSellerEditMinimum({ ...base, row: withBid })).toBe(false);
  });

  test("new audit events are summarized and attributed", () => {
    const raw = (event, returnValues) => ({ event, returnValues, blockNumber: 5, logIndex: 1, transactionHash: "0xt", address: A1 });
    const reset = normalizeAuditEvent(raw("GlobalBudgetReset", { epoch: "2", newBudget: "500", by: A2 }));
    expect(reset.summary).toBe(`epoch 2: default budget 500 by ${A2}`);
    const min = normalizeAuditEvent(raw("MinimumChanged", { campaign: A3, oldMinimum: "1", newMinimum: "9", by: A2 }));
    expect(min.auction).toBe(A3);
    expect(min.summary).toMatch(/minimum 1 -> 9/);
    const cancel = normalizeAuditEvent(raw("AuctionCancelled", { campaign: A3, by: A2, note: "bad", fundsReleased: "true" }));
    expect(cancel.summary).toContain("cancelled by");
    expect(cancel.summary).toContain(": bad");
    const late = normalizeAuditEvent(raw("AuctionCancelled", { campaign: A3, by: A2, note: "", fundsReleased: "false" }));
    expect(late.summary).toContain("hidden only");
    expect(normalizeAuditEvent(raw("AuctionHiddenChanged", { campaign: A3, hidden: "true", by: A2 })).summary).toContain("hidden by");
    expect(normalizeAuditEvent(raw("UserDisabledChanged", { user: A3, disabled: "true", by: A2 })).summary).toContain("disabled by");
    expect(normalizeAuditEvent(raw("AdminAdded", { admin: A3, by: A2 })).actor).toBe(A3);
    expect(normalizeAuditEvent(raw("SellerPaymentDeferred", { seller: A3, amount: "7" })).auction).toBe(A1);
    // the serialized event never contains anything but chain-public fields
    expect(JSON.stringify(cancel)).not.toMatch(/dataForSell|payload/i);
  });

  test("user rows carry held, total and disabled", () => {
    const rows = mapUserRows({
      addresses: [A1, A2],
      budgets: { [A1]: "1700", [A2]: "2000" },
      held: { [A1]: "300" },
      disabled: new Set([A2]),
    });
    const one = rows.find((row) => row.address === A1);
    expect(one).toMatchObject({ budget: "1700", held: "300", total: "2000", disabled: false });
    expect(rows.find((row) => row.address === A2)).toMatchObject({ total: "2000", disabled: true });
  });

  test("hidden auctions are filtered for non-admins only", () => {
    const list = [{ address: A1 }, { address: A2 }];
    const hidden = new Set([A2]);
    expect(filterHiddenAuctions(list, hidden, false).map((a) => a.address)).toEqual([A1]);
    expect(filterHiddenAuctions(list, hidden, true)).toHaveLength(2);
    expect(auctionBadges({ hidden: true, cancelled: true })).toEqual(["Cancelled", "Hidden"]);
  });
});

const makeActions = () => ({
  setMinimum: jest.fn(async () => ({})),
  closeNow: jest.fn(async () => ({})),
  cancelAuction: jest.fn(async () => ({})),
  setHidden: jest.fn(async () => ({})),
  setAllowSellerEdit: jest.fn(async () => ({})),
  addAdmin: jest.fn(async () => ({})),
  removeAdmin: jest.fn(async () => ({})),
  setUserBudget: jest.fn(async () => ({})),
  setDisabled: jest.fn(async () => ({})),
});

const rowsReader = () => async () => [
  mapAuctionAdminRow({ address: A1, summary: summary({ min: 10, end: Math.floor(Date.now() / 1000) + 600 }) }),
  mapAuctionAdminRow({ address: A2, summary: summary({ end: Math.floor(Date.now() / 1000) + 600, bidder: A3 }), hidden: true }),
];

const openCard = async (title) => {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`Expand ${title}`, "i") }));
};

const renderControls = ({ canWrite, actions }) =>
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuctionControlsCard canWrite={canWrite} actions={actions} reader={rowsReader()} />
    </MemoryRouter>
  );

describe("Auction controls card", () => {
  test("non-admin: every write button is disabled and a read-only notice shows", async () => {
    const actions = makeActions();
    renderControls({ canWrite: false, actions });
    await openCard("Auction controls");
    await waitFor(() => expect(screen.getByTestId(`auction-row-${A1}`)).toBeInTheDocument());
    expect(screen.getByTestId("admin-write-disabled")).toBeInTheDocument();
    within(screen.getByTestId(`auction-row-${A1}`))
      .getAllByRole("button")
      .filter((button) => button.textContent !== "Record") // viewing the record is read-only
      .forEach((button) => expect(button).toBeDisabled());
    expect(actions.closeNow).not.toHaveBeenCalled();
  });

  test("admin: edit minimum, close now, hide/unhide and cancel with a note call the contract actions", async () => {
    const actions = makeActions();
    renderControls({ canWrite: true, actions });
    await openCard("Auction controls");
    const row1 = await screen.findByTestId(`auction-row-${A1}`);

    fireEvent.click(within(row1).getByRole("button", { name: "Edit minimum" }));
    fireEvent.change(screen.getByLabelText("Minimum"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(actions.setMinimum).toHaveBeenCalledWith(A1, "42"));

    await screen.findByText("Edit minimum: done");
    fireEvent.click(within(row1).getByRole("button", { name: "Close now" }));
    await waitFor(() => expect(actions.closeNow).toHaveBeenCalledWith(A1));
    await screen.findByText("Close now: done");

    fireEvent.click(within(row1).getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(actions.setHidden).toHaveBeenCalledWith(A1, true));
    await screen.findByText("Hide: done");

    const row2 = screen.getByTestId(`auction-row-${A2}`);
    expect(within(row2).getByText("hidden")).toBeInTheDocument();
    expect(within(row2).getByRole("button", { name: "Edit minimum" })).toBeDisabled(); // has a bid
    fireEvent.click(within(row2).getByRole("button", { name: "Unhide" }));
    await waitFor(() => expect(actions.setHidden).toHaveBeenCalledWith(A2, false));
    await screen.findByText("Unhide: done");

    fireEvent.click(within(row2).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Cancel auction?")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "wrong data" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel auction" }));
    await waitFor(() => expect(actions.cancelAuction).toHaveBeenCalledWith(A2, "wrong data"));
  });

  test("a failed transaction is reported, not swallowed", async () => {
    const actions = makeActions();
    actions.closeNow.mockRejectedValueOnce(new Error("Only admin"));
    renderControls({ canWrite: true, actions });
    await openCard("Auction controls");
    const row1 = await screen.findByTestId(`auction-row-${A1}`);
    fireEvent.click(within(row1).getByRole("button", { name: "Close now" }));
    expect(await screen.findByText(/Close now failed: Only admin/)).toBeInTheDocument();
  });
});

describe("Admins and settings cards", () => {
  test("the Admins card renders only for the owner and calls add/remove", async () => {
    const actions = makeActions();
    const { container, rerender } = render(<AdminsCard isOwner={false} actions={actions} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AdminsCard isOwner actions={actions} ownerReader={async () => "0xowner"} />);
    await openCard("Admins");
    fireEvent.change(screen.getByLabelText("Wallet address"), { target: { value: A3 } });
    fireEvent.click(screen.getByRole("button", { name: "Add admin" }));
    await waitFor(() => expect(actions.addAdmin).toHaveBeenCalledWith(A3));
    await screen.findByText("Add admin: done");
    fireEvent.click(screen.getByRole("button", { name: "Remove admin" }));
    await waitFor(() => expect(actions.removeAdmin).toHaveBeenCalledWith(A3));
  });

  test("AdminOpsCards shows the Admins card only to the owner", () => {
    const ui = (isOwner) => (
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminOpsCards access={{ canWrite: true, isOwner }} />
      </MemoryRouter>
    );
    const { rerender } = render(ui(false));
    expect(screen.queryByText("Admins")).toBeNull();
    rerender(ui(true));
    expect(screen.getByText("Admins")).toBeInTheDocument();
  });

  test("seller-edit toggle is read from the factory and writes only for admins", async () => {
    const actions = makeActions();
    const reader = async () => true;
    const { rerender } = render(<MarketSettingsCard canWrite={false} actions={actions} reader={reader} />);
    await openCard("Marketplace settings");
    const box = await screen.findByRole("checkbox");
    await waitFor(() => expect(box).toBeChecked());
    expect(box).toBeDisabled();
    rerender(<MarketSettingsCard canWrite actions={actions} reader={reader} />);
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(actions.setAllowSellerEdit).toHaveBeenCalledWith(false));
  });
});

describe("Users and budgets confirmations", () => {
  const U1 = "0x5555555555555555555555555555555555555555";
  const mockUsers = () => {
    const chain = chainImplementations((method, args) => {
      if (method === "allUsersCount") return "1";
      if (method === "allUsers") { if (args[0] === 0) return U1; throw new Error("execution reverted"); }
      if (method === "getBudget") return "100";
      if (method === "heldBy") return "0";
      if (method === "disabled" || method === "isAdmin") return false;
      if (method === "owner") return "0xowner";
      return null;
    });
    readOnlyCall.mockImplementation(chain.call);
    readOnlyBatchCall.mockImplementation(chain.batch);
  };

  test("Disable asks for confirmation first and does nothing when declined", async () => {
    mockUsers();
    const actions = makeActions();
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
    render(<UsersBudgetsCard canWrite actions={actions} />);
    await openCard("Users and budgets");
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/^Disable .+\?$/));
    expect(actions.setDisabled).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(actions.setDisabled).toHaveBeenCalledWith(U1, true));
    confirm.mockRestore();
  });
});
