import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { AppBar, Button, Toolbar, Typography } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import HomeIcon from "@mui/icons-material/Home";
import SensorsOutlinedIcon from "@mui/icons-material/SensorsOutlined";
import AccountBalanceWalletOutlinedIcon from "@mui/icons-material/AccountBalanceWalletOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import { useNavigate } from "react-router-dom";
import { getDefaultBudget } from "../real_ethereum/budget";
import { subscribeToBudgetChanges } from "../real_ethereum/budget";
import {
  getActiveMarket,
  getActiveFactoryAddress,
  getMarketOptions,
  subscribeToMarketChanges,
} from "../real_ethereum/marketConfig";
import { getEthereumAccounts } from "../real_ethereum/ethereumProvider";
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
    <div
      className={`${componentStyles.toolbarPill} ${componentStyles.clockPill}`}
      title="Current time"
      aria-label={`Current time ${formattedTime}`}
    >
      <ScheduleOutlinedIcon
        className={componentStyles.toolbarPillIcon}
        fontSize="small"
        aria-hidden="true"
      />
      <span className={componentStyles.toolbarPillValue}>{formattedTime}</span>
    </div>
  );
});

ClockDisplay.displayName = "ClockDisplay";

const ToolbarComponent = (props) => {
  const navigate = useNavigate();
  const [budget, setBudget] = useState(null);
  const [budgetRefreshing, setBudgetRefreshing] = useState(false);
  const [activeMarket, setActiveMarketState] = useState(getActiveMarket());
  const [, setMarketOptions] = useState(getMarketOptions());
  const activeMarketIdRef = useRef(activeMarket.id);
  const budgetRequestIdRef = useRef(0);
  const isProductionEnvironment = activeMarket.environment !== "testing";
  const environmentStatusText = isProductionEnvironment ? "Live" : "Development";

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
        const accounts = await getEthereumAccounts();
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
      fetchBudget();
    });
  }, [fetchBudget]);

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
              className={`${componentStyles.toolbarPill} ${componentStyles.environmentPill} ${
                isProductionEnvironment
                  ? componentStyles.environmentPillLive
                  : componentStyles.environmentPillDevelopment
              }`}
              title={`${activeMarket.description}: ${activeMarket.address || "No factory address configured"}`}
              aria-label={`${environmentStatusText} environment`}
            >
              {isProductionEnvironment && (
                <span
                  className={componentStyles.environmentLiveDot}
                  aria-hidden="true"
                />
              )}
              <SensorsOutlinedIcon
                className={componentStyles.toolbarPillIcon}
                fontSize="small"
                aria-hidden="true"
              />
              <span className={componentStyles.toolbarPillValue}>
                {environmentStatusText}
              </span>
            </div>

            <div
              className={`${componentStyles.toolbarPill} ${
                budgetRefreshing ? componentStyles.toolbarPillRefreshing : ""
              }`}
              title={budgetRefreshing ? "Budget is refreshing" : "Current budget"}
            >
              <AccountBalanceWalletOutlinedIcon
                className={componentStyles.toolbarPillIcon}
                fontSize="small"
                aria-hidden="true"
              />
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
