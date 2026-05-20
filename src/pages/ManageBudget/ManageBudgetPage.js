/* eslint-env es2020 */
import {
  Button,
  TextField,
  Typography,
  Box,
  LinearProgress,
  Divider,
  Checkbox,
  CircularProgress,
} from "@mui/material";
import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import toast from "react-hot-toast";
import factory from "../../real_ethereum/factory";
import { getDefaultBudget } from "../../real_ethereum/budget";
import { readOnlyCall } from "../../real_ethereum/readOnly";

const LOCAL_STORAGE_KEY = "globalBudgetStore";
const ADMIN_SECRET = "1234"; // Do not store production secrets on the frontend.
const REPORT_CONCURRENCY = 3;
const BIDDER_STATUS_CONCURRENCY = 4;
const BULK_DRAFT_KEY = "bulkAuctionDraft";
const BULK_MAX_AUCTIONS = 30;
const SEPOLIA_ADDRESS_URL = "https://sepolia.etherscan.io/address/";
const INVALID_SHEET_NAME_CHARS = new Set(["[", "]", ":", "*", "?", "/", "\\"]);

export const saveBudget = (budget) => {
  localStorage.setItem(
    LOCAL_STORAGE_KEY,
    JSON.stringify({ defaultBudget: budget })
  );
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mapWithConcurrency = async (items, limit, mapper) => {
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

const normalizeSheetName = (name, fallback) => {
  const clean = String(name || fallback)
    .split("")
    .map((char) => (INVALID_SHEET_NAME_CHARS.has(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return (clean || fallback).slice(0, 31);
};

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

const toDateInputValue = (seconds) => {
  const iso = toIsoDateTime(seconds);
  return iso ? iso.slice(0, 10) : "";
};

const shortAddress = (address) =>
  address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";

const splitBulkLine = (line) => {
  if (line.includes("|")) return line.split("|").map((part) => part.trim());
  if (line.includes("\t")) return line.split("\t").map((part) => part.trim());
  return line.split(",").map((part) => part.trim());
};

const isHeaderLine = (parts) => {
  const normalized = parts.join(" ").toLowerCase();
  return (
    normalized.includes("description") &&
    normalized.includes("minimum") &&
    normalized.includes("duration")
  );
};

const parseBulkAuctions = (text) =>
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

const serializeBulkAuctions = (auctions) =>
  auctions
    .map(
      (auction) =>
        `${auction.dataDescription || ""} | ${auction.dataForSell || ""} | ${
          auction.minimumContribution || ""
        } | ${auction.auctionDuration || ""}`
    )
    .join("\n");

const makeBulkAuctionRows = ({
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

const getAuctionValidationError = (auction, label = "Auction") => {
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

  if (!auction.dataForSell.trim()) {
    return `${label}: data for sale cannot be empty.`;
  }

  if (!auction.dataDescription.trim()) {
    return `${label}: description cannot be empty.`;
  }

  return "";
};

const requestConnectedAccount = async () => {
  const accounts = await window.ethereum.request({
    method: "eth_requestAccounts",
  });
  const account = accounts?.[0];

  if (!account) {
    throw new Error("No wallet account is connected.");
  }

  return account;
};

const getTransactionErrorMessage = (err) => {
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

const getDateRangeMs = (filters) => {
  const fromMs = filters.from
    ? new Date(`${filters.from}T00:00:00`).getTime()
    : null;
  const toMs = filters.to ? new Date(`${filters.to}T23:59:59`).getTime() : null;
  return { fromMs, toMs };
};

const isEndTimeInDateRange = (endTime, filters) => {
  const endMs = Number(endTime || 0) * 1000;
  const { fromMs, toMs } = getDateRangeMs(filters);

  if (!endMs) return false;
  if (fromMs !== null && endMs < fromMs) return false;
  if (toMs !== null && endMs > toMs) return false;
  return true;
};

const filterReportsByDate = (reports, filters) => {
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
  const headerXml = `<Row>${headers
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

  return `<Worksheet ss:Name="${escapeXml(name)}"><Table>${headerXml}${bodyXml}</Table></Worksheet>`;
};

const buildWorkbook = (sheets) =>
  `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
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

const downloadWorkbook = (sheets) => {
  downloadBlob(
    buildWorkbook(sheets),
    "application/vnd.ms-excel;charset=utf-8;",
    "xls",
    "workbook"
  );
};

const downloadJsonReport = (payload) => {
  downloadBlob(
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8;",
    "json",
    "raw-data"
  );
};

const toBigIntSafe = (value) => {
  try {
    return BigInt(value || 0);
  } catch (error) {
    return 0n;
  }
};

const hasWei = (value) => toBigIntSafe(value) > 0n;

const compareWeiDesc = (left, right) => {
  const leftValue = toBigIntSafe(left);
  const rightValue = toBigIntSafe(right);
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? -1 : 1;
};

const normalizeTransactions = (rawTransactions, highestBid, highestBidder) => {
  const normalized = rawTransactions.map((tx, idx) => ({
    idx,
    bidder: tx.bidderAddress,
    bidderKey: tx.bidderAddress.toLowerCase(),
    value: BigInt(tx.value || 0),
    time: BigInt(tx.time || 0),
  }));
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
    timeSeconds: tx.time.toString(),
    time: toDateTime(tx.time),
    isoTime: toIsoDateTime(tx.time),
    isHighestBid:
      Boolean(highestBidderKey) &&
      tx.bidderKey === highestBidderKey &&
      cumulativeByIndex[index] === highestBidValue,
  }));
};

const readAuctionOption = async (address, index) => {
  const summary = await readOnlyCall(({ campaign }) =>
    campaign(address).methods.getSummary()
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

const readAuctionReport = async (
  address,
  index,
  total,
  onProgress,
  progressIndex = index
) => {
  onProgress?.(`Reading auction ${progressIndex + 1} of ${total}`);

  const [summary, rawTransactions, closedResult] = await Promise.all([
    readOnlyCall(({ campaign }) => campaign(address).methods.getSummary()),
    readOnlyCall(({ campaign }) => campaign(address).methods.getTransactions()).catch(
      () => []
    ),
    readOnlyCall(({ campaign }) => campaign(address).methods.getStatus()).catch(
      (error) => ({
        readError: error.message || "Auction status read failed",
      })
    ),
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
        const status = await readOnlyCall(({ campaign }) =>
          campaign(address).methods.getUserAuctionStatus(bidder)
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

const buildReportAnalysis = (reports, errors) => {
  const sellerMap = new Map();
  const bidderMap = new Map();
  const paymentRows = [];
  const flagRows = [];

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
      "Current Bid (wei)": "",
      Refunded: "",
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
        "Current Bid (wei)": status.currentBidWei,
        Refunded: status.refunded,
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
      flagRows.push({
        "Auction #": auction.index,
        "Auction Address": auction.address,
        Description: auction.dataDescription,
        Severity: "Info",
        Flag: "No bids recorded",
        Detail: "Auction has no bid transactions.",
      });
    }

    if (uniqueBidders.size === 1) {
      flagRows.push({
        "Auction #": auction.index,
        "Auction Address": auction.address,
        Description: auction.dataDescription,
        Severity: "Info",
        Flag: "Single bidder",
        Detail: "Only one unique bidder appears in the transaction history.",
      });
    }

    if (ended && hasWei(auction.highestBid) && !auction.closed) {
      flagRows.push({
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
      flagRows.push({
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
      flagRows.push({
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
        flagRows.push({
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

  const dictionaryRows = [
    {
      Field: "Auction Summary",
      Meaning:
        "One row per contract auction, read directly from getSummary and getStatus.",
    },
    {
      Field: "All Bids",
      Meaning:
        "One row per bid transaction returned by the auction contract getTransactions method.",
    },
    {
      Field: "Cumulative Bid",
      Meaning:
        "Running total per bidder. This is the value compared to highestBid.",
    },
    {
      Field: "Payment Review",
      Meaning:
        "Frontend analysis of seller/winner/refund state based on contract reads; it does not send transactions.",
    },
    {
      Field: "Flags",
      Meaning:
        "Rows that deserve human review, such as pending seller payment or mismatched bidder counts.",
    },
    {
      Field: "Etherscan",
      Meaning:
        "Etherscan shows method calls and ETH transfers. Some report rows are decoded from contract state, not separate Etherscan rows.",
    },
  ];

  return {
    sellerRows,
    bidderRows,
    paymentRows,
    flagRows: flagRows.length
      ? flagRows
      : [{ Severity: "Info", Flag: "No review flags", Detail: "" }],
    leaderboardRows: [...topAuctionRows, ...busiestAuctionRows, ...topBidderRows],
    dictionaryRows,
    errorRows: errors.length
      ? errors
      : [{ Notice: "No auction read errors during export" }],
  };
};

const buildCoreReportTables = (reports, errors, generatedAt) => {
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
  const allBidRows = reports.flatMap(({ auction, transactions }) =>
    transactions.map((tx, txIndex) => ({
      "Auction #": auction.index,
      "Auction Address": auction.address,
      Description: auction.dataDescription,
      "Bid #": txIndex + 1,
      "Bidder Address": tx.bidder,
      "Transaction Amount (wei)": tx.transactionAmountWei,
      "Cumulative Bid (wei)": tx.cumulativeBidWei,
      "Bid Time": tx.time,
      "Bid Time ISO": tx.isoTime,
      "Is Highest Bid": tx.isHighestBid ? "Yes" : "No",
    }))
  );
  const timelineRows = [
    ...reports.map(({ auction }) => ({
      "Time ISO": toIsoDateTime(auction.endTime),
      Time: toDateTime(auction.endTime),
      "Event Type": "Auction End Time",
      "Auction #": auction.index,
      "Auction Address": auction.address,
      Description: auction.dataDescription,
      Actor: "",
      "Amount (wei)": "",
      "Cumulative Bid (wei)": "",
    })),
    ...reports.flatMap(({ auction, transactions }) =>
      transactions.map((tx) => ({
        "Time ISO": tx.isoTime,
        Time: tx.time,
        "Event Type": "Bid",
        "Auction #": auction.index,
        "Auction Address": auction.address,
        Description: auction.dataDescription,
        Actor: tx.bidder,
        "Amount (wei)": tx.transactionAmountWei,
        "Cumulative Bid (wei)": tx.cumulativeBidWei,
      }))
    ),
  ].sort((a, b) => String(a["Time ISO"]).localeCompare(String(b["Time ISO"])));
  const bidderStatusRows = reports.flatMap(({ auction, bidderStatuses }) =>
    bidderStatuses.map((status) => ({
      "Auction #": auction.index,
      "Auction Address": auction.address,
      Description: auction.dataDescription,
      "Bidder Address": status.bidderAddress,
      Participated: status.participated,
      "Current Bid (wei)": status.currentBidWei,
      Refunded: status.refunded,
      "Is Seller": status.isSeller,
      "Is Highest Bidder": status.isHighestBidder,
      "Payment Review": getBidderPaymentState(
        auction,
        Number(auction.endTime) * 1000 <= Date.now(),
        status
      ),
      "Read Error": status.readError,
    }))
  );

  return {
    generatedAt,
    summaryRows,
    allBidRows,
    timelineRows,
    bidderStatusRows,
    analysis: buildReportAnalysis(reports, errors),
  };
};

const buildReportSheets = (reports, errors) => {
  const generatedAt = new Date().toLocaleString();
  const {
    summaryRows,
    allBidRows,
    timelineRows,
    bidderStatusRows,
    analysis,
  } = buildCoreReportTables(reports, errors, generatedAt);
  const usedSheetNames = new Set([
    "Report Info",
    "Auction Summary",
    "All Bids",
    "Timeline",
    "Bidder Statuses",
    "Seller Analysis",
    "Bidder Analysis",
    "Payment Review",
    "Review Flags",
    "Leaderboards",
    "Analysis Guide",
    "Errors",
  ]);
  const perAuctionSheets = reports.map(({ auction, transactions }) => {
    const baseName = normalizeSheetName(
      `A${auction.index} ${auction.dataDescription}`,
      `Auction ${auction.index}`
    );
    let sheetName = baseName;
    let duplicateIndex = 2;

    while (usedSheetNames.has(sheetName)) {
      const suffix = ` ${duplicateIndex}`;
      sheetName = `${baseName.slice(0, 31 - suffix.length)}${suffix}`;
      duplicateIndex += 1;
    }
    usedSheetNames.add(sheetName);

    return {
      name: sheetName,
      rows: transactions.length
        ? transactions.map((tx, txIndex) => ({
            "Bid #": txIndex + 1,
            "Bidder Address": tx.bidder,
            "Transaction Amount (wei)": tx.transactionAmountWei,
            "Cumulative Bid (wei)": tx.cumulativeBidWei,
            "Bid Time": tx.time,
            "Bid Time ISO": tx.isoTime,
            "Is Highest Bid": tx.isHighestBid ? "Yes" : "No",
          }))
        : [
            {
              "Auction Address": auction.address,
              Description: auction.dataDescription,
              Notice: "No bids found for this auction",
            },
          ],
    };
  });

  return [
    {
      name: "Report Info",
      rows: [
        { Field: "Generated At", Value: generatedAt },
        { Field: "Auctions Exported", Value: reports.length },
        { Field: "Auctions With Errors", Value: errors.length },
        { Field: "Total Bid Rows", Value: allBidRows.length },
        { Field: "Report Products", Value: "Workbook, printable HTML, JSON" },
      ],
    },
    { name: "Auction Summary", rows: summaryRows },
    { name: "All Bids", rows: allBidRows },
    { name: "Timeline", rows: timelineRows },
    { name: "Bidder Statuses", rows: bidderStatusRows },
    { name: "Seller Analysis", rows: analysis.sellerRows },
    { name: "Bidder Analysis", rows: analysis.bidderRows },
    { name: "Payment Review", rows: analysis.paymentRows },
    { name: "Review Flags", rows: analysis.flagRows },
    { name: "Leaderboards", rows: analysis.leaderboardRows },
    { name: "Analysis Guide", rows: analysis.dictionaryRows },
    { name: "Errors", rows: analysis.errorRows },
    ...perAuctionSheets,
  ];
};

const buildReportPayload = (reports, errors) => {
  const generatedDate = new Date();
  const generatedAt = generatedDate.toLocaleString();
  const tables = buildCoreReportTables(reports, errors, generatedAt);
  const uniqueBidders = new Set();
  let totalBidValue = 0n;
  let totalHighestBid = 0n;

  reports.forEach(({ auction, transactions }) => {
    totalHighestBid += toBigIntSafe(auction.highestBid);
    transactions.forEach((tx) => {
      uniqueBidders.add(tx.bidderKey);
      totalBidValue += toBigIntSafe(tx.transactionAmountWei);
    });
  });

  return {
    generatedAt,
    generatedAtIso: generatedDate.toISOString(),
    totals: {
      auctions: reports.length,
      auctionsWithErrors: errors.length,
      bidRows: tables.allBidRows.length,
      uniqueBidders: uniqueBidders.size,
      totalBidValueWei: totalBidValue.toString(),
      totalHighestBidWei: totalHighestBid.toString(),
      pendingSellerPayments: tables.analysis.flagRows.filter(
        (row) => row.Flag === "Seller payment pending"
      ).length,
    },
    tables,
    auctions: reports.map(({ auction, ended, transactions, bidderStatuses }) => ({
      auction,
      ended,
      transactions,
      bidderStatuses,
    })),
    errors,
  };
};

const renderHtmlTable = (title, rows, limit = 20) => {
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

const downloadHtmlReport = (payload) => {
  const { totals, tables } = payload;
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
  ${renderHtmlTable("Review Flags", tables.analysis.flagRows, 30)}
  ${renderHtmlTable("Leaderboards", tables.analysis.leaderboardRows, 40)}
  ${renderHtmlTable("Seller Analysis", tables.analysis.sellerRows, 30)}
  ${renderHtmlTable("Bidder Analysis", tables.analysis.bidderRows, 30)}
  ${renderHtmlTable("Auction Summary", tables.summaryRows, 50)}
</body>
</html>`;

  downloadBlob(html, "text/html;charset=utf-8;", "html", "printable-report");
};

const ManageBudgetPage = () => {
  const navigate = useNavigate();
  const [budget, setBudget] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const [reportState, setReportState] = useState({
    loading: false,
    current: 0,
    total: 0,
    message: "",
    product: "",
  });
  const [auctionOptions, setAuctionOptions] = useState([]);
  const [selectedAuctions, setSelectedAuctions] = useState({});
  const [auctionSelectorLoading, setAuctionSelectorLoading] = useState(false);
  const [auctionSearch, setAuctionSearch] = useState("");
  const [auctionSort, setAuctionSort] = useState("index-asc");
  const [reportFilters, setReportFilters] = useState({ from: "", to: "" });
  const [bulkText, setBulkText] = useState("");
  const [bulkDefaults, setBulkDefaults] = useState({
    rowCount: "10",
    minimumContribution: "100",
    auctionDuration: "10",
    descriptionPrefix: "Auction",
    dataPrefix: "Data",
  });
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });
  const [bulkResults, setBulkResults] = useState([]);
  const bulkSubmittingRef = useRef(false);

  useEffect(() => {
    if (!window.ethereum) {
      navigate("/");
      return;
    }

    const loadBudget = async () => {
      const stored = await getDefaultBudget();
      if (stored !== undefined && stored !== null) {
        setBudget(stored);
      }
    };

    loadBudget();

    const savedDraft = localStorage.getItem(BULK_DRAFT_KEY);
    if (savedDraft) {
      setBulkText(savedDraft);
    }
  }, [navigate]);

  useEffect(() => {
    if (bulkText) {
      localStorage.setItem(BULK_DRAFT_KEY, bulkText);
    } else {
      localStorage.removeItem(BULK_DRAFT_KEY);
    }
  }, [bulkText]);

  const authenticate = useCallback(() => {
    if (pass === ADMIN_SECRET) {
      setIsAdmin(true);
      setError("");
      toast.success("Admin access granted");
    } else {
      setError("Incorrect admin key");
    }
  }, [pass]);

  const handleBudgetChange = (e) => {
    const value = Number(e.target.value);
    if (value >= 0) {
      setBudget(value);
      setError("");
    } else {
      setError("Budget must be a non-negative number");
    }
  };

  const handleSaveBudget = async () => {
    if (budget >= 0) {
      const userAddress = window.ethereum?.selectedAddress?.toLowerCase();

      try {
        await factory.methods.resetAllBudgets(budget).send({ from: userAddress });

        toast.success(
          budget === 0
            ? "Unlimited spending enabled for all users"
            : `Budget set to ${budget} wei for all users`
        );

        navigate("/auctions-list");
      } catch (saveError) {
        console.error("Error setting budget:", saveError);
        toast.error("Budget did not change");
      }
    } else {
      setError("Please enter a valid budget");
    }
  };

  const handleResetBudget = async () => {
    const userAddress = window.ethereum?.selectedAddress?.toLowerCase();

    try {
      setBudget(0);
      await factory.methods.resetAllBudgets(0).send({ from: userAddress });
      toast.success("Budget reset for all users");
      navigate("/auctions-list");
    } catch (resetError) {
      console.error("Error resetting budget:", resetError);
      toast.error("Budget did not change");
    }
  };

  const handleBulkDefaultsChange = (field, value) => {
    if (
      ["rowCount", "minimumContribution", "auctionDuration"].includes(field) &&
      !/^\d*$/.test(value)
    ) {
      return;
    }

    setBulkDefaults((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleBulkTextChange = (value) => {
    setBulkText(value);
    setBulkResults([]);
    setBulkProgress({ current: 0, total: 0 });
  };

  const handlePrepareBulkRows = () => {
    const rowCount = Number(bulkDefaults.rowCount || 0);

    if (!Number.isInteger(rowCount) || rowCount < 1) {
      toast.error("Choose at least one auction row.");
      return;
    }

    if (rowCount > BULK_MAX_AUCTIONS) {
      toast.error(`Create at most ${BULK_MAX_AUCTIONS} auctions at a time.`);
      return;
    }

    const defaultsError = getAuctionValidationError(
      {
        dataDescription: bulkDefaults.descriptionPrefix || "Auction",
        dataForSell: bulkDefaults.dataPrefix || "Data",
        minimumContribution: bulkDefaults.minimumContribution,
        auctionDuration: bulkDefaults.auctionDuration,
      },
      "Defaults"
    );

    if (defaultsError) {
      toast.error(defaultsError);
      return;
    }

    const rows = makeBulkAuctionRows({
      ...bulkDefaults,
      rowCount,
    });
    handleBulkTextChange(serializeBulkAuctions(rows));
    toast.success(`Prepared ${rowCount} editable auction rows`);
  };

  const handleQuickPrepareBulkRows = (rowCount) => {
    const nextDefaults = {
      ...bulkDefaults,
      rowCount: String(rowCount),
    };
    const rows = makeBulkAuctionRows({
      ...nextDefaults,
      rowCount,
    });

    setBulkDefaults(nextDefaults);
    handleBulkTextChange(serializeBulkAuctions(rows));
    toast.success(`Prepared ${rowCount} editable auction rows`);
  };

  const handleBulkRowChange = (index, field, value) => {
    if (
      ["minimumContribution", "auctionDuration"].includes(field) &&
      !/^\d*$/.test(value)
    ) {
      return;
    }

    const rows = parseBulkAuctions(bulkText);
    rows[index] = {
      ...rows[index],
      [field]: value,
    };
    handleBulkTextChange(serializeBulkAuctions(rows));
  };

  const handleAddBulkRow = () => {
    const rows = parseBulkAuctions(bulkText);
    if (rows.length >= BULK_MAX_AUCTIONS) {
      toast.error(`Create at most ${BULK_MAX_AUCTIONS} auctions at a time.`);
      return;
    }

    const nextIndex = rows.length + 1;
    rows.push({
      rowNumber: nextIndex,
      dataDescription: `${bulkDefaults.descriptionPrefix || "Auction"} ${nextIndex}`,
      dataForSell: `${bulkDefaults.dataPrefix || "Data"} ${nextIndex}`,
      minimumContribution: bulkDefaults.minimumContribution || "100",
      auctionDuration: bulkDefaults.auctionDuration || "10",
    });
    handleBulkTextChange(serializeBulkAuctions(rows));
  };

  const handleRemoveBulkRow = (index) => {
    const rows = parseBulkAuctions(bulkText).filter(
      (_, rowIndex) => rowIndex !== index
    );
    handleBulkTextChange(serializeBulkAuctions(rows));
  };

  const handleLoadBulkExample = () => {
    handleBulkTextChange(
      serializeBulkAuctions([
        {
          dataDescription: "Grp 1: apps on phone",
          dataForSell: "42 apps",
          minimumContribution: "100",
          auctionDuration: "10",
        },
        {
          dataDescription: "Grp 1: doctor visits",
          dataForSell: "3 visits",
          minimumContribution: "100",
          auctionDuration: "10",
        },
        {
          dataDescription: "Grp 2: apps on phone",
          dataForSell: "58 apps",
          minimumContribution: "100",
          auctionDuration: "10",
        },
      ])
    );
  };

  const handleClearBulkDraft = () => {
    handleBulkTextChange("");
    setBulkResults([]);
    setBulkProgress({ current: 0, total: 0 });
  };

  const handleValidateBulkAuctions = () => {
    const auctions = parseBulkAuctions(bulkText);
    if (!auctions.length) {
      toast.error("Add at least one auction row.");
      return false;
    }

    if (auctions.length > BULK_MAX_AUCTIONS) {
      toast.error(`Create at most ${BULK_MAX_AUCTIONS} auctions at a time.`);
      return false;
    }

    const invalidRows = auctions
      .map((auction) => ({
        rowNumber: auction.rowNumber,
        description: auction.dataDescription || "Missing description",
        status: getAuctionValidationError(auction, `Row ${auction.rowNumber}`),
        transactionHash: "",
      }))
      .filter((row) => row.status);

    if (invalidRows.length) {
      setBulkResults(invalidRows);
      toast.error(`${invalidRows.length} bulk auction rows need fixing`);
      return false;
    }

    setBulkResults(
      auctions.map((auction) => ({
        rowNumber: auction.rowNumber,
        description: auction.dataDescription,
        status: "Ready",
        transactionHash: "",
      }))
    );
    toast.success(`${auctions.length} auctions are ready to create`);
    return true;
  };

  const handleBulkCreate = async () => {
    if (bulkSubmittingRef.current || bulkLoading) return;

    const auctions = parseBulkAuctions(bulkText);
    if (!auctions.length) {
      toast.error("Add at least one auction row.");
      return;
    }

    if (auctions.length > BULK_MAX_AUCTIONS) {
      toast.error(`Create at most ${BULK_MAX_AUCTIONS} auctions at a time.`);
      return;
    }

    const invalidRows = auctions
      .map((auction) => ({
        rowNumber: auction.rowNumber,
        description: auction.dataDescription || "Missing description",
        status: getAuctionValidationError(auction, `Row ${auction.rowNumber}`),
        transactionHash: "",
      }))
      .filter((row) => row.status);

    if (invalidRows.length) {
      setBulkResults(invalidRows);
      toast.error(`${invalidRows.length} bulk auction rows need fixing`);
      return;
    }

    bulkSubmittingRef.current = true;
    setBulkLoading(true);
    setBulkProgress({ current: 0, total: auctions.length });
    const toastId = toast.loading(`Creating 1/${auctions.length} auctions...`);
    const results = auctions.map((auction) => ({
      rowNumber: auction.rowNumber,
      description: auction.dataDescription,
      status: "Queued",
      transactionHash: "",
    }));

    setBulkResults(results);

    try {
      const from = await requestConnectedAccount();

      for (let index = 0; index < auctions.length; index += 1) {
        const auction = auctions[index];
        toast.loading(`Creating ${index + 1}/${auctions.length} auctions...`, {
          id: toastId,
        });
        results[index] = {
          ...results[index],
          status: "Waiting for wallet",
        };
        setBulkResults([...results]);

        try {
          const receipt = await factory.methods
            .createCampaign(
              auction.minimumContribution,
              auction.dataForSell,
              auction.dataDescription,
              auction.auctionDuration
            )
            .send({ from });

          results[index] = {
            ...results[index],
            status: "Created",
            transactionHash: receipt?.transactionHash || "",
          };
        } catch (createError) {
          console.error("Bulk auction creation failed:", createError);
          results[index] = {
            ...results[index],
            status: "Failed",
          };
          setBulkResults([...results]);
          throw createError;
        } finally {
          setBulkProgress({ current: index + 1, total: auctions.length });
        }

        setBulkResults([...results]);
      }

      toast.success(`Created ${results.length} auctions`, { id: toastId });
      setBulkText("");
    } catch (createError) {
      toast.error(getTransactionErrorMessage(createError), { id: toastId });
    } finally {
      bulkSubmittingRef.current = false;
      setBulkLoading(false);
    }
  };

  const handleLoadAuctionSelector = async () => {
    if (auctionSelectorLoading || reportState.loading) return;

    setAuctionSelectorLoading(true);
    try {
      const addresses = await readOnlyCall(({ factory: readFactory }) =>
        readFactory.methods.getDeployedCampaigns()
      );
      const options = await mapWithConcurrency(
        addresses,
        REPORT_CONCURRENCY,
        (address, index) => readAuctionOption(address, index)
      );

      setAuctionOptions(options.filter(Boolean));
      setSelectedAuctions((current) => {
        const next = {};
        options.forEach((option) => {
          if (current[option.address]) next[option.address] = true;
        });
        return next;
      });
      toast.success(`Loaded ${options.length} auctions`);
    } catch (loadError) {
      console.error("Auction selector load failed:", loadError);
      toast.error(loadError.message || "Could not load auction selector");
    } finally {
      setAuctionSelectorLoading(false);
    }
  };

  const handleToggleAuctionSelection = (address) => {
    setSelectedAuctions((current) => ({
      ...current,
      [address]: !current[address],
    }));
  };

  const handleDateFilterChange = (field, value) => {
    setReportFilters((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleGenerateReports = async (product = "excel") => {
    if (reportState.loading) return;
    const productLabel =
      product === "html"
        ? "printable HTML"
        : product === "json"
        ? "raw JSON"
        : "Excel workbook";

    setReportState({
      loading: true,
      current: 0,
      total: 0,
      message: `Reading auction list for ${productLabel}...`,
      product: productLabel,
    });

    try {
      const addresses = await readOnlyCall(({ factory: readFactory }) =>
        readFactory.methods.getDeployedCampaigns()
      );
      const reports = [];
      const errors = [];
      const selectedSet = new Set(
        Object.entries(selectedAuctions)
          .filter(([, selected]) => selected)
          .map(([address]) => address)
      );
      const hasDateFilter = Boolean(reportFilters.from || reportFilters.to);
      let targets = auctionOptions.length
        ? auctionOptions.map((option) => ({
            address: option.address,
            index: option.index - 1,
            endTime: option.endTime,
          }))
        : addresses.map((address, index) => ({ address, index, endTime: "" }));

      if (selectedSet.size) {
        targets = targets.filter((target) => selectedSet.has(target.address));
      }

      if (hasDateFilter && auctionOptions.length) {
        targets = targets.filter((target) =>
          isEndTimeInDateRange(target.endTime, reportFilters)
        );
      }

      if (!targets.length) {
        throw new Error("No auctions match the selected report filters");
      }

      setReportState({
        loading: true,
        current: 0,
        total: targets.length,
        message: `Preparing ${targets.length} auctions...`,
        product: productLabel,
      });

      await mapWithConcurrency(
        targets,
        REPORT_CONCURRENCY,
        async (target, targetIndex) => {
          try {
            const report = await readAuctionReport(
              target.address,
              target.index,
              targets.length,
              (message) =>
                setReportState((current) => ({
                  ...current,
                  message,
                })),
              targetIndex
            );
            reports[targetIndex] = report;
          } catch (readError) {
            errors.push({
              "Auction #": target.index + 1,
              "Auction Address": target.address,
              Error: readError.message || "Auction report read failed",
            });
          } finally {
            setReportState((current) => ({
              ...current,
              current: current.current + 1,
            }));
          }
        }
      );

      const cleanReports = filterReportsByDate(
        reports.filter(Boolean),
        reportFilters
      );
      if (!cleanReports.length) {
        throw new Error("No auctions could be exported for these filters");
      }

      if (product === "json") {
        downloadJsonReport(buildReportPayload(cleanReports, errors));
      } else if (product === "html") {
        downloadHtmlReport(buildReportPayload(cleanReports, errors));
      } else {
        downloadWorkbook(buildReportSheets(cleanReports, errors));
      }

      toast.success(
        `${productLabel} downloaded for ${cleanReports.length} auctions`
      );
    } catch (reportError) {
      console.error("Report generation failed:", reportError);
      toast.error(reportError.message || "Report generation failed");
    } finally {
      setReportState({
        loading: false,
        current: 0,
        total: 0,
        message: "",
        product: "",
      });
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Enter") {
        authenticate();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [authenticate]);

  const reportProgress =
    reportState.total > 0
      ? Math.round((reportState.current / reportState.total) * 100)
      : 0;
  const bulkAuctions = parseBulkAuctions(bulkText);
  const bulkValidationRows = bulkAuctions.map((auction) => ({
    ...auction,
    error: getAuctionValidationError(auction, `Row ${auction.rowNumber}`),
  }));
  const bulkInvalidCount = bulkValidationRows.filter((row) => row.error).length;
  const bulkReadyCount = Math.max(bulkValidationRows.length - bulkInvalidCount, 0);
  const bulkProgressPercent = bulkProgress.total
    ? Math.round((bulkProgress.current / bulkProgress.total) * 100)
    : 0;
  const bulkCreatedCount = bulkResults.filter(
    (result) => result.status === "Created"
  ).length;
  const bulkFailedCount = bulkResults.filter(
    (result) => result.status === "Failed" || result.status === "Invalid"
  ).length;
  const bulkCreateLabel =
    bulkAuctions.length === 1
      ? "Create 1 Auction"
      : `Create ${bulkAuctions.length || ""} Auctions`;
  const selectedAuctionCount = Object.values(selectedAuctions).filter(Boolean)
    .length;
  const hasReportFilters = Boolean(reportFilters.from || reportFilters.to);
  const normalizedAuctionSearch = auctionSearch.trim().toLowerCase();
  const visibleAuctionOptions = auctionOptions
    .filter((option) => {
      const matchesSearch =
        !normalizedAuctionSearch ||
        [
          option.index,
          option.address,
          option.dataDescription,
          option.seller,
          option.highestBidder,
          option.highestBid,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedAuctionSearch);
      const matchesDate =
        !hasReportFilters || isEndTimeInDateRange(option.endTime, reportFilters);

      return matchesSearch && matchesDate;
    })
    .sort((a, b) => {
      if (auctionSort === "selected-first") {
        return (
          Number(Boolean(selectedAuctions[b.address])) -
            Number(Boolean(selectedAuctions[a.address])) || a.index - b.index
        );
      }
      if (auctionSort === "date-desc") {
        return Number(b.endTime || 0) - Number(a.endTime || 0);
      }
      if (auctionSort === "date-asc") {
        return Number(a.endTime || 0) - Number(b.endTime || 0);
      }
      if (auctionSort === "bid-desc") {
        return compareWeiDesc(a.highestBid, b.highestBid);
      }
      if (auctionSort === "bid-asc") {
        return compareWeiDesc(b.highestBid, a.highestBid);
      }
      if (auctionSort === "name-asc") {
        return String(a.dataDescription || "").localeCompare(
          String(b.dataDescription || "")
        );
      }
      return a.index - b.index;
    });
  const selectedVisibleCount = visibleAuctionOptions.filter(
    (option) => selectedAuctions[option.address]
  ).length;
  const reportScopeText = selectedAuctionCount
    ? `${selectedAuctionCount} selected auction${
        selectedAuctionCount === 1 ? "" : "s"
      }`
    : hasReportFilters
    ? "all auctions in the selected date range"
    : "all auctions";

  const handleSelectVisibleAuctions = () => {
    setSelectedAuctions((current) => {
      const next = { ...current };
      visibleAuctionOptions.forEach((option) => {
        next[option.address] = true;
      });
      return next;
    });
  };

  const handleClearAuctionSelection = () => {
    setSelectedAuctions({});
  };

  return (
    <Layout>
      <Box
        display="flex"
        flexDirection="column"
        alignItems="center"
        sx={{
          marginTop: 16,
          backgroundColor: "background.paper",
          padding: 4,
          borderRadius: 4,
          boxShadow: 3,
          width: "100%",
          maxWidth: 840,
          mx: "auto",
        }}
      >
        {isAdmin ? (
          <>
            <Typography variant="h4" gutterBottom>
              Admin Zone
            </Typography>

            <Box sx={{ width: "100%" }}>
              <Typography variant="h6">Set Global Budget</Typography>
              <TextField
                label="Budget (wei)"
                type="number"
                value={budget}
                onChange={handleBudgetChange}
                fullWidth
                sx={{ mt: 2 }}
              />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Set to 0 for unlimited spending
              </Typography>
              {error && (
                <Typography color="error" sx={{ mt: 1 }}>
                  {error}
                </Typography>
              )}
              <Box display="flex" gap={2} sx={{ mt: 3 }}>
                <Button
                  variant="contained"
                  color="success"
                  onClick={handleSaveBudget}
                  fullWidth
                >
                  Save
                </Button>
                <Button
                  variant="outlined"
                  color="secondary"
                  onClick={handleResetBudget}
                  fullWidth
                >
                  Reset
                </Button>
              </Box>
            </Box>

            <Divider flexItem sx={{ my: 4 }} />

            <Box sx={{ width: "100%" }}>
              <Box
                display="flex"
                justifyContent="space-between"
                alignItems="flex-start"
                gap={2}
                flexWrap="wrap"
              >
                <Box>
                  <Typography variant="h6">Batch Auction Studio</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    Pick a template, fine tune the rows, then create the batch.
                  </Typography>
                </Box>
                <Button
                  variant="contained"
                  onClick={handlePrepareBulkRows}
                  disabled={bulkLoading}
                  sx={{
                    backgroundColor: "#103090",
                    borderRadius: 999,
                    minWidth: 180,
                  }}
                >
                  Generate Draft
                </Button>
              </Box>

              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr 1fr" },
                  gap: 1,
                  mt: 2,
                }}
              >
                {[
                  ["1", "Configure", "Choose count and defaults"],
                  ["2", "Review", "Edit every auction inline"],
                  ["3", "Create", "Approve each wallet transaction"],
                ].map(([number, title, detail]) => (
                  <Box
                    key={title}
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "32px 1fr",
                      gap: 1,
                      alignItems: "center",
                      p: 1.25,
                      borderRadius: 2,
                      backgroundColor: "#fbfcff",
                      border: "1px solid #e5e7f3",
                    }}
                  >
                    <Box
                      sx={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        display: "grid",
                        placeItems: "center",
                        backgroundColor: "#103090",
                        color: "#fff",
                        fontWeight: 700,
                        fontSize: 13,
                      }}
                    >
                      {number}
                    </Box>
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>
                        {title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {detail}
                      </Typography>
                    </Box>
                  </Box>
                ))}
              </Box>

              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "1fr",
                    sm: "1fr 1fr",
                    md: "1.2fr 1fr 1fr",
                  },
                  gap: 1,
                  mt: 2,
                  alignItems: "center",
                  p: 2,
                  borderRadius: 2,
                  backgroundColor: "#f7f8fc",
                  border: "1px solid #e5e7f3",
                }}
              >
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Start with
                  </Typography>
                  <Box display="flex" gap={1} flexWrap="wrap" sx={{ mt: 0.75 }}>
                    {[3, 5, 10, 20].map((count) => (
                      <Button
                        key={count}
                        variant={
                          String(count) === bulkDefaults.rowCount
                            ? "contained"
                            : "outlined"
                        }
                        size="small"
                        onClick={() => handleQuickPrepareBulkRows(count)}
                        disabled={bulkLoading}
                        sx={{
                          borderRadius: 999,
                          backgroundColor:
                            String(count) === bulkDefaults.rowCount
                              ? "#103090"
                              : undefined,
                        }}
                      >
                        {count}
                      </Button>
                    ))}
                  </Box>
                </Box>
                <TextField
                  label="Description starts with"
                  value={bulkDefaults.descriptionPrefix}
                  onChange={(event) =>
                    handleBulkDefaultsChange(
                      "descriptionPrefix",
                      event.target.value
                    )
                  }
                  size="small"
                  disabled={bulkLoading}
                />
                <TextField
                  label="Data starts with"
                  value={bulkDefaults.dataPrefix}
                  onChange={(event) =>
                    handleBulkDefaultsChange("dataPrefix", event.target.value)
                  }
                  size="small"
                  disabled={bulkLoading}
                />
                <TextField
                  label="Minimum bid"
                  value={bulkDefaults.minimumContribution}
                  onChange={(event) =>
                    handleBulkDefaultsChange(
                      "minimumContribution",
                      event.target.value
                    )
                  }
                  size="small"
                  disabled={bulkLoading}
                />
                <TextField
                  label="Duration in minutes"
                  value={bulkDefaults.auctionDuration}
                  onChange={(event) =>
                    handleBulkDefaultsChange(
                      "auctionDuration",
                      event.target.value
                    )
                  }
                  size="small"
                  disabled={bulkLoading}
                />
              </Box>

              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 1,
                  flexWrap: "wrap",
                  mt: 2,
                }}
              >
                <Box display="flex" gap={1} flexWrap="wrap">
                  {[
                    `${bulkAuctions.length}/${BULK_MAX_AUCTIONS} rows`,
                    `${bulkReadyCount} ready`,
                    `${bulkInvalidCount} issues`,
                  ].map((label) => (
                    <Typography
                      key={label}
                      variant="caption"
                      sx={{
                        px: 1.25,
                        py: 0.55,
                        borderRadius: 999,
                        backgroundColor: "#f4f6ff",
                        border: "1px solid #dfe4fb",
                        color: "#29327a",
                        fontWeight: 600,
                      }}
                    >
                      {label}
                    </Typography>
                  ))}
                </Box>
                <Box display="flex" gap={1} flexWrap="wrap">
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={handleAddBulkRow}
                    disabled={bulkLoading || bulkAuctions.length >= BULK_MAX_AUCTIONS}
                  >
                    Add Row
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={handleValidateBulkAuctions}
                    disabled={bulkLoading || !bulkAuctions.length}
                  >
                    Validate
                  </Button>
                  <Button
                    variant="text"
                    size="small"
                    onClick={() => setShowBulkImport((current) => !current)}
                    disabled={bulkLoading}
                  >
                    {showBulkImport ? "Hide Import" : "Import"}
                  </Button>
                  <Button
                    variant="text"
                    size="small"
                    onClick={handleClearBulkDraft}
                    disabled={bulkLoading || (!bulkText && !bulkResults.length)}
                  >
                    Clear
                  </Button>
                </Box>
              </Box>

              {!bulkAuctions.length && (
                <Box
                  sx={{
                    mt: 2,
                    p: 4,
                    borderRadius: 2,
                    border: "1px dashed #cfd5ec",
                    backgroundColor: "#fbfcff",
                    textAlign: "center",
                  }}
                >
                  <Typography variant="h6" sx={{ fontSize: 18 }}>
                    Ready when you are.
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    One click prepares a clean batch. You can still edit every
                    auction before anything is sent to MetaMask.
                  </Typography>
                  <Box display="flex" justifyContent="center" gap={1} sx={{ mt: 1.5 }}>
                    <Button
                      variant="contained"
                      onClick={handlePrepareBulkRows}
                      sx={{ backgroundColor: "#103090", borderRadius: 999 }}
                    >
                      Generate Draft
                    </Button>
                    <Button
                      variant="outlined"
                      onClick={handleLoadBulkExample}
                      disabled={bulkLoading}
                    >
                      Load Example
                    </Button>
                  </Box>
                </Box>
              )}

              {bulkAuctions.length > 0 && (
                <Box
                  sx={{
                    mt: 1.5,
                    border: "1px solid #e5e7f3",
                    borderRadius: 2,
                    overflowX: "auto",
                    backgroundColor: "#fff",
                  }}
                >
                  <Box
                    sx={{
                      display: { xs: "none", md: "grid" },
                      gridTemplateColumns:
                        "44px minmax(180px, 1.3fr) minmax(150px, 1fr) 92px 86px 76px 72px",
                      gap: 1,
                      minWidth: 850,
                      px: 1,
                      py: 0.75,
                      borderBottom: "1px solid #e5e7f3",
                      color: "#5e638a",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    <span>#</span>
                    <span>Description</span>
                    <span>Data</span>
                    <span>Min bid</span>
                    <span>Duration</span>
                    <span>Status</span>
                    <span></span>
                  </Box>
                  {bulkValidationRows.map((auction, index) => (
                    <Box
                      key={`${auction.rowNumber}-${auction.dataDescription}`}
                      sx={{
                        display: "grid",
                        gridTemplateColumns: {
                          xs: "1fr",
                          md: "44px minmax(180px, 1.3fr) minmax(150px, 1fr) 92px 86px 76px 72px",
                        },
                        gap: 1,
                        minWidth: { md: 850 },
                        p: 1,
                        alignItems: "center",
                        borderBottom: "1px solid #eef0f8",
                      }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        #{index + 1}
                      </Typography>
                      <TextField
                        variant="standard"
                        value={auction.dataDescription}
                        placeholder="Description"
                        onChange={(event) =>
                          handleBulkRowChange(
                            index,
                            "dataDescription",
                            event.target.value
                          )
                        }
                        size="small"
                        disabled={bulkLoading}
                        InputProps={{ disableUnderline: true }}
                        sx={{ px: 1, py: 0.5, borderRadius: 1, backgroundColor: "#f7f8fc" }}
                      />
                      <TextField
                        variant="standard"
                        value={auction.dataForSell}
                        placeholder="Data"
                        onChange={(event) =>
                          handleBulkRowChange(
                            index,
                            "dataForSell",
                            event.target.value
                          )
                        }
                        size="small"
                        disabled={bulkLoading}
                        InputProps={{ disableUnderline: true }}
                        sx={{ px: 1, py: 0.5, borderRadius: 1, backgroundColor: "#f7f8fc" }}
                      />
                      <TextField
                        variant="standard"
                        value={auction.minimumContribution}
                        placeholder="Min bid"
                        onChange={(event) =>
                          handleBulkRowChange(
                            index,
                            "minimumContribution",
                            event.target.value
                          )
                        }
                        size="small"
                        disabled={bulkLoading}
                        InputProps={{ disableUnderline: true }}
                        sx={{ px: 1, py: 0.5, borderRadius: 1, backgroundColor: "#f7f8fc" }}
                      />
                      <TextField
                        variant="standard"
                        value={auction.auctionDuration}
                        placeholder="Duration"
                        onChange={(event) =>
                          handleBulkRowChange(
                            index,
                            "auctionDuration",
                            event.target.value
                          )
                        }
                        size="small"
                        disabled={bulkLoading}
                        InputProps={{ disableUnderline: true }}
                        sx={{ px: 1, py: 0.5, borderRadius: 1, backgroundColor: "#f7f8fc" }}
                      />
                      <Typography
                        variant="caption"
                        sx={{
                          color: auction.error ? "#b42318" : "#1b7f35",
                          fontWeight: 600,
                          px: 0.75,
                          py: 0.35,
                          borderRadius: 999,
                          backgroundColor: auction.error ? "#fff1f0" : "#eefbf1",
                          textAlign: "center",
                        }}
                      >
                        {auction.error ? "Fix" : "Ready"}
                      </Typography>
                      <Button
                        variant="text"
                        size="small"
                        onClick={() => handleRemoveBulkRow(index)}
                        disabled={bulkLoading}
                        sx={{
                          gridColumn: { xs: "1", md: "7" },
                          justifySelf: "start",
                          minWidth: 0,
                        }}
                      >
                        Remove
                      </Button>
                      {auction.error && (
                        <Typography
                          variant="caption"
                          color="error"
                          sx={{ gridColumn: { xs: "1", md: "2 / span 5" } }}
                        >
                          {auction.error}
                        </Typography>
                      )}
                    </Box>
                  ))}
                </Box>
              )}

              {showBulkImport && (
                <TextField
                  multiline
                  minRows={4}
                  fullWidth
                  label="Import rows"
                  value={bulkText}
                  onChange={(event) => handleBulkTextChange(event.target.value)}
                  placeholder="Description | Data for sale | Minimum bid | Duration"
                  disabled={bulkLoading}
                  helperText="Paste rows from Excel/CSV. Accepted separators: pipe, tab, or comma."
                  sx={{ mt: 1.5 }}
                />
              )}

              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", sm: "1fr auto" },
                  gap: 1.5,
                  alignItems: "center",
                  mt: 2,
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  Created {bulkCreatedCount}; failed {bulkFailedCount}. Keep
                  MetaMask open while the batch runs.
                </Typography>
                <Button
                  variant="contained"
                  onClick={handleBulkCreate}
                  disabled={
                    bulkLoading ||
                    !bulkAuctions.length ||
                    bulkInvalidCount > 0 ||
                    bulkAuctions.length > BULK_MAX_AUCTIONS
                  }
                  sx={{
                    backgroundColor: "#103090",
                    minWidth: 220,
                    borderRadius: 999,
                  }}
                >
                  {bulkLoading ? (
                    <CircularProgress size={18} color="inherit" />
                  ) : (
                    bulkCreateLabel
                  )}
                </Button>
              </Box>

              {(bulkLoading || bulkProgress.total > 0) && (
                <Box sx={{ mt: 1.5 }}>
                  <LinearProgress
                    variant="determinate"
                    value={bulkProgressPercent}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {bulkProgress.current}/{bulkProgress.total} transactions
                    submitted
                  </Typography>
                </Box>
              )}

              {bulkResults.length > 0 && (
                <Box
                  sx={{
                    mt: 1.5,
                    border: "1px solid #e5e7f3",
                    borderRadius: 2,
                    backgroundColor: "#fff",
                    maxHeight: 260,
                    overflowY: "auto",
                  }}
                >
                  {bulkResults.map((result) => (
                    <Box
                      key={`${result.rowNumber}-${result.description}`}
                      sx={{
                        display: "grid",
                        gridTemplateColumns: { xs: "1fr", sm: "1fr 120px" },
                        gap: 1,
                        p: 1,
                        borderBottom: "1px solid #eef0f8",
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2">
                          Row {result.rowNumber}: {result.description}
                        </Typography>
                        {result.transactionHash && (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{
                              fontFamily: "monospace",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {result.transactionHash}
                          </Typography>
                        )}
                      </Box>
                      <Typography
                        variant="caption"
                        sx={{
                          color:
                            result.status === "Created"
                              ? "#1b7f35"
                              : result.status === "Failed" ||
                                result.status === "Invalid"
                              ? "#b42318"
                              : "#5e638a",
                          fontWeight: 600,
                        }}
                      >
                        {result.status}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>

            <Divider flexItem sx={{ my: 4 }} />

            <Box sx={{ width: "100%" }}>
              <Typography variant="h6">Auction Reports</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Create a full chain-snapshot report: auction summaries, all bids,
                timelines, seller/bidder analysis, payment review, review flags,
                leaderboards, raw data, and one sheet per auction.
              </Typography>

              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                  gap: 1.5,
                  mt: 2,
                }}
              >
                <TextField
                  label="From end date"
                  type="date"
                  value={reportFilters.from}
                  onChange={(e) =>
                    handleDateFilterChange("from", e.target.value)
                  }
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
                <TextField
                  label="To end date"
                  type="date"
                  value={reportFilters.to}
                  onChange={(e) => handleDateFilterChange("to", e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
              </Box>

              <Box
                sx={{
                  mt: 2,
                  p: { xs: 1.5, sm: 2 },
                  border: "1px solid #d9dcef",
                  borderRadius: 2,
                  backgroundColor: "#fafbff",
                }}
              >
                <Box
                  display="flex"
                  justifyContent="space-between"
                  alignItems="center"
                  gap={1}
                  flexWrap="wrap"
                >
                  <Box>
                    <Typography variant="subtitle2">
                      Optional auction selection
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Leave empty to export all matching auctions.
                    </Typography>
                  </Box>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={handleLoadAuctionSelector}
                    disabled={auctionSelectorLoading || reportState.loading}
                  >
                    {auctionSelectorLoading ? "Loading..." : "Load Auctions"}
                  </Button>
                </Box>

                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: {
                      xs: "1fr",
                      sm: "1.2fr 0.8fr 0.8fr",
                    },
                    gap: 1,
                    mt: 1.5,
                  }}
                >
                  <Box
                    sx={{
                      px: 1.25,
                      py: 1,
                      borderRadius: 2,
                      backgroundColor: "#ffffff",
                      border: "1px solid #e5e7f3",
                    }}
                  >
                    <Typography variant="caption" color="text.secondary">
                      Export scope
                    </Typography>
                    <Typography variant="body2">{reportScopeText}</Typography>
                  </Box>
                  <Box
                    sx={{
                      px: 1.25,
                      py: 1,
                      borderRadius: 2,
                      backgroundColor: "#ffffff",
                      border: "1px solid #e5e7f3",
                    }}
                  >
                    <Typography variant="caption" color="text.secondary">
                      Loaded
                    </Typography>
                    <Typography variant="body2">
                      {auctionOptions.length || "Not loaded"}
                    </Typography>
                  </Box>
                  <Box
                    sx={{
                      px: 1.25,
                      py: 1,
                      borderRadius: 2,
                      backgroundColor: "#ffffff",
                      border: "1px solid #e5e7f3",
                    }}
                  >
                    <Typography variant="caption" color="text.secondary">
                      Selected
                    </Typography>
                    <Typography variant="body2">{selectedAuctionCount}</Typography>
                  </Box>
                </Box>

                {auctionSelectorLoading && (
                  <Box sx={{ mt: 1.5 }}>
                    <LinearProgress />
                    <Typography variant="caption" color="text.secondary">
                      Loading auction names and dates...
                    </Typography>
                  </Box>
                )}

                {auctionOptions.length > 0 && (
                  <>
                    <Box
                      sx={{
                        display: "grid",
                        gridTemplateColumns: {
                          xs: "1fr",
                          md: "1fr 190px auto",
                        },
                        gap: 1,
                        mt: 1.5,
                        alignItems: "center",
                      }}
                    >
                      <TextField
                        label="Find auctions"
                        value={auctionSearch}
                        onChange={(e) => setAuctionSearch(e.target.value)}
                        placeholder="Description, address, seller, winner, or bid"
                        size="small"
                        fullWidth
                      />
                      <TextField
                        select
                        label="Sort"
                        value={auctionSort}
                        onChange={(e) => setAuctionSort(e.target.value)}
                        size="small"
                        SelectProps={{ native: true }}
                      >
                        <option value="index-asc">Original order</option>
                        <option value="selected-first">Selected first</option>
                        <option value="date-desc">Newest end date</option>
                        <option value="date-asc">Oldest end date</option>
                        <option value="bid-desc">Highest bid</option>
                        <option value="bid-asc">Lowest bid</option>
                        <option value="name-asc">Description A-Z</option>
                      </TextField>
                      <Box display="flex" gap={1} flexWrap="wrap">
                        <Button
                          variant="outlined"
                          size="small"
                          onClick={handleSelectVisibleAuctions}
                          disabled={!visibleAuctionOptions.length}
                        >
                          Select shown
                        </Button>
                        <Button
                          variant="text"
                          size="small"
                          onClick={handleClearAuctionSelection}
                          disabled={!selectedAuctionCount}
                        >
                          Use all matching
                        </Button>
                      </Box>
                    </Box>

                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                      sx={{ mt: 1 }}
                    >
                      Showing {visibleAuctionOptions.length} of{" "}
                      {auctionOptions.length}; selected in this view{" "}
                      {selectedVisibleCount}.
                    </Typography>

                    <Box
                      sx={{
                        mt: 1,
                        maxHeight: 320,
                        overflowY: "auto",
                        border: "1px solid #e4e6f2",
                        borderRadius: 2,
                        backgroundColor: "#ffffff",
                      }}
                    >
                      {visibleAuctionOptions.map((option) => (
                        <Box
                          key={option.address}
                          component="label"
                          sx={{
                            display: "grid",
                            gridTemplateColumns: "auto 1fr",
                            gap: 1,
                            alignItems: "flex-start",
                            p: 1.25,
                            borderBottom: "1px solid #eef0f8",
                            cursor: "pointer",
                            transition: "background-color 140ms ease",
                            "&:hover": {
                              backgroundColor: "#f6f7ff",
                            },
                            "&:last-of-type": {
                              borderBottom: 0,
                            },
                          }}
                        >
                          <Box sx={{ pt: 0.25 }}>
                            <Checkbox
                              checked={Boolean(
                                selectedAuctions[option.address]
                              )}
                              onChange={() =>
                                handleToggleAuctionSelection(option.address)
                              }
                              size="small"
                            />
                          </Box>
                          <Box sx={{ minWidth: 0 }}>
                            <Box
                              display="flex"
                              justifyContent="space-between"
                              gap={1}
                              flexWrap="wrap"
                            >
                              <Typography
                                variant="body2"
                                sx={{ fontWeight: 600, color: "#061064" }}
                              >
                                #{option.index} {option.dataDescription}
                              </Typography>
                              <Typography
                                variant="caption"
                                sx={{
                                  px: 1,
                                  py: 0.25,
                                  borderRadius: 999,
                                  backgroundColor: "#eef1ff",
                                  color: "#29327a",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {toDateInputValue(option.endTime) || "No date"}
                              </Typography>
                            </Box>
                            <Box
                              display="flex"
                              gap={1}
                              flexWrap="wrap"
                              sx={{ mt: 0.5 }}
                            >
                              <Typography variant="caption" color="text.secondary">
                                Bid {option.highestBid} wei
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                Seller {shortAddress(option.seller)}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                Winner {shortAddress(option.highestBidder)}
                              </Typography>
                            </Box>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                              sx={{
                                mt: 0.25,
                                fontFamily: "monospace",
                                overflowWrap: "anywhere",
                              }}
                            >
                              {option.address}
                            </Typography>
                          </Box>
                        </Box>
                      ))}
                      {!visibleAuctionOptions.length && (
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ p: 2 }}
                        >
                          No loaded auctions match the current search/date
                          filters.
                        </Typography>
                      )}
                    </Box>
                  </>
                )}
              </Box>

              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr 1fr" },
                  gap: 1.5,
                  mt: 2,
                }}
              >
                <Button
                  variant="contained"
                  sx={{ backgroundColor: "#103090" }}
                  onClick={() => handleGenerateReports("excel")}
                  disabled={reportState.loading}
                >
                  Excel Workbook
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => handleGenerateReports("html")}
                  disabled={reportState.loading}
                >
                  Printable HTML
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => handleGenerateReports("json")}
                  disabled={reportState.loading}
                >
                  Raw JSON
                </Button>
              </Box>
              {reportState.loading && (
                <Box sx={{ mt: 2, width: "100%" }}>
                  <LinearProgress variant="determinate" value={reportProgress} />
                  <Typography variant="caption" color="text.secondary">
                    {reportState.current}/{reportState.total} auctions -{" "}
                    {reportState.message}
                  </Typography>
                </Box>
              )}
            </Box>
          </>
        ) : (
          <>
            <Typography variant="h5" gutterBottom>
              Admin Access Required
            </Typography>
            <TextField
              label="Admin Key"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              fullWidth
              sx={{ mt: 2 }}
            />
            <Button
              variant="contained"
              color="primary"
              fullWidth
              sx={{ mt: 3 }}
              onClick={authenticate}
            >
              Unlock
            </Button>
            {error && (
              <Typography color="error" sx={{ mt: 2 }}>
                {error}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ mt: 2 }}>
              Press Enter after typing your key
            </Typography>
          </>
        )}
      </Box>
    </Layout>
  );
};

export default ManageBudgetPage;
