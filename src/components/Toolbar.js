import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { AppBar, Button, Toolbar, Typography } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import HomeIcon from "@mui/icons-material/Home";
import { useNavigate } from "react-router-dom";
import { getDefaultBudget } from "../real_ethereum/budget";
import { subscribeToBudgetChanges } from "../real_ethereum/budget";
import {
  getActiveMarket,
  getActiveFactoryAddress,
  getMarketOptions,
  isValidAddress,
  setActiveMarket,
  setDevelopmentFactoryAddress,
  subscribeToMarketChanges,
} from "../real_ethereum/marketConfig";
import componentStyles from "./../styles/components.module.scss";

const ClockDisplay = memo(() => {
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    const tick = () => {
      if (!document.hidden) {
        setCurrentTime(new Date());
      }
    };

    const interval = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const formattedTime = currentTime.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <Typography
      variant="body2"
      style={{
        color: "#F0F0F0",
        border: "1px solid rgba(240, 240, 240, 0.06)",
        padding: "0.5rem",
        borderRadius: "20px",
      }}
    >
      {formattedTime}
    </Typography>
  );
});

ClockDisplay.displayName = "ClockDisplay";

const ToolbarComponent = (props) => {
  const navigate = useNavigate();
  const [budget, setBudget] = useState(null);
  const [budgetRefreshing, setBudgetRefreshing] = useState(false);
  const [activeMarket, setActiveMarketState] = useState(getActiveMarket());
  const [marketOptions, setMarketOptions] = useState(getMarketOptions());
  const [switchingMarketId, setSwitchingMarketId] = useState("");
  const activeMarketIdRef = useRef(activeMarket.id);
  const budgetRequestIdRef = useRef(0);
  const switchTimerRef = useRef(null);

  const settleMarketSwitch = useCallback((delay = 320) => {
    window.clearTimeout(switchTimerRef.current);
    switchTimerRef.current = window.setTimeout(() => {
      setSwitchingMarketId("");
    }, delay);
  }, []);

  useEffect(() => {
    return () => window.clearTimeout(switchTimerRef.current);
  }, []);

  const fetchBudget = useCallback(async ({ force = false } = {}) => {
    const marketIdForRequest = activeMarketIdRef.current;
    const requestId = budgetRequestIdRef.current + 1;
    budgetRequestIdRef.current = requestId;
    setBudgetRefreshing(true);

    try {
      const result = await getDefaultBudget({ force });
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
    return subscribeToBudgetChanges(async ({ userAddress, factoryAddress, budget: nextBudget }) => {
      const activeFactoryAddress = String(getActiveFactoryAddress() || "").toLowerCase();

      if (factoryAddress && factoryAddress !== activeFactoryAddress) return;

      try {
        const accounts = await window.ethereum?.request?.({ method: "eth_accounts" });
        const account = String(accounts?.[0] || "").toLowerCase();

        if (userAddress && account && userAddress !== account) return;

        if (nextBudget !== null && nextBudget !== undefined) {
          budgetRequestIdRef.current += 1;
          setBudget(String(nextBudget));
          setBudgetRefreshing(false);
          return;
        }

        fetchBudget({ force: true });
      } catch (error) {
        fetchBudget({ force: true });
      }
    });
  }, [fetchBudget]);

  useEffect(() => {
    return subscribeToMarketChanges((market, meta = {}) => {
      activeMarketIdRef.current = market.id;
      setActiveMarketState(market);
      setMarketOptions(getMarketOptions());
      if (meta.reason === "label") {
        return;
      }

      budgetRequestIdRef.current += 1;
      setSwitchingMarketId(market.id);
      settleMarketSwitch();
      fetchBudget();
    });
  }, [fetchBudget, settleMarketSwitch]);

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
      settleMarketSwitch();
    } catch (error) {
      window.alert(error.message || "Could not switch market.");
    }
  };

  const activeMarketIndex = Math.max(
    0,
    marketOptions.findIndex((market) => market.id === activeMarket.id)
  );

  return (
    <div style={{ flexGrow: 1 }}>
      <AppBar position="static">
        <Toolbar
          className={componentStyles.appToolbar}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
            <Button
              variant="text"
              className={componentStyles.toolbarIconButton}
              onClick={props.openDrawerHandler}
            >
              <MenuIcon htmlColor="#F0B030" fontSize="large" />
            </Button>

            <Button
              variant="text"
              className={componentStyles.toolbarIconButton}
              onClick={() => navigate("/auctions-list")}
            >
              <HomeIcon htmlColor="#F0B030" fontSize="large" />
            </Button>

            <Typography
              component="div"
              className={`${componentStyles.bigTitle} ${componentStyles.toolbarTitle}`}
            >
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
              <span className={componentStyles.toolbarPillLabel}>Budget:</span>
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

            <ClockDisplay />
          </div>
        </Toolbar>
      </AppBar>
    </div>
  );
};

export default memo(ToolbarComponent);
