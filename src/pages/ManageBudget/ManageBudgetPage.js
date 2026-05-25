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
import {
  getActiveMarket,
  subscribeToMarketChanges,
} from "../../real_ethereum/marketConfig";
import {
  BULK_DRAFT_KEY,
  BULK_MAX_AUCTIONS,
  getAuctionValidationError,
  getTransactionErrorMessage,
  makeBulkAuctionRows,
  parseBulkAuctions,
  serializeBulkAuctions,
} from "./bulkAuctionUtils";
import {
  REPORT_CONCURRENCY,
  buildReportPayload,
  buildReportSheets,
  compareWeiDesc,
  downloadCsvReport,
  downloadHtmlReport,
  downloadJsonReport,
  downloadWorkbook,
  filterReportsByDate,
  isEndTimeInDateRange,
  mapWithConcurrency,
  readAuctionOption,
  readAuctionReport,
  shortAddress,
  toDateInputValue,
} from "./reportUtils";

const LOCAL_STORAGE_KEY = "globalBudgetStore";
const ADMIN_SECRET = "1234"; // Do not store production secrets on the frontend.
const REPORT_SECTION_OPTIONS = [
  {
    key: "readme",
    label: "README",
    description: "Report metadata, glossary, and field definitions.",
  },
  {
    key: "summary",
    label: "Auction Summary",
    description: "One clean row per auction contract.",
  },
  {
    key: "bids",
    label: "All Bids",
    description: "Every bid row, plus explicit zero-bid auctions.",
  },
  {
    key: "timeline",
    label: "Timeline",
    description: "Bid events and auction end times in order.",
  },
  {
    key: "payments",
    label: "Payment Review",
    description: "Seller, winner, refund, and bidder status review.",
  },
  {
    key: "participants",
    label: "Participant Analysis",
    description: "Seller and bidder summaries in one sheet.",
  },
  {
    key: "flags",
    label: "Review Flags",
    description: "The operational checklist for things to inspect.",
  },
  {
    key: "leaderboards",
    label: "Leaderboards",
    description: "Top auctions and bidders by activity/value.",
  },
];
const REPORT_DIAGNOSTIC_OPTIONS = [
  {
    key: "readErrors",
    label: "Read errors",
    description: "Auctions that could not be fully exported.",
  },
  {
    key: "zeroBids",
    label: "Zero bids",
    description: "Auctions with no bid transactions.",
  },
  {
    key: "singleBidder",
    label: "Single bidder",
    description: "Auctions with only one unique bidder.",
  },
  {
    key: "paymentIssues",
    label: "Payment issues",
    description: "Pending seller payments or payment status failures.",
  },
  {
    key: "highestBidMismatch",
    label: "Highest bid mismatch",
    description: "Summary winner does not match reconstructed bids.",
  },
  {
    key: "bidderCountMismatch",
    label: "Bidder count mismatch",
    description: "Summary count differs from transaction-derived count.",
  },
  {
    key: "statusReadErrors",
    label: "Status read errors",
    description: "Failed getUserAuctionStatus reads.",
  },
];
const REPORT_EXPORT_OPTIONS = [
  {
    product: "excel",
    label: "Excel Workbook",
    description: "Best for full analysis with your selected tabs.",
    primary: true,
  },
  {
    product: "html",
    label: "Printable HTML",
    description: "Readable snapshot for sharing or printing.",
  },
  {
    product: "json",
    label: "Raw JSON",
    description: "Developer-friendly export with raw structures.",
  },
  {
    product: "timeline",
    label: "Timeline CSV",
    description: "Only chronological auction and bid events.",
    requiresSection: "timeline",
  },
  {
    product: "bids",
    label: "All Bids CSV",
    description: "Only bid rows for spreadsheet analysis.",
    requiresSection: "bids",
  },
  {
    product: "payments",
    label: "Payment CSV",
    description: "Only seller, refund, and winner review rows.",
    requiresSection: "payments",
  },
];

const makeDefaultReportSelection = (options) =>
  options.reduce((selection, option) => {
    selection[option.key] = true;
    return selection;
  }, {});

