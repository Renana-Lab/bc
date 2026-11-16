import { render, screen, within } from "@testing-library/react";
import { AMPLIFY_APP_ID, AMPLIFY_BRANCH, FAUCET_STACK, buildRunbook } from "./architectureRunbook";
import { RunbookBlock } from "./AdminOpsCards";

jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn(), readOnlyExecute: jest.fn() }));
jest.mock("../../real_ethereum/socketFactory", () => ({ canUseLiveEvents: () => false, factorySocket: { events: {} } }));
jest.mock("../../real_ethereum/factory", () => ({ __esModule: true, default: {} }));
jest.mock("../../real_ethereum/campaign", () => ({ __esModule: true, default: () => ({}) }));
jest.mock("../../real_ethereum/walletAccess", () => ({ requireWalletAccess: jest.fn() }));

const FACTORY = "0x00000000000000000000000000000000000000f0";
const network = { blockExplorerUrls: ["https://explorer.oasis.io/testnet/sapphire"] };

test("covers the five components with the documented names", () => {
  const runbook = buildRunbook({ factoryAddress: FACTORY, network });
  expect(runbook.components.map((component) => component.name)).toEqual(["Frontend", "Faucet API", "Data", "Scheduler", "Chain"]);
  const text = JSON.stringify(runbook);
  for (const expected of [AMPLIFY_APP_ID, AMPLIFY_BRANCH, FAUCET_STACK, "us-east-2", "FaucetFunction", "SweepJobFunction", "rate(5 minutes)", "23295", FACTORY, "infrastructure/faucet/README.md"]) {
    expect(text).toContain(expected);
  }
});

test("links are public https consoles or the explorer, and nothing secret or account-specific appears", () => {
  const runbook = buildRunbook({ factoryAddress: FACTORY, network });
  const links = runbook.components.flatMap((component) => component.links.map((link) => link.href));
  links.forEach((href) => expect(href).toMatch(/^https:\/\/([a-z0-9-]+\.)*(console\.aws\.amazon\.com|explorer\.oasis\.io)\//));
  const text = JSON.stringify(runbook);
  expect(text).not.toMatch(/\b\d{12}\b/); // no AWS account id
  expect(text).not.toMatch(/0x[0-9a-fA-F]{64}\b/); // no private key / tx hash
  expect(text).not.toMatch(/password\s*[:=]/i);
  expect(text).not.toMatch(/secret.?access|AKIA[0-9A-Z]{12,}/i);
});

test("the Architecture card block renders the runbook with a Deploy line", () => {
  render(<RunbookBlock factoryAddress={FACTORY} network={network} />);
  const block = screen.getByTestId("architecture-runbook");
  expect(within(block).getByText("How to access and maintain each component")).toBeInTheDocument();
  expect(within(block).getByRole("link", { name: "Factory on the explorer" }).getAttribute("href")).toBe(`https://explorer.oasis.io/testnet/sapphire/address/${FACTORY}`);
  expect(screen.getByTestId("runbook-deploy")).toHaveTextContent("infrastructure/faucet/README.md");
});
