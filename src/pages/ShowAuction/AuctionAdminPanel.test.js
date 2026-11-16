import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AuctionAdminPanel from "./AuctionAdminPanel";

jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn() }));
jest.mock("../../real_ethereum/adminChain", () => ({ readIsFactoryAdmin: jest.fn(async () => false) }));
jest.mock("../../real_ethereum/factory", () => ({ __esModule: true, default: {} }));
jest.mock("../../real_ethereum/campaign", () => ({ __esModule: true, default: () => ({}) }));
jest.mock("../../real_ethereum/walletAccess", () => ({ requireWalletAccess: async () => ({ account: "0xabc" }) }));

const AUCTION = "0x1111111111111111111111111111111111111111";
const SELLER = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const future = () => Math.floor(Date.now() / 1000) + 600;

const baseProps = (overrides = {}) => ({
  address: AUCTION,
  account: SELLER,
  manager: SELLER,
  minimumContribution: "10",
  hasBids: false,
  endTimeSec: future(),
  closed: false,
  cancelled: false,
  readState: async () => ({ hidden: false, allowSellerEdit: true, isAdmin: false }),
  ...overrides,
});

describe("AuctionAdminPanel", () => {
  test("seller can edit the minimum before the first bid when allowed", async () => {
    const actions = { sellerSetMinimum: jest.fn(async () => ({})) };
    const onChanged = jest.fn();
    render(<AuctionAdminPanel {...baseProps()} actions={actions} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit minimum bid" }));
    fireEvent.change(screen.getByLabelText("New minimum bid (wei)"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save minimum" }));
    await waitFor(() => expect(actions.sellerSetMinimum).toHaveBeenCalledWith(AUCTION, "25"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test.each([
    ["a bid exists", { hasBids: true }],
    ["the auction ended", { endTimeSec: Math.floor(Date.now() / 1000) - 5 }],
    ["the viewer is not the seller", { account: OTHER }],
    ["the auction is cancelled", { cancelled: true, closed: true }],
    ["the admin turned seller edits off", { readState: async () => ({ hidden: false, allowSellerEdit: false, isAdmin: false }) }],
  ])("no edit control when %s", async (_label, overrides) => {
    render(<AuctionAdminPanel {...baseProps(overrides)} actions={{}} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Edit minimum bid" })).toBeNull());
  });

  test("rejects an out-of-range minimum without calling the contract", async () => {
    const actions = { sellerSetMinimum: jest.fn() };
    render(<AuctionAdminPanel {...baseProps()} actions={actions} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit minimum bid" }));
    fireEvent.change(screen.getByLabelText("New minimum bid (wei)"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save minimum" }));
    expect(await screen.findByText(/between 1/)).toBeInTheDocument();
    expect(actions.sellerSetMinimum).not.toHaveBeenCalled();
  });

  test("cancelled banner for everyone; hidden badge only for admins", async () => {
    const { rerender } = render(
      <AuctionAdminPanel
        {...baseProps({ cancelled: true, closed: true, readState: async () => ({ hidden: true, allowSellerEdit: true, isAdmin: false }) })}
        actions={{}}
      />
    );
    expect(screen.getByTestId("auction-cancelled-banner")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("auction-hidden-badge")).toBeNull());
    rerender(
      <AuctionAdminPanel
        {...baseProps({ cancelled: true, closed: true, account: OTHER, readState: async () => ({ hidden: true, allowSellerEdit: true, isAdmin: true }) })}
        actions={{}}
      />
    );
    expect(await screen.findByTestId("auction-hidden-badge")).toBeInTheDocument();
  });
});
