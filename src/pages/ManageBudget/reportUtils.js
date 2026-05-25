/* eslint-env es2020 */
import { readOnlyCall } from "../../real_ethereum/readOnly";

export const REPORT_CONCURRENCY = 3;
const BIDDER_STATUS_CONCURRENCY = 4;
const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };
const SEPOLIA_ADDRESS_URL = "https://sepolia.etherscan.io/address/";
const BUDGET_AT_BID_UNAVAILABLE =
  "Unavailable in current contract";
const BUDGET_AT_BID_EXPLANATION =
  "This auction was created by an older contract that does not store per-bid budget snapshots.";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }
  );

  await Promise.all(workers);
  return results;
};

const escapeXml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const toDateTime = (seconds) => {
  const timestamp = Number(seconds || 0);
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleString();
};

const toIsoDateTime = (seconds) => {
  const timestamp = Number(seconds || 0);
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toISOString();
};

export const toDateInputValue = (seconds) => {
  const iso = toIsoDateTime(seconds);
  return iso ? iso.slice(0, 10) : "";
};

export const shortAddress = (address) =>
  address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";

const getDateRangeMs = (filters) => {
  const fromMs = filters.from
    ? new Date(`${filters.from}T00:00:00`).getTime()
    : null;
  const toMs = filters.to ? new Date(`${filters.to}T23:59:59`).getTime() : null;
  return { fromMs, toMs };
};

export const isEndTimeInDateRange = (endTime, filters) => {
  const endMs = Number(endTime || 0) * 1000;
  const { fromMs, toMs } = getDateRangeMs(filters);

  if (!endMs) return false;
  if (fromMs !== null && endMs < fromMs) return false;
  if (toMs !== null && endMs > toMs) return false;
  return true;
};

export const filterReportsByDate = (reports, filters) => {
  if (!filters.from && !filters.to) return reports;
  return reports.filter(({ auction }) => isEndTimeInDateRange(auction.endTime, filters));
};

const buildWorksheet = (name, rows) => {
  const safeRows = rows.length ? rows : [{ Notice: "No rows available" }];
  const headers = Array.from(
    safeRows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );
  const columnXml = headers
    .map((header) => {
      const width = Math.min(Math.max(String(header).length * 8, 90), 240);
      return `<Column ss:Width="${width}"/>`;
    })
    .join("");
  const headerXml = `<Row ss:StyleID="Header">${headers
    .map(
      (header) =>
        `<Cell><Data ss:Type="String">${escapeXml(header)}</Data></Cell>`
    )
    .join("")}</Row>`;
  const bodyXml = safeRows
    .map(
      (row) =>
        `<Row>${headers
          .map((header) => {
            const value = row[header];
            const type =
              typeof value === "number" && Number.isFinite(value)
                ? "Number"
                : "String";
            return `<Cell><Data ss:Type="${type}">${escapeXml(
              value
            )}</Data></Cell>`;
          })
          .join("")}</Row>`
    )
    .join("");

  return `<Worksheet ss:Name="${escapeXml(name)}"><Table>${columnXml}${headerXml}${bodyXml}</Table></Worksheet>`;
};

const buildWorkbook = (sheets) =>
  `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
  <Style ss:ID="Header">
    <Font ss:Bold="1" ss:Color="#FFFFFF"/>
    <Interior ss:Color="#233A8B" ss:Pattern="Solid"/>
  </Style>
</Styles>
${sheets.map((sheet) => buildWorksheet(sheet.name, sheet.rows)).join("")}
</Workbook>`;

