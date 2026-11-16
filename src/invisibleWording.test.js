import React from "react";
import fs from "fs";
import path from "path";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PageSeo from "./components/Seo";
import { getWalletCopy } from "./real_ethereum/wallets/walletCopy";
import { NEUTRAL_RETRY_MESSAGE, participantMessage } from "./real_ethereum/wallets/participantCopy";

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");

afterEach(() => { delete process.env.REACT_APP_WALLET_MODE; delete process.env.REACT_APP_LOCAL_WALLET_PASSPHRASE; });

describe("neutral page title on the wallet-unlock route (invisible mode)", () => {
  const titleFor = (mode) => {
    if (mode) process.env.REACT_APP_WALLET_MODE = mode;
    render(<MemoryRouter><PageSeo page="metamaskLogin"><div /></PageSeo></MemoryRouter>);
    return document.title;
  };
  test("no MetaMask and no wallet wording in the title or description", () => {
    const title = titleFor("local");
    expect(title).not.toMatch(/metamask|wallet|connect/i);
    expect(title).toMatch(/Blockchain Data Market/);
    const copy = getWalletCopy();
    for (const text of [copy.seo.loginTitle, copy.seo.loginDescription, copy.seo.description]) expect(text).not.toMatch(/metamask|wallet|passphrase|sapphire|TEST/i);
  });
  test("MetaMask mode keeps the original title, the passphrase flow keeps the unlock title", () => {
    expect(titleFor("metamask")).toBe("Connect MetaMask | Blockchain Data Market");
    process.env.REACT_APP_LOCAL_WALLET_PASSPHRASE = "required";
    expect(titleFor("local")).toMatch(/Unlock your wallet/);
  });
});

describe("participant-facing messages in invisible mode", () => {
  test("the 'No wallet account is connected.' error is neutral in invisible mode and unchanged otherwise", () => {
    process.env.REACT_APP_WALLET_MODE = "local";
    expect(participantMessage("No wallet account is connected.")).toBe(NEUTRAL_RETRY_MESSAGE);
    process.env.REACT_APP_WALLET_MODE = "metamask";
    expect(participantMessage("No wallet account is connected.")).toBe("No wallet account is connected.");
  });
  test("NewAuctionPage routes that error through participantMessage (ManageBudgetPage is admin-only and untouched)", () => {
    expect(read("pages/NewAuction/NewAuctionPage.js")).toMatch(/new Error\(participantMessage\("No wallet account is connected\."\)\)/);
  });
  test("the auctions search placeholder no longer mentions a wallet", () => {
    const source = read("pages/AuctionsList/AuctionsListPage.js");
    expect(source).toMatch(/placeholder="Search auctions by description, address, or exact bid"/);
    expect(source).not.toMatch(/by description, wallet/);
  });
});