const summarizeReportSelection = (options, selection, emptyText) => {
  const labels = options
    .filter((option) => selection[option.key])
    .map((option) => option.label);

  if (!labels.length) return emptyText;
  if (labels.length <= 3) return labels.join(", ");

  return `${labels.slice(0, 3).join(", ")} +${labels.length - 3} more`;
};

export const saveBudget = (budget) => {
  localStorage.setItem(
    LOCAL_STORAGE_KEY,
    JSON.stringify({ defaultBudget: budget })
  );
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
  const [reportIncludeAllAuctions, setReportIncludeAllAuctions] =
    useState(false);
  const [reportSections, setReportSections] = useState(() =>
    makeDefaultReportSelection(REPORT_SECTION_OPTIONS)
  );
  const [reportDiagnostics, setReportDiagnostics] = useState(() =>
    makeDefaultReportSelection(REPORT_DIAGNOSTIC_OPTIONS)
  );
  const [reportBuilderOpen, setReportBuilderOpen] = useState(false);
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
  const [activeMarket, setActiveMarketState] = useState(getActiveMarket());
  const reportCancelRef = useRef(false);
  const bulkSubmittingRef = useRef(false);
  const autoLoadedAuctionRangeRef = useRef("");

  const loadBudget = useCallback(async () => {
    const stored = await getDefaultBudget();
    if (stored !== undefined && stored !== null) {
      setBudget(stored);
    }
  }, []);

  useEffect(() => {
    if (!window.ethereum) {
      navigate("/");
      return;
    }

    loadBudget();

    const savedDraft = localStorage.getItem(BULK_DRAFT_KEY);
    if (savedDraft) {
      setBulkText(savedDraft);
    }
  }, [loadBudget, navigate]);

  useEffect(() => {
    return subscribeToMarketChanges((market) => {
      setActiveMarketState(market);
      setBudget(null);
      setAuctionOptions([]);
      setSelectedAuctions({});
      setAuctionSearch("");
      setReportState({
        loading: false,
        current: 0,
        total: 0,
        message: "",
        product: "",
      });
      reportCancelRef.current = true;
      autoLoadedAuctionRangeRef.current = "";
      loadBudget();
    });
  }, [loadBudget]);

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

  const handleLoadAuctionSelector = useCallback(
    async ({ quiet = false } = {}) => {
      if (auctionSelectorLoading || reportState.loading) return false;

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
        if (!quiet) {
          toast.success(`Loaded ${options.length} auctions`);
        }
        return true;
      } catch (loadError) {
        console.error("Auction selector load failed:", loadError);
        toast.error(loadError.message || "Could not load auction selector");
        return false;
      } finally {
        setAuctionSelectorLoading(false);
      }
    },
    [auctionSelectorLoading, reportState.loading]
  );

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

  useEffect(() => {
    const hasCompleteDateRange =
      reportFilters.from &&
      reportFilters.to &&
      reportFilters.from <= reportFilters.to;

    if (
      reportIncludeAllAuctions ||
      !hasCompleteDateRange ||
      auctionOptions.length ||
      auctionSelectorLoading ||
      reportState.loading
    ) {
      return;
    }

    const rangeKey = `${reportFilters.from}|${reportFilters.to}`;
    if (autoLoadedAuctionRangeRef.current === rangeKey) return;

    autoLoadedAuctionRangeRef.current = rangeKey;
    handleLoadAuctionSelector({ quiet: true }).then((loaded) => {
      if (!loaded && autoLoadedAuctionRangeRef.current === rangeKey) {
        autoLoadedAuctionRangeRef.current = "";
      }
    });
  }, [
    auctionOptions.length,
    auctionSelectorLoading,
    handleLoadAuctionSelector,
    reportFilters.from,
    reportFilters.to,
    reportIncludeAllAuctions,
    reportState.loading,
  ]);

  const handleToggleReportSection = (key) => {
    setReportSections((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const handleToggleReportDiagnostic = (key) => {
    setReportDiagnostics((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const handleSetAllReportSections = (selected) => {
    setReportSections(
      REPORT_SECTION_OPTIONS.reduce((next, option) => {
        next[option.key] = selected;
        return next;
      }, {})
    );
  };

  const handleSetAllReportDiagnostics = (selected) => {
    setReportDiagnostics(
      REPORT_DIAGNOSTIC_OPTIONS.reduce((next, option) => {
        next[option.key] = selected;
        return next;
      }, {})
    );
  };

  const handleCancelReportGeneration = () => {
    reportCancelRef.current = true;
    setReportState((current) => ({
      ...current,
      message: "Cancelling after current reads finish...",
    }));
    toast("Cancelling report generation...");
  };

  const handleGenerateReports = async (product = "excel") => {
    if (reportState.loading) return;
    reportCancelRef.current = false;
    const exportOption =
      REPORT_EXPORT_OPTIONS.find((option) => option.product === product) ||
      REPORT_EXPORT_OPTIONS[0];
    const productLabel = exportOption.label.toLowerCase();
    const selectedSectionCount = Object.values(reportSections).filter(Boolean)
      .length;

    if (selectedSectionCount === 0) {
      toast.error("Choose at least one report tab.");
      return;
    }

    if (
      exportOption.requiresSection &&
      !reportSections[exportOption.requiresSection]
    ) {
      toast.error(`Enable ${exportOption.label.replace(" CSV", "")} first.`);
      return;
    }

    if (
      !reportIncludeAllAuctions &&
      (!reportFilters.from || !reportFilters.to)
    ) {
      toast.error(
        "Choose both report dates, or enable every auction in the contract."
      );
      return;
    }

    if (
      !reportIncludeAllAuctions &&
      reportFilters.from &&
      reportFilters.to &&
      reportFilters.from > reportFilters.to
    ) {
      toast.error("The from date must be before the to date.");
      return;
    }

    const reportOptions = {
      sections: reportSections,
      diagnostics: reportDiagnostics,
    };

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
      if (reportCancelRef.current) {
        toast("Report generation cancelled.");
        return;
      }
      const reports = [];
      const errors = [];
      const selectedSet = new Set(
        Object.entries(selectedAuctions)
          .filter(([, selected]) => selected)
          .map(([address]) => address)
      );
      const shouldFilterByDate = !reportIncludeAllAuctions;
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

      if (shouldFilterByDate && auctionOptions.length) {
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
          if (reportCancelRef.current) return;
          try {
            const report = await readAuctionReport(
              target.address,
              target.index,
              targets.length,
              (message) =>
                !reportCancelRef.current &&
                setReportState((current) => ({
                  ...current,
                  message,
                })),
              targetIndex
            );
            if (reportCancelRef.current) return;
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

      if (reportCancelRef.current) {
        toast("Report generation cancelled.");
        return;
      }

      const cleanReports = shouldFilterByDate
        ? filterReportsByDate(reports.filter(Boolean), reportFilters)
        : reports.filter(Boolean);
      if (!cleanReports.length) {
        throw new Error("No auctions could be exported for these filters");
      }

      const payload = buildReportPayload(cleanReports, errors, reportOptions);

      if (product === "json") {
        downloadJsonReport(payload);
      } else if (product === "html") {
        downloadHtmlReport(payload);
      } else if (product === "timeline") {
        downloadCsvReport(payload.tables.timelineRows, "timeline");
      } else if (product === "bids") {
        downloadCsvReport(payload.tables.allBidRows, "all-bids");
      } else if (product === "payments") {
        downloadCsvReport(payload.tables.analysis.paymentRows, "payment-review");
      } else {
        downloadWorkbook(buildReportSheets(cleanReports, errors, reportOptions));
      }

      toast.success(
        `${productLabel} downloaded for ${cleanReports.length} auctions`
      );
    } catch (reportError) {
      console.error("Report generation failed:", reportError);
      toast.error(reportError.message || "Report generation failed");
    } finally {
      reportCancelRef.current = false;
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
  const hasReportFilters = Boolean(reportFilters.from && reportFilters.to);
  const datesRequired = !reportIncludeAllAuctions;
  const reportDateRangeInvalid =
    datesRequired &&
    Boolean(reportFilters.from && reportFilters.to) &&
    reportFilters.from > reportFilters.to;
  const reportScopeReady =
    reportIncludeAllAuctions ||
    Boolean(reportFilters.from && reportFilters.to && !reportDateRangeInvalid);
  const selectedReportSectionCount = Object.values(reportSections).filter(Boolean)
    .length;
  const selectedDiagnosticCount = Object.values(reportDiagnostics).filter(Boolean)
    .length;
  const selectedReportSectionSummary = summarizeReportSelection(
    REPORT_SECTION_OPTIONS,
    reportSections,
    "No tabs selected"
  );
  const selectedDiagnosticSummary = summarizeReportSelection(
    REPORT_DIAGNOSTIC_OPTIONS,
    reportDiagnostics,
    "No diagnostics active"
  );
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
        reportIncludeAllAuctions ||
        !hasReportFilters ||
        isEndTimeInDateRange(option.endTime, reportFilters);

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
    : reportIncludeAllAuctions
    ? "every auction in the contract"
    : "choose report dates";

  const handleSelectVisibleAuctions = () => {
    setSelectedAuctions((current) => {
      const next = { ...current };
      visibleAuctionOptions.forEach((option) => {
        next[option.address] = true;
      });
      return next;
    });
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

            <Box
              sx={{
                width: "100%",
                mb: 3,
                p: 2,
                border: "1px solid #d9dff2",
                borderRadius: 2,
                backgroundColor: "#f8faff",
              }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ textTransform: "uppercase", letterSpacing: 0.4 }}
              >
                Active market
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 800 }}>
                {activeMarket.label} market
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", overflowWrap: "anywhere" }}
              >
                Budgets, batch creation, and reports currently use this factory:
                {" "}
                {activeMarket.address || "No factory address configured"}
              </Typography>
            </Box>

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
                Build a focused export from selected auctions. Choose the date
                range, optional auction list, report tabs, diagnostics, and file
                type before downloading. Reports are generated from the active
                {` ${activeMarket.label.toLowerCase()} `}factory.
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
                  required={datesRequired}
                  disabled={reportIncludeAllAuctions}
                  error={reportDateRangeInvalid}
                  helperText={
                    datesRequired ? "Required for normal reports" : "Ignored"
                  }
                  fullWidth
                />
                <TextField
                  label="To end date"
                  type="date"
                  value={reportFilters.to}
                  onChange={(e) => handleDateFilterChange("to", e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  required={datesRequired}
                  disabled={reportIncludeAllAuctions}
                  error={reportDateRangeInvalid}
                  helperText={
                    reportDateRangeInvalid
                      ? "Must be after the from date"
                      : datesRequired
                      ? "Required for normal reports"
                      : "Ignored"
                  }
                  fullWidth
                />
              </Box>

              <Box
                component="label"
                sx={{
                  mt: 1,
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: 1,
                  alignItems: "flex-start",
                  p: 1.25,
                  borderRadius: 2,
                  border: reportIncludeAllAuctions
                    ? "1px solid #b9c7f2"
                    : "1px solid #e5e8f6",
                  backgroundColor: reportIncludeAllAuctions
                    ? "#f1f5ff"
                    : "#fbfcff",
                  cursor: "pointer",
                }}
              >
                <Checkbox
                  size="small"
                  checked={reportIncludeAllAuctions}
                  onChange={(e) =>
                    setReportIncludeAllAuctions(e.target.checked)
                  }
                  sx={{ p: 0.15 }}
                />
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    Export every auction in the contract
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                  >
                    Use this only when you intentionally want to ignore the date
                    range and read the full deployed auction list.
                  </Typography>
                </Box>
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
                      Leave empty to export the current date scope, or the full
                      contract only when that override is enabled.
                    </Typography>
                  </Box>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={handleLoadAuctionSelector}
                    disabled={auctionSelectorLoading || reportState.loading}
                  >
                    {auctionSelectorLoading
                      ? "Loading..."
                      : auctionOptions.length
                      ? "Reload Auctions"
                      : "Load Auctions"}
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
                  mt: 2,
                  border: "1px solid #d8def4",
                  borderRadius: 3,
                  backgroundColor: "#f8faff",
                  overflow: "hidden",
                }}
              >
                <Box sx={{ p: { xs: 1.5, sm: 2 } }}>
                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: { xs: "1fr", sm: "1fr auto" },
                      gap: 1.5,
                      alignItems: "center",
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                        Report builder
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        display="block"
                        sx={{ mt: 0.25 }}
                      >
                        Pick the workbook content once, then export it in any
                        format below.
                      </Typography>
                    </Box>
                    <Button
                      variant={reportBuilderOpen ? "contained" : "outlined"}
                      size="small"
                      onClick={() => setReportBuilderOpen((current) => !current)}
                      sx={{
                        borderRadius: 999,
                        px: 2,
                        justifySelf: { xs: "start", sm: "end" },
                        backgroundColor: reportBuilderOpen
                          ? "#103090"
                          : undefined,
                      }}
                    >
                      {reportBuilderOpen ? "Close options" : "Edit options"}
                    </Button>
                  </Box>

                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
                      gap: 1,
                      mt: 1.5,
                    }}
                  >
                    {[
                      {
                        label: "Tabs",
                        count: `${selectedReportSectionCount}/${REPORT_SECTION_OPTIONS.length}`,
                        summary: selectedReportSectionSummary,
                      },
                      {
                        label: "Diagnostics",
                        count: `${selectedDiagnosticCount}/${REPORT_DIAGNOSTIC_OPTIONS.length}`,
                        summary: selectedDiagnosticSummary,
                      },
                    ].map((item) => (
                      <Box
                        key={item.label}
                        sx={{
                          display: "grid",
                          gridTemplateColumns: "auto 1fr",
                          gap: 1,
                          alignItems: "center",
                          minHeight: 62,
                          px: 1.25,
                          py: 1,
                          borderRadius: 2,
                          backgroundColor: "#ffffff",
                          border: "1px solid #e7ebfb",
                        }}
                      >
                        <Box
                          sx={{
                            minWidth: 52,
                            px: 1,
                            py: 0.5,
                            borderRadius: 999,
                            textAlign: "center",
                            backgroundColor: "#eef3ff",
                            color: "#103090",
                            fontWeight: 800,
                            fontSize: 13,
                          }}
                        >
                          {item.count}
                        </Box>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="caption" sx={{ fontWeight: 800 }}>
                            {item.label}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            sx={{
                              mt: 0.25,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {item.summary}
                          </Typography>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </Box>

                {reportBuilderOpen && (
                  <Box
                    sx={{
                      borderTop: "1px solid #e5e9fa",
                      p: { xs: 1.5, sm: 2 },
                      display: "grid",
                      gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
                      gap: 2,
                      backgroundColor: "#ffffff",
                    }}
                  >
                    {[
                      {
                        title: "Tabs to include",
                        caption: "These become sheets in Excel and sections in HTML/JSON.",
                        options: REPORT_SECTION_OPTIONS,
                        selection: reportSections,
                        onToggle: handleToggleReportSection,
                        onAll: handleSetAllReportSections,
                      },
                      {
                        title: "Diagnostics to run",
                        caption: "These rules feed the Review Flags checklist.",
                        options: REPORT_DIAGNOSTIC_OPTIONS,
                        selection: reportDiagnostics,
                        onToggle: handleToggleReportDiagnostic,
                        onAll: handleSetAllReportDiagnostics,
                      },
                    ].map((group) => (
                      <Box key={group.title}>
                        <Box
                          display="flex"
                          justifyContent="space-between"
                          alignItems="flex-start"
                          gap={1}
                          flexWrap="wrap"
                        >
                          <Box>
                            <Typography
                              variant="caption"
                              sx={{ fontWeight: 800 }}
                            >
                              {group.title}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                              sx={{ maxWidth: 360 }}
                            >
                              {group.caption}
                            </Typography>
                          </Box>
                          <Box display="flex" gap={0.5}>
                            <Button
                              size="small"
                              variant="text"
                              onClick={() => group.onAll(true)}
                              sx={{ minWidth: 0 }}
                            >
                              All
                            </Button>
                            <Button
                              size="small"
                              variant="text"
                              onClick={() => group.onAll(false)}
                              sx={{ minWidth: 0 }}
                            >
                              None
                            </Button>
                          </Box>
                        </Box>

                        <Box sx={{ display: "grid", gap: 0.75, mt: 1.25 }}>
                          {group.options.map((option) => {
                            const checked = Boolean(group.selection[option.key]);

                            return (
                              <Box
                                key={option.key}
                                component="label"
                                sx={{
                                  display: "grid",
                                  gridTemplateColumns: "auto 1fr",
                                  gap: 0.75,
                                  alignItems: "flex-start",
                                  cursor: "pointer",
                                  p: 1,
                                  borderRadius: 2,
                                  backgroundColor: checked
                                    ? "#f1f5ff"
                                    : "#fbfcff",
                                  border: checked
                                    ? "1px solid #c7d2f5"
                                    : "1px solid #edf0fb",
                                  transition:
                                    "border-color 140ms ease, background-color 140ms ease",
                                  "&:hover": {
                                    backgroundColor: checked
                                      ? "#eef3ff"
                                      : "#f7f9ff",
                                  },
                                }}
                              >
                                <Checkbox
                                  checked={checked}
                                  onChange={() => group.onToggle(option.key)}
                                  size="small"
                                  sx={{ p: 0.15 }}
                                />
                                <Box sx={{ minWidth: 0 }}>
                                  <Typography
                                    variant="caption"
                                    sx={{ fontWeight: 800 }}
                                  >
                                    {option.label}
                                  </Typography>
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    display="block"
                                  >
                                    {option.description}
                                  </Typography>
                                </Box>
                              </Box>
                            );
                          })}
                        </Box>
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "1fr",
                    sm: "1fr 1fr",
                    md: "1fr 1fr 1fr",
                  },
                  gap: 1.5,
                  mt: 2,
                }}
              >
                {REPORT_EXPORT_OPTIONS.map((option) => {
                  const disabled =
                    reportState.loading ||
                    selectedReportSectionCount === 0 ||
                    !reportScopeReady ||
                    (option.requiresSection &&
                      !reportSections[option.requiresSection]);

                  return (
                    <Box
                      key={option.product}
                      sx={{
                        border: option.primary
                          ? "1px solid #bdc9f2"
                          : "1px solid #dce1f4",
                        borderRadius: 2,
                        p: 1.25,
                        backgroundColor: option.primary ? "#f6f8ff" : "#fff",
                        transition:
                          "border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease",
                        "&:hover": {
                          borderColor: disabled ? undefined : "#aebbef",
                          boxShadow: disabled
                            ? undefined
                            : "0 8px 20px rgba(16, 48, 144, 0.08)",
                          transform: disabled ? undefined : "translateY(-1px)",
                        },
                      }}
                    >
                      <Button
                        variant={option.primary ? "contained" : "outlined"}
                        sx={{
                          width: "100%",
                          minHeight: 42,
                          borderRadius: 1.5,
                          backgroundColor: option.primary ? "#103090" : undefined,
                        }}
                        onClick={() => handleGenerateReports(option.product)}
                        disabled={disabled}
                      >
                        {option.label}
                      </Button>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        display="block"
                        sx={{ mt: 0.75, minHeight: 34 }}
                      >
                        {option.description}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
              {reportState.loading && (
                <Box sx={{ mt: 2, width: "100%" }}>
                  <LinearProgress variant="determinate" value={reportProgress} />
                  <Box
                    display="flex"
                    justifyContent="space-between"
                    alignItems="center"
                    gap={1}
                    flexWrap="wrap"
                    sx={{ mt: 0.75 }}
                  >
                    <Typography variant="caption" color="text.secondary">
                      {reportState.current}/{reportState.total} auctions -{" "}
                      {reportState.message}
                    </Typography>
                    <Button
                      variant="outlined"
                      color="error"
                      size="small"
                      onClick={handleCancelReportGeneration}
                    >
                      Cancel
                    </Button>
                  </Box>
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

