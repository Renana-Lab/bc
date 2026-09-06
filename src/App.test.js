import React from "react";
import { act, render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { getWalletAccess } from "./real_ethereum/walletAccess";

jest.mock("./botnet/BotnetRuntimeHost", () => () => null);
jest.mock("./telemetry/PresenceCoordinator", () => () => null);
jest.mock("./components/Seo", () => ({ children }) => children);
jest.mock("./pages/Home/HomePage.js", () => () => <h1>Welcome</h1>);
jest.mock("./pages/MetamaskLogin/MetamaskTutorialPage.js", () => () => <h1>Connect MetaMask</h1>);
jest.mock("./pages/MetamaskGuide/MetamaskGuidePage.js", () => () => <h1>Wallet guide</h1>);
jest.mock("./pages/AuctionsList/AuctionsListPage.js", () => () => <input aria-label="Protected auction search" />);
jest.mock("./pages/NewAuction/NewAuctionPage.js", () => () => <h1>Protected create</h1>);
jest.mock("./pages/ShowAuction/ShowAuctionPage.js", () => () => <h1>Protected detail</h1>);
jest.mock("./pages/ManageBudget/ManageBudgetPage.js", () => () => <h1>Protected admin</h1>);
const address = "0x1234567890abcdef1234567890abcdef12345678";
let provider;
beforeEach(() => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
  provider = { isMetaMask: true, _metamask: { isUnlocked: jest.fn().mockResolvedValue(true) },
    request: jest.fn().mockResolvedValue([address]), handlers: {},
    on: (name, fn) => { provider.handlers[name] = fn; },
    removeListener: (name, fn) => { if (provider.handlers[name] === fn) delete provider.handlers[name]; },
  };
  delete window.ethereum;
});
afterEach(() => { cleanup(); delete window.ethereum; });
const open = (path) => render(<React.StrictMode><MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></MemoryRouter></React.StrictMode>);
test.each(["/auctions-list", "/open-auction", "/auction/0x123", "/manage-budget"])("direct link %s never renders without a wallet", async (path) => {
  const view = open(path);
  expect(view.container.textContent).not.toMatch(/Protected/);
  await screen.findByText("Connect MetaMask");
  expect(view.container.textContent).not.toMatch(/Protected/);
});
test("locked wallet with cached accounts is denied", async () => {
  window.ethereum = provider; provider._metamask.isUnlocked.mockResolvedValue(false);
  open("/auctions-list"); await screen.findByText("Connect MetaMask");
  expect(screen.queryByLabelText("Protected auction search")).toBeNull();
});
test("content never mounts while the account request is pending", async () => {
  window.ethereum = provider; provider.request.mockImplementation(() => new Promise(() => {}));
  open("/auctions-list");
  await screen.findByText("Verifying your MetaMask connection");
  expect(screen.queryByLabelText("Protected auction search")).toBeNull();
});
test("disconnect followed by an old success cannot restore the page", async () => {
  window.ethereum = provider; let resolve;
  provider.request.mockImplementation(() => new Promise((r) => { resolve = r; }));
  open("/auctions-list");
  await waitFor(() => expect(resolve).toBeDefined());
  await act(async () => { provider.handlers.disconnect(); resolve([address]); });
  await screen.findByText("Connect MetaMask");
  expect(screen.queryByLabelText("Protected auction search")).toBeNull();
});
test("focus revalidation preserves form DOM and input", async () => {
  window.ethereum = provider; open("/auctions-list");
  const field = await screen.findByLabelText("Protected auction search"); field.value = "keep my work";
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(getWalletAccess().status).toBe("connected"));
  expect(screen.getByLabelText("Protected auction search")).toBe(field);
  expect(field.value).toBe("keep my work");
});
test("lock event removes the protected content", async () => {
  window.ethereum = provider; open("/auctions-list"); await screen.findByLabelText("Protected auction search");
  provider._metamask.isUnlocked.mockResolvedValue(false);
  await act(async () => { provider.handlers.accountsChanged([]); });
  await screen.findByText("Connect MetaMask");
  expect(screen.queryByLabelText("Protected auction search")).toBeNull();
});
test.each([["/", "Welcome"], ["/metamask-guide", "Wallet guide"]])("public route %s stays accessible", async (path, title) => {
  open(path); await screen.findByText(title);
});