const downloadBlob = (content, mimeType, extension, reportKind) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const link = document.createElement("a");

  link.href = url;
  link.download = `auction-admin-${reportKind}-${timestamp}.${extension}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const downloadWorkbook = (sheets) => {
  downloadBlob(
    buildWorkbook(sheets),
    "application/vnd.ms-excel;charset=utf-8;",
    "xls",
    "workbook"
  );
};

export const downloadJsonReport = (payload) => {
  downloadBlob(
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8;",
    "json",
    "raw-data"
  );
};

const escapeCsvValue = (value) => {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
};

const buildCsv = (rows) => {
  const safeRows = rows.length ? rows : [{ Notice: "No rows available" }];
  const headers = Array.from(
    safeRows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );
  const headerLine = headers.map(escapeCsvValue).join(",");
  const bodyLines = safeRows.map((row) =>
    headers.map((header) => escapeCsvValue(row[header])).join(",")
  );

  return [headerLine, ...bodyLines].join("\r\n");
};

export const downloadCsvReport = (rows, reportKind) => {
  downloadBlob(buildCsv(rows), "text/csv;charset=utf-8;", "csv", reportKind);
};

const toBigIntSafe = (value) => {
  try {
    return BigInt(value || 0);
  } catch (error) {
    return 0n;
  }
};

const hasWei = (value) => toBigIntSafe(value) > 0n;

export const compareWeiDesc = (left, right) => {
  const leftValue = toBigIntSafe(left);
  const rightValue = toBigIntSafe(right);
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? -1 : 1;
};

const normalizeTransactions = (rawTransactions, highestBid, highestBidder) => {
  const normalized = rawTransactions.map((tx, idx) => {
    const hasBudgetSnapshot =
      tx.budgetBefore !== undefined && tx.budgetAfter !== undefined;

    return {
      idx,
      bidder: tx.bidderAddress,
      bidderKey: tx.bidderAddress.toLowerCase(),
      value: BigInt(tx.value || 0),
      time: BigInt(tx.time || 0),
      contractCumulativeBid:
        tx.cumulativeBid !== undefined ? String(tx.cumulativeBid || 0) : "",
      budgetBeforeBidWei: hasBudgetSnapshot
        ? String(tx.budgetBefore || 0)
        : BUDGET_AT_BID_UNAVAILABLE,
      budgetAfterBidWei: hasBudgetSnapshot
        ? String(tx.budgetAfter || 0)
        : "",
      budgetSnapshotSource: hasBudgetSnapshot
        ? "Contract Bid snapshot"
        : BUDGET_AT_BID_EXPLANATION,
      previousHighestBidder: tx.previousHighestBidder || "",
      previousHighestBidWei:
        tx.previousHighestBid !== undefined
          ? String(tx.previousHighestBid || 0)
          : "",
    };
  });
  const byTime = [...normalized].sort((a, b) =>
    a.time === b.time ? a.idx - b.idx : a.time < b.time ? -1 : 1
  );
  const sumByBidder = new Map();
  const cumulativeByIndex = Array(normalized.length).fill(0n);

  byTime.forEach((tx) => {
    const next = (sumByBidder.get(tx.bidderKey) || 0n) + tx.value;
    sumByBidder.set(tx.bidderKey, next);
    cumulativeByIndex[tx.idx] = next;
  });

  const highestBidValue = BigInt(highestBid || 0);
  const highestBidderKey = (highestBidder || "").toLowerCase();

  return normalized.map((tx, index) => ({
    bidder: tx.bidder,
    bidderKey: tx.bidderKey,
    transactionAmountWei: tx.value.toString(),
    cumulativeBidWei: cumulativeByIndex[index].toString(),
    contractCumulativeBidWei: tx.contractCumulativeBid,
    budgetBeforeBidWei: tx.budgetBeforeBidWei,
    budgetAfterBidWei: tx.budgetAfterBidWei,
    budgetSnapshotSource: tx.budgetSnapshotSource,
    previousHighestBidder: tx.previousHighestBidder,
    previousHighestBidWei: tx.previousHighestBidWei,
    timeSeconds: tx.time.toString(),
    time: toDateTime(tx.time),
    isoTime: toIsoDateTime(tx.time),
    isHighestBid:
      Boolean(highestBidderKey) &&
      tx.bidderKey === highestBidderKey &&
      cumulativeByIndex[index] === highestBidValue,
  }));
};

export const readAuctionOption = async (address, index) => {
  const summary = await readOnlyCall(
    ({ campaign }) => campaign(address).methods.getSummary(),
    undefined,
    READ_OPTIONS
  );

  return {
    index: index + 1,
    address,
    minimumContribution: summary[0],
    seller: summary[3],
    highestBid: summary[4],
    dataDescription: summary[6],
    highestBidder: summary[7],
    endTime: summary[9],
    endDate: toDateInputValue(summary[9]),
  };
};

const readAuctionTransactions = async (address) => {
  const ledgerResult = await readOnlyCall(
    ({ campaign }) => campaign(address).methods.getBidLedger(),
    undefined,
    READ_OPTIONS
  )
    .then((rows) => ({ supported: true, rows }))
    .catch(() => ({ supported: false, rows: [] }));

  if (ledgerResult.supported) {
    return ledgerResult.rows || [];
  }

  return readOnlyCall(
    ({ campaign }) => campaign(address).methods.getTransactions(),
    undefined,
    READ_OPTIONS
  ).catch(() => []);
};

export const readAuctionReport = async (
  address,
  index,
  total,
  onProgress,
  progressIndex = index
) => {
  onProgress?.(`Reading auction ${progressIndex + 1} of ${total}`);

  const [summary, rawTransactions, closedResult] = await Promise.all([
    readOnlyCall(
      ({ campaign }) => campaign(address).methods.getSummary(),
      undefined,
      READ_OPTIONS
    ),
    readAuctionTransactions(address),
    readOnlyCall(
      ({ campaign }) => campaign(address).methods.getStatus(),
      undefined,
      READ_OPTIONS
    ).catch((error) => ({
      readError: error.message || "Auction status read failed",
    })),
  ]);
  const auction = {
    index: index + 1,
    address,
    minimumContribution: summary[0],
    balance: summary[1],
    approversCount: summary[2],
    seller: summary[3],
    highestBid: summary[4],
    dataForSell: summary[5],
    dataDescription: summary[6],
    highestBidder: summary[7],
    addresses: summary[8] || [],
    endTime: summary[9],
    closed: closedResult === true,
    closedReadError:
      closedResult && typeof closedResult === "object"
        ? closedResult.readError
        : "",
  };
  const ended = Number(auction.endTime) * 1000 <= Date.now();
  const transactions = normalizeTransactions(
    rawTransactions,
    auction.highestBid,
    auction.highestBidder
  );
  const uniqueBidders = Array.from(
    new Map(transactions.map((tx) => [tx.bidderKey, tx.bidder])).values()
  );
  const bidderStatuses = await mapWithConcurrency(
    uniqueBidders,
    BIDDER_STATUS_CONCURRENCY,
    async (bidder) => {
      try {
        const status = await readOnlyCall(
          ({ campaign }) => campaign(address).methods.getUserAuctionStatus(bidder),
          undefined,
          READ_OPTIONS
        );
        return {
          auctionAddress: address,
          bidderAddress: bidder,
          participated: Boolean(status[0]) ? "Yes" : "No",
          currentBidWei: status[1],
          refunded: Boolean(status[2]) ? "Yes" : "No",
          isSeller: Boolean(status[3]) ? "Yes" : "No",
          isHighestBidder: Boolean(status[4]) ? "Yes" : "No",
          readError: "",
        };
      } catch (error) {
        return {
          auctionAddress: address,
          bidderAddress: bidder,
          participated: "Yes",
          currentBidWei: "",
          refunded: "",
          isSeller: "",
          isHighestBidder:
            bidder.toLowerCase() === auction.highestBidder.toLowerCase()
              ? "Yes"
              : "No",
          readError: error.message || "Status read failed",
        };
      }
    }
  );

  await wait(80);
  return { auction, ended, transactions, bidderStatuses };
};

const getSellerPaymentState = (auction, ended) => {
  if (!ended) return "Open";
  if (auction.closedReadError) return "Needs review";
  if (!hasWei(auction.highestBid)) return "No bids";
  return auction.closed ? "Seller payment finalized" : "Seller payment pending";
};

const getBidderPaymentState = (auction, ended, status) => {
  if (!ended) return "Auction open";
  if (status.readError) return "Needs review";
  if (status.isHighestBidder === "Yes") return "Winner / charged";
  if (status.refunded === "Yes") return "Refunded";
  if (hasWei(status.currentBidWei)) return "Refund pending";
  return "No active balance";
};

const shouldIncludeOption = (options, group, key) =>
  options?.[group]?.[key] !== false;

const filterSheets = (sheets, options) => {
  const selectedSections = options?.sections;
  if (!selectedSections) return sheets;
  return sheets.filter((sheet) => selectedSections[sheet.key] !== false);
};

const buildReportAnalysis = (reports, errors, options = {}) => {
  const sellerMap = new Map();
  const bidderMap = new Map();
  const paymentRows = [];
  const flagRows = [];
  const addFlag = (key, row) => {
    if (shouldIncludeOption(options, "diagnostics", key)) {
      flagRows.push(row);
    }
  };

  reports.forEach(({ auction, ended, transactions, bidderStatuses }) => {
    const sellerKey = (auction.seller || "").toLowerCase();
    const uniqueBidders = new Set(transactions.map((tx) => tx.bidderKey));
    const sellerRow =
      sellerMap.get(sellerKey) || {
        "Seller Address": auction.seller,
        "Auctions Created": 0,
        "Open Auctions": 0,
        "Closed Auctions": 0,
        "Auctions With Bids": 0,
        "Total Bid Rows": 0,
        "Unique Bidders": new Set(),
        "Total Highest Bids (wei)": 0n,
        "Pending Seller Payments": 0,
      };

    sellerRow["Auctions Created"] += 1;
    sellerRow[ended ? "Closed Auctions" : "Open Auctions"] += 1;
    sellerRow["Auctions With Bids"] += hasWei(auction.highestBid) ? 1 : 0;
    sellerRow["Total Bid Rows"] += transactions.length;
    sellerRow["Total Highest Bids (wei)"] += toBigIntSafe(auction.highestBid);
    if (ended && hasWei(auction.highestBid) && !auction.closed) {
      sellerRow["Pending Seller Payments"] += 1;
    }
    uniqueBidders.forEach((bidderKey) => sellerRow["Unique Bidders"].add(bidderKey));
    sellerMap.set(sellerKey, sellerRow);

    paymentRows.push({
      "Auction #": auction.index,
      "Auction Address": auction.address,
      Description: auction.dataDescription,
      "Actor Role": "Seller",
      "Actor Address": auction.seller,
      "Payment Review": getSellerPaymentState(auction, ended),
      Participated: "",
      "Current Bid (wei)": "",
      Refunded: "",
      "Is Seller": "Yes",
      "Is Highest Bidder": "",
      "Read Error": "",
    });

    bidderStatuses.forEach((status) => {
      const bidderKey = (status.bidderAddress || "").toLowerCase();
      const bidderRow =
        bidderMap.get(bidderKey) || {
          "Bidder Address": status.bidderAddress,
          "Auctions Participated": new Set(),
          "Bid Transactions": 0,
          "Total Transaction Amount (wei)": 0n,
          "Current Bid Balance Sum (wei)": 0n,
          "Highest Bidder Statuses": 0,
          "Refunded Auctions": 0,
          "Status Read Errors": 0,
        };

      bidderRow["Auctions Participated"].add(auction.address);
      bidderRow["Current Bid Balance Sum (wei)"] += toBigIntSafe(
        status.currentBidWei
      );
      bidderRow["Highest Bidder Statuses"] +=
        status.isHighestBidder === "Yes" ? 1 : 0;
      bidderRow["Refunded Auctions"] += status.refunded === "Yes" ? 1 : 0;
      bidderRow["Status Read Errors"] += status.readError ? 1 : 0;
      bidderMap.set(bidderKey, bidderRow);

      paymentRows.push({
        "Auction #": auction.index,
        "Auction Address": auction.address,
        Description: auction.dataDescription,
        "Actor Role": "Bidder",
        "Actor Address": status.bidderAddress,
        "Payment Review": getBidderPaymentState(auction, ended, status),
        Participated: status.participated,
        "Current Bid (wei)": status.currentBidWei,
        Refunded: status.refunded,
        "Is Seller": status.isSeller,
        "Is Highest Bidder": status.isHighestBidder,
        "Read Error": status.readError,
      });
    });

    transactions.forEach((tx) => {
      const bidderRow =
        bidderMap.get(tx.bidderKey) || {
          "Bidder Address": tx.bidder,
          "Auctions Participated": new Set(),
          "Bid Transactions": 0,
          "Total Transaction Amount (wei)": 0n,
          "Current Bid Balance Sum (wei)": 0n,
          "Highest Bidder Statuses": 0,
          "Refunded Auctions": 0,
          "Status Read Errors": 0,
        };

      bidderRow["Auctions Participated"].add(auction.address);
      bidderRow["Bid Transactions"] += 1;
      bidderRow["Total Transaction Amount (wei)"] += toBigIntSafe(
        tx.transactionAmountWei
      );
      bidderMap.set(tx.bidderKey, bidderRow);
    });

    if (!transactions.length) {
      addFlag("zeroBids", {
        "Auction #": auction.index,
        "Auction Address": auction.address,
        Description: auction.dataDescription,
        Severity: "Info",
        Flag: "No bids recorded",
        Detail: "Auction has no bid transactions.",
      });
    }

    if (uniqueBidders.size === 1) {
      addFlag("singleBidder", {
        "Auction #": auction.index,
        "Auction Address": auction.address,
        Description: auction.dataDescription,
        Severity: "Info",
        Flag: "Single bidder",
        Detail: "Only one unique bidder appears in the transaction history.",
      });
    }

    if (ended && hasWei(auction.highestBid) && !auction.closed) {
      addFlag("paymentIssues", {
        "Auction #": auction.index,
        "Auction Address": auction.address,
        Description: auction.dataDescription,
        Severity: auction.closedReadError ? "Medium" : "High",
        Flag: auction.closedReadError
          ? "Payment status read failed"
          : "Seller payment pending",
        Detail:
          auction.closedReadError ||
          "Auction has ended with a highest bid, but getStatus is false.",
      });
    }

    if (hasWei(auction.highestBid) && !transactions.some((tx) => tx.isHighestBid)) {
      addFlag("highestBidMismatch", {
        "Auction #": auction.index,
        "Auction Address": auction.address,
        Description: auction.dataDescription,
        Severity: "Medium",
        Flag: "Highest bid not matched to a bid row",
        Detail:
          "Summary highestBid/highestBidder did not map cleanly to the cumulative bid history.",
      });
    }

    if (Number(auction.approversCount || 0) !== uniqueBidders.size) {
      addFlag("bidderCountMismatch", {
        "Auction #": auction.index,
        "Auction Address": auction.address,
        Description: auction.dataDescription,
        Severity: "Low",
        Flag: "Bidder count mismatch",
        Detail: `Summary says ${auction.approversCount}; transaction history has ${uniqueBidders.size} unique bidders.`,
      });
    }

    bidderStatuses
      .filter((status) => status.readError)
      .forEach((status) => {
        addFlag("statusReadErrors", {
          "Auction #": auction.index,
          "Auction Address": auction.address,
          Description: auction.dataDescription,
          Severity: "Medium",
          Flag: "Bidder status read failed",
          Detail: `${status.bidderAddress}: ${status.readError}`,
        });
      });
  });

  const sellerRows = Array.from(sellerMap.values())
    .map((row) => ({
      ...row,
      "Unique Bidders": row["Unique Bidders"].size,
      "Total Highest Bids (wei)": row["Total Highest Bids (wei)"].toString(),
    }))
    .sort((a, b) => b["Auctions Created"] - a["Auctions Created"]);

  const bidderRows = Array.from(bidderMap.values())
    .map((row) => ({
      ...row,
      "Auctions Participated": row["Auctions Participated"].size,
      "Total Transaction Amount (wei)":
        row["Total Transaction Amount (wei)"].toString(),
      "Current Bid Balance Sum (wei)":
        row["Current Bid Balance Sum (wei)"].toString(),
    }))
    .sort((a, b) =>
      compareWeiDesc(
        a["Total Transaction Amount (wei)"],
        b["Total Transaction Amount (wei)"]
      )
    );
  const participantRows = [
    ...sellerRows.map((row) => ({
      Role: "Seller",
      "Actor Address": row["Seller Address"],
      "Auctions Created": row["Auctions Created"],
      "Open Auctions": row["Open Auctions"],
      "Closed Auctions": row["Closed Auctions"],
      "Auctions With Bids": row["Auctions With Bids"],
      "Total Bid Rows": row["Total Bid Rows"],
      "Unique Bidders": row["Unique Bidders"],
      "Total Highest Bids (wei)": row["Total Highest Bids (wei)"],
      "Pending Seller Payments": row["Pending Seller Payments"],
      "Auctions Participated": "",
      "Bid Transactions": "",
      "Total Transaction Amount (wei)": "",
      "Current Bid Balance Sum (wei)": "",
      "Highest Bidder Statuses": "",
      "Refunded Auctions": "",
      "Status Read Errors": "",
    })),
    ...bidderRows.map((row) => ({
      Role: "Bidder",
      "Actor Address": row["Bidder Address"],
      "Auctions Created": "",
      "Open Auctions": "",
      "Closed Auctions": "",
      "Auctions With Bids": "",
      "Total Bid Rows": "",
      "Unique Bidders": "",
      "Total Highest Bids (wei)": "",
      "Pending Seller Payments": "",
      "Auctions Participated": row["Auctions Participated"],
      "Bid Transactions": row["Bid Transactions"],
      "Total Transaction Amount (wei)": row["Total Transaction Amount (wei)"],
      "Current Bid Balance Sum (wei)": row["Current Bid Balance Sum (wei)"],
      "Highest Bidder Statuses": row["Highest Bidder Statuses"],
      "Refunded Auctions": row["Refunded Auctions"],
      "Status Read Errors": row["Status Read Errors"],
    })),
  ];

  const topAuctionRows = [...reports]
    .sort((a, b) => compareWeiDesc(a.auction.highestBid, b.auction.highestBid))
    .slice(0, 20)
    .map(({ auction, transactions }, index) => ({
      Section: "Top auctions by highest bid",
      Rank: index + 1,
      "Auction #": auction.index,
      "Auction Address": auction.address,
      Description: auction.dataDescription,
      Metric: "Highest Bid (wei)",
      Value: auction.highestBid,
      "Supporting Count": transactions.length,
    }));

  const busiestAuctionRows = [...reports]
    .sort((a, b) => b.transactions.length - a.transactions.length)
    .slice(0, 20)
    .map(({ auction, transactions }, index) => ({
      Section: "Busiest auctions by bid rows",
      Rank: index + 1,
      "Auction #": auction.index,
      "Auction Address": auction.address,
      Description: auction.dataDescription,
      Metric: "Bid Rows",
      Value: transactions.length,
      "Supporting Count": new Set(transactions.map((tx) => tx.bidderKey)).size,
    }));

  const topBidderRows = bidderRows.slice(0, 20).map((row, index) => ({
    Section: "Top bidders by total bid volume",
    Rank: index + 1,
    "Actor Address": row["Bidder Address"],
    Metric: "Total Transaction Amount (wei)",
    Value: row["Total Transaction Amount (wei)"],
    "Supporting Count": row["Auctions Participated"],
  }));
  const zeroBidAuctionRows = reports
    .filter(({ transactions }) => !transactions.length)
    .map(({ auction }, index) => ({
      Section: "Zero-bid auctions",
      Rank: index + 1,
      "Auction #": auction.index,
      "Auction Address": auction.address,
      Description: auction.dataDescription,
      Metric: "Bid Rows",
      Value: 0,
      "Supporting Count": 0,
    }));

  let dictionaryRows = [
    {
      Order: 1,
      Section: "Start Here",
      Term: "What this report is",
      Definition:
        "A chain snapshot for selected auctions. It combines contract summary data, bid history, timeline rows, bidder status reads, payment review, and review flags.",
      "Where It Appears": "Entire workbook",
      "Why It Matters":
        "Start with Auction Summary, then inspect All Bids and Timeline. Use Review Flags for human follow-up.",
      Example: "Use it after an experiment to explain what happened without opening each auction one by one.",
    },
    {
      Order: 2,
      Section: "Sheets",
      Term: "Auction Summary",
      Definition:
        "One row per contract auction, read directly from getSummary and getStatus.",
      "Where It Appears": "Auction Summary",
      "Why It Matters":
        "Use it to confirm seller, winner, highest bid, end time, bidder count, and final payment state.",
      Example: "Auction #12, seller address, highest bid, highest bidder, end time, payment state.",
    },
    {
      Order: 3,
      Section: "Sheets",
      Term: "All Bids",
      Definition:
        "One row per bid transaction returned by getTransactions. Auctions with zero bids also appear here as explicit no-bid rows.",
      "Where It Appears": "All Bids, All Bids CSV",
      "Why It Matters":
        "Use it for participant-level bid review. Rows include merged auction summary fields and Etherscan links.",
      Example: "One bidder can appear more than once when they bid multiple times.",
    },
    {
      Order: 4,
      Section: "Sheets",
      Term: "Timeline",
      Definition:
        "A chronological event list combining auction end times and bid events.",
      "Where It Appears": "Timeline, Timeline CSV",
      "Why It Matters":
        "Use it to understand sequence: when bids happened, when auctions ended, and which participant acted.",
      Example: "Bid at 2026-05-05T16:23:00.000Z, then auction end at 2026-05-05T16:30:00.000Z.",
    },
    {
      Order: 5,
      Section: "Time Fields",
      Term: "Time ISO",
      Definition:
        "UTC timestamp in ISO 8601 format. It is stable for sorting, filtering, comparing, and importing into analysis tools.",
      "Where It Appears": "Timeline, All Bids, Auction Summary",
      "Why It Matters":
        "Local display time can vary by computer timezone; ISO time gives one consistent reference.",
      Example: "2026-05-05T16:23:00.000Z",
    },
    {
      Order: 6,
      Section: "Time Fields",
      Term: "Time",
      Definition:
        "Human-readable local time generated by the browser from the same blockchain timestamp.",
      "Where It Appears": "Timeline, All Bids, Auction Summary",
      "Why It Matters":
        "Useful for quick reading, but ISO should be preferred for exact analysis.",
      Example: "May 5, 2026, 7:23:00 PM depending on the viewer timezone.",
    },
    {
      Order: 7,
      Section: "Auction Metrics",
      Term: "Highest Bid (wei)",
      Definition:
        "The winning cumulative bid value currently stored in the auction summary.",
      "Where It Appears": "Auction Summary, All Bids, Leaderboards",
      "Why It Matters":
        "This is the value used to rank top auctions and identify the winner.",
      Example: "1000 means 1000 wei, not 1000 ETH.",
    },
    {
      Order: 8,
      Section: "Auction Metrics",
      Term: "Minimum Bid (wei)",
      Definition:
        "The minimum required contribution configured when the auction was created.",
      "Where It Appears": "Auction Summary, All Bids",
      "Why It Matters":
        "Use it to validate experiment setup and compare bid behavior across auctions.",
      Example: "If minimum bid is 100, bids below that should not be valid contract bids.",
    },
    {
      Order: 9,
      Section: "Bid Metrics",
      Term: "Transaction Amount (wei)",
      Definition:
        "The amount sent in a single bid transaction.",
      "Where It Appears": "All Bids, Timeline",
      "Why It Matters":
        "This is not always the bidder's final total if they bid more than once.",
      Example: "A bidder sends 200, then later sends 300.",
    },
    {
      Order: 10,
      Section: "Bid Metrics",
      Term: "Cumulative Bid (wei)",
      Definition:
        "Running total per bidder. This is the value compared to highestBid.",
      "Where It Appears": "All Bids, Timeline",
      "Why It Matters":
        "A bidder may bid multiple times; cumulative bid is the bidder's total committed amount in that auction.",
      Example: "A 200 wei bid followed by a 300 wei bid becomes 500 cumulative wei.",
    },
    {
      Order: 11,
      Section: "Bid Metrics",
      Term: "Is Highest Bid",
      Definition:
        "Marks whether that row matches the auction's highestBid and highestBidder after cumulative-bid reconstruction.",
      "Where It Appears": "All Bids",
      "Why It Matters":
        "Use it to identify the bid row that explains the current winner.",
      Example: "Yes when bidder address equals highest bidder and cumulative bid equals highest bid.",
    },
    {
      Order: 12,
      Section: "Bidder Metrics",
      Term: "Number Of Bidders",
      Definition:
        "The bidder count reported by the auction summary.",
      "Where It Appears": "Auction Summary",
      "Why It Matters":
        "Useful for quick experiment participation counts, but Review Flags compares it to transaction-derived unique bidders.",
      Example: "Summary says 4 bidders.",
    },
    {
      Order: 13,
      Section: "Bidder Metrics",
      Term: "Unique Bidders In Transactions",
      Definition:
        "The number of unique bidder addresses found by reading bid transaction history.",
      "Where It Appears": "Auction Summary, Leaderboards",
      "Why It Matters":
        "A cross-check against Number Of Bidders. Differences are flagged for review.",
      Example: "Transactions show 3 unique bidder addresses.",
    },
    {
      Order: 14,
      Section: "Bidder Metrics",
      Term: "Auctions Participated",
      Definition:
        "How many distinct auctions a bidder appears in.",
      "Where It Appears": "Participant Analysis, Leaderboards",
      "Why It Matters":
        "Helps identify active participants across experiments.",
      Example: "A bidder who bid in 5 auctions has Auctions Participated = 5.",
    },
    {
      Order: 15,
      Section: "Bidder Metrics",
      Term: "Total Transaction Amount (wei)",
      Definition:
        "Sum of all bid transaction amounts for that bidder across exported auctions.",
      "Where It Appears": "Participant Analysis, Leaderboards",
      "Why It Matters":
        "Used for top bidders by total bid volume.",
      Example: "200 + 300 + 500 = 1000 wei total transaction amount.",
    },
    {
      Order: 16,
      Section: "Payment Metrics",
      Term: "Payment State",
      Definition:
        "Readable seller-side state derived from end time, highest bid, getStatus, and status read errors.",
      "Where It Appears": "Auction Summary, All Bids",
      "Why It Matters":
        "Separates no-bid auctions, open auctions, finalized seller payments, and pending seller payments.",
      Example: "Seller payment pending means the auction ended with a bid but getStatus is still false.",
    },
    {
      Order: 17,
      Section: "Sheets",
      Term: "Payment Review",
      Definition:
        "Frontend analysis of seller/winner/refund state based on contract reads, now including raw bidder status fields. It does not send transactions.",
      "Where It Appears": "Payment Review, Payment CSV",
      "Why It Matters":
        "Use it to find pending seller payments, winners, refunds, bidder status read errors, and raw status values in one place.",
      Example: "Winner / charged, Refunded, Refund pending, Seller payment finalized, Is Highest Bidder.",
    },
    {
      Order: 18,
      Section: "Sheets",
      Term: "Participant Analysis",
      Definition:
        "Combined actor summary for sellers and bidders. Seller-only and bidder-only metrics share one sheet with a Role column.",
      "Where It Appears": "Participant Analysis",
      "Why It Matters":
        "Use it to review people/accounts across the experiment without jumping between separate seller and bidder sheets.",
      Example: "Role = Seller shows auctions created; Role = Bidder shows auctions participated and bid volume.",
    },
    {
      Order: 19,
      Section: "Payment Metrics",
      Term: "Refunded",
      Definition:
        "Whether getUserAuctionStatus reports that a bidder was refunded for that auction.",
      "Where It Appears": "Payment Review",
      "Why It Matters":
        "Helps explain why a losing bidder no longer has an active bid balance.",
      Example: "Refunded = Yes for a losing bidder after refund logic succeeds.",
    },
    {
      Order: 20,
      Section: "Payment Metrics",
      Term: "Current Bid Balance Sum (wei)",
      Definition:
        "Sum of current bid balances from bidder status reads across exported auctions.",
      "Where It Appears": "Participant Analysis",
      "Why It Matters":
        "Useful for spotting participants who still appear to have refundable or active bid balances.",
      Example: "Two active balances of 100 and 250 become 350 wei.",
    },
    {
      Order: 21,
      Section: "Sheets",
      Term: "Review Flags",
      Definition:
        "Rows that deserve human review, including analysis flags and auction read/export errors.",
      "Where It Appears": "Review Flags",
      "Why It Matters":
        "Treat this as the single operational checklist after an experiment.",
      Example: "No bids recorded, single bidder, bidder count mismatch, highest bid not matched, auction read failed.",
    },
    {
      Order: 22,
      Section: "Leaderboards",
      Term: "Top auctions by highest bid",
      Definition:
        "Ranking of auctions by their stored highestBid value.",
      "Where It Appears": "Leaderboards",
      "Why It Matters":
        "Quickly shows which auctions attracted the largest winning bids.",
      Example: "Rank 1 is the auction with the largest highest bid.",
    },
    {
      Order: 23,
      Section: "Leaderboards",
      Term: "Busiest auctions by bid rows",
      Definition:
        "Ranking of auctions by number of bid transactions.",
      "Where It Appears": "Leaderboards",
      "Why It Matters":
        "Shows where activity was highest, even if final bid values were not.",
      Example: "An auction with 12 bid rows ranks above one with 3 bid rows.",
    },
    {
      Order: 24,
      Section: "Leaderboards",
      Term: "Top bidders by total bid volume",
      Definition:
        "Ranking of bidders by the sum of their transaction amounts across exported auctions.",
      "Where It Appears": "Leaderboards",
      "Why It Matters":
        "Identifies the most financially active participants in the selected data.",
      Example: "A bidder with 5000 total wei ranks above a bidder with 900 total wei.",
    },
    {
      Order: 25,
      Section: "Etherscan",
      Term: "Why Etherscan may look different",
      Definition:
        "Etherscan shows method calls and ETH transfers. Some report rows are decoded from contract state, not separate Etherscan rows.",
      "Where It Appears": "Etherscan URL columns",
      "Why It Matters":
        "Use the Etherscan URLs to verify the auction contract and participant addresses, but compare bids against contract state.",
      Example: "Auction Etherscan URL opens the auction contract address on Sepolia.",
    },
    {
      Order: 26,
      Section: "Budget",
      Term: "Budget at bid moment",
      Definition:
        "The bidder's budget immediately before a bid transaction was charged. New contracts also include Budget After Bid.",
      "Where It Appears": "All Bids, Timeline",
      "Why It Matters":
        "This proves what budget the bidder had at the exact moment of bidding, without reconstructing it from later state.",
      Example: "Budget At Bid Moment = 1800, Budget After Bid = 1500.",
    },
    {
      Order: 27,
      Section: "Units",
      Term: "Wei",
      Definition:
        "The smallest ETH unit. Report values are kept in wei so no precision is lost.",
      "Where It Appears": "All columns ending with (wei)",
      "Why It Matters":
        "Avoids rounding mistakes when comparing blockchain values.",
      Example: "1 ETH = 1,000,000,000,000,000,000 wei.",
    },
    {
      Order: 28,
      Section: "Workbook Structure",
      Term: "No per-auction sheets",
      Definition:
        "Per-auction tabs were intentionally removed so the workbook stays compact and consistent.",
      "Where It Appears": "Workbook tabs",
      "Why It Matters":
        "Filter All Bids, Timeline, or Auction Summary by Auction Address instead of opening separate tabs.",
      Example: "Use Excel filters on Auction Address to isolate one auction.",
    },
  ];

  dictionaryRows = [
    {
      Order: 10,
      Section: "Start Here",
      Term: "Recommended reading order",
      Definition:
        "Start with Review Flags, then Auction Summary, then the source tab named by each flag.",
      "Where It Appears": "README",
      "Why It Matters":
        "This keeps review work focused on the auctions that need attention first.",
      Example: "Review Flags -> All Bids -> Payment Review.",
    },
    {
      Order: 20,
      Section: "Workbook Tabs",
      Term: "Auction Summary",
      Definition:
        "One row per exported auction with seller, end time, highest bid, bidder count, and payment state.",
      "Where It Appears": "Auction Summary",
      "Why It Matters": "Best high-level table for filtering and comparing auctions.",
      Example: "Filter by End Time ISO or Payment State.",
    },
    {
      Order: 30,
      Section: "Workbook Tabs",
      Term: "All Bids",
      Definition:
        "Every decoded bid transaction, merged with auction summary fields and Etherscan URLs. Auctions with no bids appear as explicit zero-bid rows with Row Type = No bids.",
      "Where It Appears": "All Bids, All Bids CSV",
      "Why It Matters":
        "Best tab for proving who bid, when they bid, and what cumulative bid value they reached.",
      Example: "Use Auction Address to isolate one auction.",
    },
    {
      Order: 40,
      Section: "Workbook Tabs",
      Term: "Timeline",
      Definition:
        "Chronological bid, auction-end, and no-bid markers, using the same auction and participant identifiers as the other tabs.",
      "Where It Appears": "Timeline, Timeline CSV",
      "Why It Matters": "Best tab for reconstructing event order.",
      Example: "Sort by Time ISO.",
    },
    {
      Order: 50,
      Section: "Workbook Tabs",
      Term: "Payment Review",
      Definition:
        "Seller, winner, refund, bidder status, and raw status-read fields in one table.",
      "Where It Appears": "Payment Review, Payment CSV",
      "Why It Matters": "Best tab for checking who was paid, charged, refunded, or still pending.",
      Example: "Filter Payment Meaning by Refunded or Seller payment pending.",
    },
    {
      Order: 60,
      Section: "Workbook Tabs",
      Term: "Participant Analysis",
      Definition:
        "Combined seller and bidder rollup with a Role column, so one wallet can be reviewed across roles.",
      "Where It Appears": "Participant Analysis",
      "Why It Matters": "Best tab for account-level analysis.",
      Example: "Role = Bidder shows auction count and bid volume.",
    },
    {
      Order: 70,
      Section: "Workbook Tabs",
      Term: "Review Flags",
      Definition:
        "Single checklist that merges diagnosis flags and read/export errors.",
      "Where It Appears": "Review Flags",
      "Why It Matters": "This is the operational to-do list after generating a report.",
      Example: "No bids recorded, payment issue, read error, or mismatch.",
    },
    {
      Order: 80,
      Section: "Workbook Tabs",
      Term: "Leaderboards",
      Definition:
        "Ranked views for top auctions by highest bid, busiest auctions by bid rows, top bidders by total bid volume, and explicit zero-bid auctions.",
      "Where It Appears": "Leaderboards",
      "Why It Matters": "Fast overview of the most active or highest-value activity.",
      Example: "Rank 1 highest bid auction.",
    },
    {
      Order: 90,
      Section: "Time",
      Term: "Time ISO",
      Definition:
        "UTC ISO 8601 timestamp. Use this for exact sorting, filtering, and comparisons.",
      "Where It Appears": "Auction Summary, All Bids, Timeline",
      "Why It Matters": "It is stable even when browser timezone display changes.",
      Example: "2026-05-05T16:23:00.000Z.",
    },
    {
      Order: 100,
      Section: "Time",
      Term: "Time",
      Definition:
        "Human-readable local time produced by the browser from the same blockchain timestamp.",
      "Where It Appears": "Auction Summary, All Bids, Timeline",
      "Why It Matters": "Good for reading, but not as reliable as Time ISO for analysis.",
      Example: "May 5, 2026, 7:23:00 PM.",
    },
    {
      Order: 110,
      Section: "Units",
      Term: "Wei",
      Definition:
        "Smallest ETH unit. Report values remain in wei to avoid rounding and precision loss.",
      "Where It Appears": "Columns ending with (wei)",
      "Why It Matters": "Blockchain comparisons should use exact integer values.",
      Example: "1 ETH = 1,000,000,000,000,000,000 wei.",
    },
    {
      Order: 120,
      Section: "Bid Metrics",
      Term: "Transaction Amount vs Cumulative Bid",
      Definition:
        "Transaction Amount is one bid payment. Cumulative Bid is that bidder's running total in the auction.",
      "Where It Appears": "All Bids, Timeline",
      "Why It Matters":
        "The winner is determined by cumulative bid, not necessarily one individual transaction.",
      Example: "200 wei + 300 wei = 500 cumulative wei.",
    },
    {
      Order: 130,
      Section: "Bid Metrics",
      Term: "Is Highest Bid",
      Definition:
        "Marks the row that matches both the stored highest bidder and reconstructed cumulative highest bid.",
      "Where It Appears": "All Bids",
      "Why It Matters": "Fastest way to locate the bid row explaining the current winner.",
      Example: "Yes when bidder and cumulative value match the auction summary.",
    },
    {
      Order: 140,
      Section: "Payment Metrics",
      Term: "Payment State",
      Definition:
        "Seller-side state derived from end time, highest bid, contract closed status, and read errors.",
      "Where It Appears": "Auction Summary, Payment Review",
      "Why It Matters": "Separates open, no-bid, pending payment, finalized, and unknown states.",
      Example: "Ended with bid but not closed = seller payment pending.",
    },
    {
      Order: 150,
      Section: "Payment Metrics",
      Term: "Refunded",
      Definition:
        "Whether getUserAuctionStatus reports that a bidder was refunded for that auction.",
      "Where It Appears": "Payment Review",
      "Why It Matters": "Explains losing-bidder payment status and remaining bid balance.",
      Example: "Refunded = Yes.",
    },
    {
      Order: 160,
      Section: "Diagnostics",
      Term: "Mismatch checks",
      Definition:
        "Highest-bid and bidder-count checks compare contract summary values to reconstructed transaction history.",
      "Where It Appears": "Review Flags",
      "Why It Matters": "Differences usually mean the auction needs manual review or a failed read affected reconstruction.",
      Example: "Summary says 4 bidders, transactions show 3.",
    },
    {
      Order: 170,
      Section: "Diagnostics",
      Term: "Read errors",
      Definition:
        "Failed auction, status, or payment reads are merged into Review Flags instead of a separate errors tab.",
      "Where It Appears": "Review Flags",
      "Why It Matters": "One checklist is easier to audit than separate warning tabs.",
      Example: "Auction read failed for 0x...",
    },
    {
      Order: 180,
      Section: "Contract Compatibility",
      Term: "Budget at bid moment",
      Definition:
        "Newly deployed contracts store budgetBefore and budgetAfter in each Bid. Older deployed auctions do not have those fields, so the report marks them unavailable.",
      "Where It Appears": "All Bids, Timeline",
      "Why It Matters":
        "Mixed reports can include old and new auctions without hiding missing historical budget data.",
      Example: "Old auction: unavailable. New auction: budget values are filled.",
    },
    {
      Order: 190,
      Section: "Workbook Structure",
      Term: "No per-auction tabs",
      Definition:
        "Auction-specific tabs were removed. Filter by Auction Address instead.",
      "Where It Appears": "Auction Summary, All Bids, Timeline, Payment Review",
      "Why It Matters": "Keeps the workbook compact and consistent for large experiments.",
      Example: "Use Excel filters on Auction Address.",
    },
  ];

  const reviewFlagRows = flagRows.map((row) => ({
    "Issue Source": "Analysis Flag",
    "Issue Type": row.Flag || "Review flag",
    ...row,
  }));
  const readErrorRows = errors.map((error) => ({
    "Issue Source": "Read Error",
    "Issue Type": "Auction read failed",
    "Auction #": error["Auction #"] || "",
    "Auction Address": error["Auction Address"] || "",
    Description: error.Description || "",
    Severity: "High",
    Flag: "Auction read failed",
    Detail: error.Error || error.Detail || "Auction report read failed",
  }));
  const mergedFlagRows = [
    ...reviewFlagRows,
    ...(shouldIncludeOption(options, "diagnostics", "readErrors")
      ? readErrorRows
      : []),
  ];

  return {
    sellerRows,
    bidderRows,
    participantRows,
    paymentRows,
    flagRows: mergedFlagRows.length
      ? mergedFlagRows
      : [
          {
            "Issue Source": "None",
            "Issue Type": "No review flags",
            Severity: "Info",
            Flag: "No review flags",
            Detail: "",
          },
        ],
    leaderboardRows: [
      ...topAuctionRows,
      ...busiestAuctionRows,
      ...topBidderRows,
      ...zeroBidAuctionRows,
    ],
    dictionaryRows,
  };
};

const buildCoreReportTables = (reports, errors, generatedAt, options = {}) => {
  const summaryRows = reports.map(({ auction, ended, transactions }) => ({
    "Auction #": auction.index,
    "Auction Address": auction.address,
    "Etherscan URL": `${SEPOLIA_ADDRESS_URL}${auction.address}`,
    Description: auction.dataDescription,
    "Data For Sale": auction.dataForSell,
    "Seller Address": auction.seller,
    "Minimum Bid (wei)": auction.minimumContribution,
    "Highest Bid (wei)": auction.highestBid,
    "Highest Bidder": auction.highestBidder,
    "Number Of Bidders": auction.approversCount,
    "Unique Bidders In Transactions": new Set(
      transactions.map((tx) => tx.bidderKey)
    ).size,
    "End Time": toDateTime(auction.endTime),
    "End Time ISO": toIsoDateTime(auction.endTime),
    "Auction Status": ended ? "Closed" : "Open",
    "Payment Finalized": auction.closed ? "Yes" : "No",
    "Payment State": getSellerPaymentState(auction, ended),
    "Payment Status Read Error": auction.closedReadError,
    "Generated At": generatedAt,
  }));
  const allBidRows = reports.flatMap(({ auction, ended, transactions }) => {
    const auctionFields = {
      "Auction #": auction.index,
      "Auction Address": auction.address,
      "Auction Etherscan URL": `${SEPOLIA_ADDRESS_URL}${auction.address}`,
      Description: auction.dataDescription,
      "Data For Sale": auction.dataForSell,
      "Seller Address": auction.seller,
      "Seller Etherscan URL": `${SEPOLIA_ADDRESS_URL}${auction.seller}`,
      "Minimum Bid (wei)": auction.minimumContribution,
      "Auction Highest Bid (wei)": auction.highestBid,
      "Auction Highest Bidder": auction.highestBidder,
      "Highest Bidder Etherscan URL": auction.highestBidder
        ? `${SEPOLIA_ADDRESS_URL}${auction.highestBidder}`
        : "",
      "Auction End Time": toDateTime(auction.endTime),
      "Auction End Time ISO": toIsoDateTime(auction.endTime),
      "Auction Status": ended ? "Closed" : "Open",
      "Payment State": getSellerPaymentState(auction, ended),
    };

    if (!transactions.length) {
      return [
        {
          ...auctionFields,
          "Row Type": "No bids",
          "Bid #": 0,
          "Bidder Address": "No bidder",
          "Bidder Etherscan URL": "",
          "Transaction Amount (wei)": 0,
          "Cumulative Bid (wei)": 0,
          "Budget At Bid Moment (wei)": "",
          "Budget After Bid (wei)": "",
          "Budget At Bid Moment Source": "No bid transaction",
          "Previous Highest Bidder": "",
          "Previous Highest Bid (wei)": "",
          "Bid Time": "",
          "Bid Time ISO": "",
          "Is Highest Bid": "No",
          Note: "This auction has zero bid transactions.",
        },
      ];
    }

    return transactions.map((tx, txIndex) => ({
      ...auctionFields,
      "Row Type": "Bid",
      "Bid #": txIndex + 1,
      "Bidder Address": tx.bidder,
      "Bidder Etherscan URL": `${SEPOLIA_ADDRESS_URL}${tx.bidder}`,
      "Transaction Amount (wei)": tx.transactionAmountWei,
      "Cumulative Bid (wei)": tx.cumulativeBidWei,
      "Contract Cumulative Bid (wei)": tx.contractCumulativeBidWei,
      "Budget At Bid Moment (wei)": tx.budgetBeforeBidWei,
      "Budget After Bid (wei)": tx.budgetAfterBidWei,
      "Budget At Bid Moment Source": tx.budgetSnapshotSource,
      "Previous Highest Bidder": tx.previousHighestBidder,
      "Previous Highest Bid (wei)": tx.previousHighestBidWei,
      "Bid Time": tx.time,
      "Bid Time ISO": tx.isoTime,
      "Is Highest Bid": tx.isHighestBid ? "Yes" : "No",
      Note: "",
    }));
  });
  const timelineRows = [
    ...reports.map(({ auction }) => ({
      "Time ISO": toIsoDateTime(auction.endTime),
      Time: toDateTime(auction.endTime),
      "Event Type": "Auction End Time",
      "Auction #": auction.index,
      "Auction Address": auction.address,
      "Auction Etherscan URL": `${SEPOLIA_ADDRESS_URL}${auction.address}`,
      Description: auction.dataDescription,
      Actor: "",
      "Actor Etherscan URL": "",
      "Amount (wei)": "",
      "Cumulative Bid (wei)": "",
      "Budget At Bid Moment (wei)": "",
      "Budget After Bid (wei)": "",
      "Budget At Bid Moment Source": "",
    })),
    ...reports.flatMap(({ auction, transactions }) =>
      transactions.map((tx) => ({
        "Time ISO": tx.isoTime,
        Time: tx.time,
        "Event Type": "Bid",
        "Auction #": auction.index,
        "Auction Address": auction.address,
        "Auction Etherscan URL": `${SEPOLIA_ADDRESS_URL}${auction.address}`,
        Description: auction.dataDescription,
        Actor: tx.bidder,
        "Actor Etherscan URL": `${SEPOLIA_ADDRESS_URL}${tx.bidder}`,
        "Amount (wei)": tx.transactionAmountWei,
        "Cumulative Bid (wei)": tx.cumulativeBidWei,
        "Budget At Bid Moment (wei)": tx.budgetBeforeBidWei,
        "Budget After Bid (wei)": tx.budgetAfterBidWei,
        "Budget At Bid Moment Source": tx.budgetSnapshotSource,
      }))
    ),
    ...reports
      .filter(({ transactions }) => !transactions.length)
      .map(({ auction }) => ({
        "Time ISO": toIsoDateTime(auction.endTime),
        Time: toDateTime(auction.endTime),
        "Event Type": "No Bid Activity",
        "Auction #": auction.index,
        "Auction Address": auction.address,
        "Auction Etherscan URL": `${SEPOLIA_ADDRESS_URL}${auction.address}`,
        Description: auction.dataDescription,
        Actor: "No bidder",
        "Actor Etherscan URL": "",
        "Amount (wei)": 0,
        "Cumulative Bid (wei)": 0,
        "Budget At Bid Moment (wei)": "",
        "Budget After Bid (wei)": "",
        "Budget At Bid Moment Source": "No bid transaction",
      })),
  ].sort((a, b) => String(a["Time ISO"]).localeCompare(String(b["Time ISO"])));

  return {
    generatedAt,
    summaryRows,
    allBidRows,
    timelineRows,
    analysis: buildReportAnalysis(reports, errors, options),
  };
};

export const buildReportSheets = (reports, errors, options = {}) => {
  const generatedAt = new Date().toLocaleString();
  const {
    summaryRows,
    allBidRows,
    timelineRows,
    analysis,
  } = buildCoreReportTables(reports, errors, generatedAt, options);
  const totalBidRows = reports.reduce(
    (total, { transactions }) => total + transactions.length,
    0
  );
  const zeroBidAuctions = reports.filter(
    ({ transactions }) => !transactions.length
  ).length;
  const readmeRows = [
    {
      Order: 1,
      Section: "Overview",
      Term: "What this file is",
      Definition:
        "This report is a human-readable snapshot of the selected auction contracts at the moment it was generated. It is designed to help review experiment results, bids, participant activity, payment state, and anything that needs follow-up without opening each auction manually.",
      "Where It Appears": "README",
      "Why It Matters": "Gives context before reading the data tabs.",
      Example:
        "Use this workbook after an experiment or market session to understand what happened.",
    },
    {
      Order: 2,
      Section: "Overview",
      Term: "How to use it",
      Definition:
        "Start with Review Flags for issues, use Auction Summary for the market overview, then open All Bids, Timeline, Payment Review, or Participant Analysis when you need evidence for a specific auction or account.",
      "Where It Appears": "README",
      "Why It Matters": "Turns the workbook into a review flow instead of a pile of sheets.",
      Example:
        "Review Flags -> Auction Summary -> All Bids filtered by Auction Address.",
    },
    {
      Order: 3,
      Section: "Overview",
      Term: "Important note",
      Definition:
        "The report is read-only analysis. It does not change contracts, send transactions, pay sellers, refund bidders, or modify budgets.",
      "Where It Appears": "README",
      "Why It Matters": "Clarifies that exporting a report is safe and observational.",
      Example: "Payment rows describe state; they do not perform payment actions.",
    },
    {
      Order: 10,
      Section: "Report Info",
      Term: "Generated At",
      Definition: generatedAt,
      "Where It Appears": "README",
      "Why It Matters": "Shows when this export snapshot was produced.",
      Example: "",
    },
    {
      Order: 11,
      Section: "Report Info",
      Term: "Auctions Exported",
      Definition: reports.length,
      "Where It Appears": "README",
      "Why It Matters": "The number of auction contracts included after filters and optional selection.",
      Example: "",
    },
    {
      Order: 12,
      Section: "Report Info",
      Term: "Auctions With Read Errors",
      Definition: errors.length,
      "Where It Appears": "README, Review Flags",
      "Why It Matters": "Read errors are merged into Review Flags so there is one checklist.",
      Example: "",
    },
    {
      Order: 13,
      Section: "Report Info",
      Term: "Total Bid Rows",
      Definition: totalBidRows,
      "Where It Appears": "README, All Bids",
      "Why It Matters": "Counts all bid transactions exported across selected auctions.",
      Example: "",
    },
    {
      Order: 14,
      Section: "Report Info",
      Term: "Zero-Bid Auctions",
      Definition: zeroBidAuctions,
      "Where It Appears": "README, All Bids, Review Flags",
      "Why It Matters": "Auctions with zero bids still appear explicitly so they are not silently hidden.",
      Example: "",
    },
    ...analysis.dictionaryRows,
  ];

  return filterSheets(
    [
      { key: "readme", name: "README", rows: readmeRows },
      { key: "summary", name: "Auction Summary", rows: summaryRows },
      { key: "bids", name: "All Bids", rows: allBidRows },
      { key: "timeline", name: "Timeline", rows: timelineRows },
      { key: "payments", name: "Payment Review", rows: analysis.paymentRows },
      {
        key: "participants",
        name: "Participant Analysis",
        rows: analysis.participantRows,
      },
      { key: "flags", name: "Review Flags", rows: analysis.flagRows },
      { key: "leaderboards", name: "Leaderboards", rows: analysis.leaderboardRows },
    ],
    options
  ).map(({ name, rows }) => ({ name, rows }));
};

export const buildReportPayload = (reports, errors, options = {}) => {
  const generatedDate = new Date();
  const generatedAt = generatedDate.toLocaleString();
  const tables = buildCoreReportTables(reports, errors, generatedAt, options);
  const includeSection = (key) => options.sections?.[key] !== false;
  const selectedTables = {
    ...(includeSection("summary") ? { summaryRows: tables.summaryRows } : {}),
    ...(includeSection("bids") ? { allBidRows: tables.allBidRows } : {}),
    ...(includeSection("timeline") ? { timelineRows: tables.timelineRows } : {}),
    analysis: {
      ...(includeSection("readme")
        ? { dictionaryRows: tables.analysis.dictionaryRows }
        : {}),
      ...(includeSection("payments")
        ? { paymentRows: tables.analysis.paymentRows }
        : {}),
      ...(includeSection("participants")
        ? { participantRows: tables.analysis.participantRows }
        : {}),
      ...(includeSection("flags") ? { flagRows: tables.analysis.flagRows } : {}),
      ...(includeSection("leaderboards")
        ? { leaderboardRows: tables.analysis.leaderboardRows }
        : {}),
    },
  };
  const uniqueBidders = new Set();
  let totalBidValue = 0n;
  let totalHighestBid = 0n;
  let bidRows = 0;

  reports.forEach(({ auction, transactions }) => {
    totalHighestBid += toBigIntSafe(auction.highestBid);
    bidRows += transactions.length;
    transactions.forEach((tx) => {
      uniqueBidders.add(tx.bidderKey);
      totalBidValue += toBigIntSafe(tx.transactionAmountWei);
    });
  });

  return {
    generatedAt,
    generatedAtIso: generatedDate.toISOString(),
    options,
    totals: {
      auctions: reports.length,
      auctionsWithErrors: errors.length,
      bidRows,
      zeroBidAuctions: reports.filter(({ transactions }) => !transactions.length)
        .length,
      uniqueBidders: uniqueBidders.size,
      totalBidValueWei: totalBidValue.toString(),
      totalHighestBidWei: totalHighestBid.toString(),
      pendingSellerPayments: tables.analysis.flagRows.filter(
        (row) => row.Flag === "Seller payment pending"
      ).length,
    },
    tables: selectedTables,
    auctions: reports.map(({ auction, ended, transactions, bidderStatuses }) => ({
      auction,
      ended,
      transactions,
      bidderStatuses,
    })),
    errors,
  };
};

const renderHtmlTable = (title, rows = [], limit = 20) => {
  const safeRows = rows.slice(0, limit);
  if (!safeRows.length) return "";
  const headers = Array.from(
    safeRows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );

  return `<section>
    <h2>${escapeXml(title)}</h2>
    <table>
      <thead><tr>${headers
        .map((header) => `<th>${escapeXml(header)}</th>`)
        .join("")}</tr></thead>
      <tbody>${safeRows
        .map(
          (row) =>
            `<tr>${headers
              .map((header) => `<td>${escapeXml(row[header])}</td>`)
              .join("")}</tr>`
        )
        .join("")}</tbody>
    </table>
  </section>`;
};

export const downloadHtmlReport = (payload) => {
  const { totals, tables } = payload;
  const showSection = (key) => payload.options?.sections?.[key] !== false;
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Auction Admin Report</title>
  <style>
    body { font-family: Arial, sans-serif; color: #07105c; margin: 32px; }
    h1 { margin-bottom: 4px; }
    h2 { margin-top: 32px; }
    .meta { color: #5e638a; margin-bottom: 24px; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .card { border: 1px solid #d9dcef; border-radius: 8px; padding: 12px; }
    .label { color: #5e638a; font-size: 12px; text-transform: uppercase; }
    .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border-bottom: 1px solid #e2e4f1; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4fb; }
  </style>
</head>
<body>
  <h1>Auction Admin Report</h1>
  <div class="meta">Generated ${escapeXml(payload.generatedAt)}</div>
  <div class="cards">
    <div class="card"><div class="label">Auctions</div><div class="value">${escapeXml(
      totals.auctions
    )}</div></div>
    <div class="card"><div class="label">Bid Rows</div><div class="value">${escapeXml(
      totals.bidRows
    )}</div></div>
    <div class="card"><div class="label">Unique Bidders</div><div class="value">${escapeXml(
      totals.uniqueBidders
    )}</div></div>
    <div class="card"><div class="label">Total Bid Value Wei</div><div class="value">${escapeXml(
      totals.totalBidValueWei
    )}</div></div>
    <div class="card"><div class="label">Pending Seller Payments</div><div class="value">${escapeXml(
      totals.pendingSellerPayments
    )}</div></div>
    <div class="card"><div class="label">Read Errors</div><div class="value">${escapeXml(
      totals.auctionsWithErrors
    )}</div></div>
  </div>
  ${showSection("flags") ? renderHtmlTable("Review Flags", tables.analysis.flagRows, 30) : ""}
  ${showSection("leaderboards") ? renderHtmlTable("Leaderboards", tables.analysis.leaderboardRows, 40) : ""}
  ${showSection("participants") ? renderHtmlTable("Participant Analysis", tables.analysis.participantRows, 40) : ""}
  ${showSection("payments") ? renderHtmlTable("Payment Review", tables.analysis.paymentRows, 40) : ""}
  ${showSection("summary") ? renderHtmlTable("Auction Summary", tables.summaryRows, 50) : ""}
  ${showSection("timeline") ? renderHtmlTable("Timeline", tables.timelineRows, 50) : ""}
  ${showSection("bids") ? renderHtmlTable("All Bids", tables.allBidRows, 50) : ""}
</body>
</html>`;

  downloadBlob(html, "text/html;charset=utf-8;", "html", "printable-report");
};
