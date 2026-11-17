import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import AccountPage from "./AccountPage";
import { getDefaultBudget } from "../../real_ethereum/budget";
import GuidePage from "../Guide/GuidePage";
import { scanParticipantView } from "../../tests/participantWording";

const ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678";
jest.mock("../../components/Layout", () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock("../../Context/Context", () => ({ useMetaMask: () => ({ account: ACCOUNT, status: "connected" }) }));
jest.mock("../../real_ethereum/budget", () => ({
  getDefaultBudget: jest.fn(),
  subscribeToBudgetChanges: () => () => {},
}));

beforeEach(() => { getDefaultBudget.mockResolvedValue("2000"); });
afterEach(() => { delete process.env.REACT_APP_WALLET_MODE; });
const at = (path) => render(
  <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Routes>
      <Route path="/" element={<h1>Home route</h1>} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/guide" element={<GuidePage />} />
      <Route path="/open-auction" element={<h1>Create route</h1>} />
    </Routes>
  </MemoryRouter>,
);

describe("AccountPage (local mode)", () => {
  beforeEach(() => { process.env.REACT_APP_WALLET_MODE = "local"; });

  test("shows name, shortened identifier, role and budget", async () => {
    const { container } = at("/account");
    expect(screen.getByRole("heading", { name: "Account Profile" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("2000")).toBeTruthy());
    expect(screen.getByText("Name:")).toBeTruthy();
    expect(screen.getByText("User")).toBeTruthy();
    expect(screen.getByText("0x1234...5678").getAttribute("title")).toBe(ACCOUNT);
    expect(scanParticipantView(container)).toEqual({ words: [], addresses: [] });
    expect(container.textContent).not.toMatch(/passphrase|private key|balance/i);
  });

  test("MetaMask mode has no such page", () => {
    process.env.REACT_APP_WALLET_MODE = "metamask";
    at("/account");
    expect(screen.getByText("Home route")).toBeTruthy();
  });
});

describe("GuidePage (local mode)", () => {
  beforeEach(() => { process.env.REACT_APP_WALLET_MODE = "local"; });

  test("renders the four steps, with the automatic account text and no sign-in button", () => {
    const { container } = at("/guide");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(4);
    expect(screen.getByText("Your account is created automatically the first time you open the platform.")).toBeTruthy();
    expect(screen.queryByText("Go to Sign-In")).toBeNull();
    expect(scanParticipantView(container)).toEqual({ words: [], addresses: [] });
  });

  test("the step actions navigate", () => {
    at("/guide");
    fireEvent.click(screen.getByRole("button", { name: /Open an Auction/ })); // expand step 3
    fireEvent.click(screen.getByRole("button", { name: "Start an Auction" }));
    expect(screen.getByText("Create route")).toBeTruthy();
  });

  test("MetaMask mode has no such page", () => {
    process.env.REACT_APP_WALLET_MODE = "metamask";
    at("/guide");
    expect(screen.getByText("Home route")).toBeTruthy();
  });
});
