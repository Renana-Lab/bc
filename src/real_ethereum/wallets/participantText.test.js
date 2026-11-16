import { PARTICIPANT_TEXT_KEYS, participantText, shortIdentifier } from "./participantCopy";

const originalMode = process.env.REACT_APP_WALLET_MODE;
afterEach(() => { process.env.REACT_APP_WALLET_MODE = originalMode; delete process.env.REACT_APP_LOCAL_WALLET_PASSPHRASE; window.sessionStorage.clear(); });

const FORBIDDEN = /blockchain|cryptocurrency|\bwei\b|metamask|ethereum|sapphire|\bgas\b|\bwallet\b/i;

test("local (invisible) mode returns the market wording", () => {
  process.env.REACT_APP_WALLET_MODE = "local";
  expect(participantText("brand")).toBe("Data Marketplace");
  expect(participantText("listHero")).toBe("Welcome to the Data Marketplace Platform");
  expect(participantText("createImageAlt")).toBe("Create a data auction");
  expect(participantText("sellerLabel")).toBe("Seller identifier");
  expect(participantText("minBidLabel")).toBe("Minimum bid required");
  expect(participantText("highestBidLabel")).toBe("Highest bid recorded");
  expect(participantText("searchPlaceholder")).toBe("Search auctions by description, seller identifier, or exact bid");
  expect(participantText("homeBody").replace(/\s+/g, " ")).toBe(
    "This is a research platform, for running auctions of personal data using the marketplace budget. Each auction lasts up to 30 mins.",
  );
});

test("no invisible-mode string contains blockchain, wei, wallet or similar wording", () => {
  process.env.REACT_APP_WALLET_MODE = "local";
  for (const key of PARTICIPANT_TEXT_KEYS) {
    expect(participantText(key, { allowSellerEdit: true })).not.toMatch(FORBIDDEN);
  }
});

test("the minimum bid tooltip says cents in local mode and appends the edit window only when sellers may edit", () => {
  process.env.REACT_APP_WALLET_MODE = "local";
  expect(participantText("minBidTooltip", { allowSellerEdit: false })).toBe(
    "The lowest price you are willing to accept for selling your information (in cents).",
  );
  expect(participantText("minBidTooltip", { allowSellerEdit: true })).toBe(
    "The lowest price you are willing to accept for selling your information (in cents). You can change this price at any time before the first bid is placed.",
  );
});

test("MetaMask mode keeps every existing string byte for byte", () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  expect(participantText("brand")).toBe("Blockchain Data Market");
  expect(participantText("listHero")).toBe("Welcome to the Blockchain Data Market Platform");
  expect(participantText("createImageAlt")).toBe("Create a blockchain data auction");
  expect(participantText("sellerLabel")).toBe("Seller address");
  expect(participantText("minBidLabel")).toBe("Minimum bid");
  expect(participantText("highestBidLabel")).toBe("Highest bid");
  expect(participantText("countdownEnded")).toBe("Ended");
  expect(participantText("searchPlaceholder")).toBe("Search auctions by description, address, or exact bid");
  expect(participantText("minBidTooltip", { allowSellerEdit: true })).toBe(
    "The lowest price you are willing to accept for selling your information (in wei).",
  );
  expect(participantText("homeBody")).toBe(
    "This is a blockchain based research platform, for running\nauctions of personal data using cryptocurrency.\nEach auction lasts up to 30 mins.",
  );
});

test("the passphrase flow of local mode is not the invisible wallet and keeps the original wording", () => {
  process.env.REACT_APP_WALLET_MODE = "local";
  process.env.REACT_APP_LOCAL_WALLET_PASSPHRASE = "required";
  expect(participantText("brand")).toBe("Blockchain Data Market");
});

test("unknown keys fail loudly", () => {
  expect(() => participantText("nope")).toThrow(/Unknown participant text/);
});

test("shortIdentifier shortens addresses only", () => {
  expect(shortIdentifier("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234...5678");
  expect(shortIdentifier("not an address")).toBe("not an address");
  expect(shortIdentifier(undefined)).toBe("");
});
