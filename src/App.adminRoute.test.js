import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "./App";

jest.mock("./botnet/BotnetRuntimeHost", () => () => null);
jest.mock("./telemetry/PresenceCoordinator", () => () => null);
jest.mock("./components/Seo", () => ({ children }) => children);
jest.mock("./pages/AdminWallet/AdminLoginPage.js", () => () => <h1>Admin login page</h1>);
jest.mock("./pages/ManageBudget/ManageBudgetPage.js", () => () => <h1>Protected admin</h1>);
jest.mock("./pages/MetamaskLogin/MetamaskTutorialPage.js", () => () => <h1>Connect MetaMask</h1>);

const visited = [];
const Probe = () => { visited.push(useLocation().pathname); return null; };
const open = () => render(
  <MemoryRouter initialEntries={["/admin"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Probe /><App />
  </MemoryRouter>,
);

beforeEach(() => {
  visited.length = 0;
  window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  delete window.ethereum;
});
afterEach(() => { delete process.env.REACT_APP_WALLET_MODE; });

test("/admin goes to the admin sign-in in local mode", async () => {
  process.env.REACT_APP_WALLET_MODE = "local";
  open();
  expect(await screen.findByText("Admin login page")).toBeTruthy();
  expect(visited).toContain("/admin-login");
  expect(visited).not.toContain("/manage-budget");
});

test("/admin goes to the Admin Zone in MetaMask mode", async () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  open();
  await screen.findByText("Connect MetaMask"); // /manage-budget itself needs a wallet and redirects to the login
  expect(visited).toContain("/manage-budget");
  expect(visited).not.toContain("/admin-login");
});
