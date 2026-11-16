import fs from "fs";
import path from "path";

test("Bot Command Center no longer links to Sepolia Etherscan", () => {
  const source = fs.readFileSync(path.join(__dirname, "BotnetControlPanel.js"), "utf8");
  expect(source).not.toMatch(/sepolia\.etherscan\.io/);
  expect(source).toMatch(/blockExplorerUrls/);
});
