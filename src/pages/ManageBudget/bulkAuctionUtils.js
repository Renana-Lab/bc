/* eslint-env es2020 */
export const BULK_DRAFT_KEY = "bulkAuctionDraft";
export const BULK_MAX_AUCTIONS = 30;

const getDelimiter = (line) => {
  let quoted = false;
  const delimiterCounts = { "|": 0, "\t": 0, ",": 0 };

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character in delimiterCounts) {
      delimiterCounts[character] += 1;
    }
  }

  return Object.entries(delimiterCounts).sort(
    (left, right) => right[1] - left[1]
  )[0][0];
};

const splitBulkLine = (line) => {
  const delimiter = getDelimiter(line);
  const parts = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      parts.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }

  parts.push(value.trim());
  return parts;
};

const isHeaderLine = (parts) => {
  const normalized = parts.join(" ").toLowerCase();
  return (
    normalized.includes("description") &&
    normalized.includes("minimum") &&
    normalized.includes("duration")
  );
};

export const parseBulkAuctions = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, sourceIndex) => ({ line, sourceIndex }))
    .filter(({ line }) => !isHeaderLine(splitBulkLine(line)))
    .map(({ line, sourceIndex }) => {
      const [dataDescription, dataForSell, minimumContribution, auctionDuration] =
        splitBulkLine(line);

      return {
        rowNumber: sourceIndex + 1,
        minimumContribution: minimumContribution || "",
        auctionDuration: auctionDuration || "",
        dataForSell: dataForSell || "",
        dataDescription: dataDescription || "",
      };
    });

export const serializeBulkAuctions = (auctions) =>
  auctions
    .map(
      (auction) => {
        const escapePart = (value) => {
          const text = String(value || "");
          return /[|"\r\n]/.test(text)
            ? `"${text.replace(/"/g, '""')}"`
            : text;
        };

        return [
          auction.dataDescription,
          auction.dataForSell,
          auction.minimumContribution,
          auction.auctionDuration,
        ]
          .map(escapePart)
          .join(" | ");
      }
    )
    .join("\n");

export const makeBulkAuctionRows = ({
  rowCount,
  minimumContribution,
  auctionDuration,
  descriptionPrefix,
  dataPrefix,
}) =>
  Array.from({ length: rowCount }, (_, index) => ({
    rowNumber: index + 1,
    dataDescription: `${descriptionPrefix || "Auction"} ${index + 1}`,
    dataForSell: `${dataPrefix || "Data"} ${index + 1}`,
    minimumContribution: minimumContribution || "100",
    auctionDuration: auctionDuration || "10",
  }));

const isWholeNumber = (value) => /^\d+$/.test(String(value || ""));
const isPositiveWholeNumber = (value) =>
  isWholeNumber(value) && BigInt(value) > 0n;

export const getAuctionValidationError = (auction, label = "Auction") => {
  if (!isPositiveWholeNumber(auction.minimumContribution)) {
    return `${label}: minimum bid must be a positive whole number.`;
  }

  if (
    !isWholeNumber(auction.auctionDuration) ||
    Number(auction.auctionDuration) < 1 ||
    Number(auction.auctionDuration) > 30
  ) {
    return `${label}: duration must be a whole number between 1 and 30.`;
  }

  if (!String(auction.dataForSell || "").trim()) {
    return `${label}: data for sale cannot be empty.`;
  }

  if (!String(auction.dataDescription || "").trim()) {
    return `${label}: description cannot be empty.`;
  }

  return "";
};

export const getTransactionErrorMessage = (err) => {
  const message = JSON.stringify(err?.message || err || "");

  if (message.includes("replacement transaction underpriced")) {
    return "MetaMask has a pending transaction. Wait for it, or speed/cancel it in Activity.";
  }
  if (
    message.includes("User denied") ||
    message.includes("User rejected") ||
    message.includes("4001")
  ) {
    return "Transaction rejected in MetaMask.";
  }
  return "Transaction failed. Please try again.";
};
