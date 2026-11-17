import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HomePage from "./HomePage";
import { scanParticipantView } from "../../tests/participantWording";

jest.mock("../../components/Layout", () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));

afterEach(() => { delete process.env.REACT_APP_WALLET_MODE; });
const renderHome = () => render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><HomePage /></MemoryRouter>);

test("local mode shows the market wording and nothing forbidden", () => {
  process.env.REACT_APP_WALLET_MODE = "local";
  const { container } = renderHome();
  expect(container.querySelector("p").textContent).toBe(
    "This is a research platform, for runningauctions of personal data using the marketplace budget.Each auction lasts up to 30 mins.",
  );
  expect(screen.getByAltText("Research data marketplace illustration")).toBeTruthy();
  expect(scanParticipantView(container)).toEqual({ words: [], addresses: [] });
});

test("MetaMask mode keeps the original wording", () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  const { container } = renderHome();
  expect(container.querySelector("p").textContent).toMatch(/blockchain based research platform.*cryptocurrency/);
  expect(screen.getByAltText("Blockchain data marketplace illustration")).toBeTruthy();
});

test.each(["local", "metamask"])("the No Thanks MTurk button is gone in %s mode", (mode) => {
  process.env.REACT_APP_WALLET_MODE = mode;
  const { container } = renderHome();
  expect(screen.queryByText("No Thanks")).toBeNull();
  expect(container.querySelector('a[href*="mturk"]')).toBeNull();
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
});
