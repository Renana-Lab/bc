import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { AppBar, Button, Toolbar, Typography } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import HomeIcon from "@mui/icons-material/Home";
import { useNavigate } from "react-router-dom";
import { getDefaultBudget } from "../real_ethereum/budget";
import {
  getActiveMarket,
  getMarketOptions,
  isValidAddress,
  setActiveMarket,
  setDevelopmentFactoryAddress,
  subscribeToMarketChanges,
} from "../real_ethereum/marketConfig";
import componentStyles from "./../styles/components.module.scss";

const ToolbarComponent = (props) => {
  const navigate = useNavigate();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [budget, setBudget] = useState(null);
  const [budgetRefreshing, setBudgetRefreshing] = useState(false);
  const [activeMarket, setActiveMarketState] = useState(getActiveMarket());
  const [marketOptions, setMarketOptions] = useState(getMarketOptions());
  const [switchingMarketId, setSwitchingMarketId] = useState("");
  const activeMarketIdRef = useRef(activeMarket.id);
  const budgetRequestIdRef = useRef(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const fetchBudget = useCallback(async () => {
    const marketIdForRequest = activeMarketIdRef.current;
    const requestId = budgetRequestIdRef.current + 1;
    budgetRequestIdRef.current = requestId;
    setBudgetRefreshing(true);

    try {
      const result = await getDefaultBudget();
      if (
        requestId === budgetRequestIdRef.current &&
        marketIdForRequest === activeMarketIdRef.current
      ) {
        setBudget(result);
        setBudgetRefreshing(false);
      }
    } catch (err) {
      if (
        requestId === budgetRequestIdRef.current &&
        marketIdForRequest === activeMarketIdRef.current
      ) {
        setBudgetRefreshing(false);
      }
      console.error("Failed to fetch budget:", err);
    }
  }, []);

  useEffect(() => {
    fetchBudget();
  }, [fetchBudget]);

  useEffect(() => {
    return subscribeToMarketChanges((market) => {
      activeMarketIdRef.current = market.id;
      budgetRequestIdRef.current += 1;
      setActiveMarketState(market);
      setMarketOptions(getMarketOptions());
      setSwitchingMarketId(market.id);
      window.setTimeout(() => setSwitchingMarketId(""), 520);
      fetchBudget();
    });
  }, [fetchBudget]);

  const handleMarketSwitch = (marketId) => {
    try {
      const market = marketOptions.find((option) => option.id === marketId);

      if (marketId === "dev" && !market?.address) {
        const address = window.prompt(
          "Paste the development factory contract address",
        );

        if (!address) return;
        if (!isValidAddress(address)) {
          window.alert("That does not look like a valid contract address.");
          return;
        }

        setDevelopmentFactoryAddress(address);
        setMarketOptions(getMarketOptions());
      }

      setSwitchingMarketId(marketId);
      const nextMarket = setActiveMarket(marketId);
      activeMarketIdRef.current = nextMarket.id;
      setActiveMarketState(nextMarket);
      window.setTimeout(() => setSwitchingMarketId(""), 520);
      navigate("/auctions-list");
    } catch (error) {
      window.alert(error.message || "Could not switch market.");
    }
  };

  const formatTime = (date) =>
    date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const activeMarketIndex = Math.max(
    0,
    marketOptions.findIndex((market) => market.id === activeMarket.id)
  );

  return (
    <div style={{ flexGrow: 1 }}>
      <AppBar position="static">
        <Toolbar
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            backgroundColor: "#103090",
          }}
        >
          <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
            <Button variant="text" onClick={props.openDrawerHandler}>
              <MenuIcon htmlColor="#F0B030" fontSize="large" />
            </Button>

            <Button variant="text" onClick={() => navigate("/auctions-list")}>
              <HomeIcon htmlColor="#F0B030" fontSize="large" />
            </Button>

            <Typography variant="h6" className={componentStyles.bigTitle}>
              Blockchain Data Market
            </Typography>
          </div>

          <div
            style={{
              display: "flex",
              gap: "1rem",
              alignItems: "center",
              marginRight: "1rem",
            }}
          >
            <div
              className={`${componentStyles.marketSwitch} ${
                switchingMarketId ? componentStyles.marketSwitchChanging : ""
              }`}
              style={{
                "--market-index": activeMarketIndex,
                "--market-count": marketOptions.length || 2,
              }}
              aria-label="Market selector"
            >
              {marketOptions.map((market) => (
                <button
                  key={market.id}
                  type="button"
                  className={[
                    activeMarket.id === market.id ? componentStyles.marketSwitchActive : "",
                    switchingMarketId === market.id ? componentStyles.marketSwitchPending : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => handleMarketSwitch(market.id)}
                  title={
                    market.address
                      ? `${market.description}: ${market.address}`
                      : "Click to set the development factory address"
                  }
                >
                  {market.label}
                </button>
              ))}
            </div>

            <div
              className={`${componentStyles.toolbarPill} ${
                budgetRefreshing ? componentStyles.toolbarPillRefreshing : ""
              }`}
              title={budgetRefreshing ? "Budget is refreshing" : "Current budget"}
            >
              <span className={componentStyles.toolbarPillLabel}>Budget</span>
              <span className={componentStyles.toolbarPillValue}>
                {budget ?? "—"}
              </span>
              {budgetRefreshing && (
                <span
                  className={componentStyles.toolbarPillDot}
                  aria-label="Refreshing budget"
                />
              )}
            </div>

            <Typography
              variant="body2"
              style={{
                color: "#F0F0F0",
                border: "1px solid rgba(240, 240, 240, 0.06)",
                padding: "0.5rem",
                borderRadius: "20px",
              }}
            >
              {formatTime(currentTime)}
            </Typography>
          </div>
        </Toolbar>
      </AppBar>
    </div>
  );
};

export default memo(ToolbarComponent);
