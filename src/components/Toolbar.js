import React, { memo, useCallback, useEffect, useState } from "react";
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
  const [activeMarket, setActiveMarketState] = useState(getActiveMarket());
  const [marketOptions, setMarketOptions] = useState(getMarketOptions());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const fetchBudget = useCallback(async () => {
    try {
      const result = await getDefaultBudget();
      setBudget(result);
    } catch (err) {
      console.error("Failed to fetch budget:", err);
    }
  }, []);

  useEffect(() => {
    fetchBudget();
  }, [fetchBudget]);

  useEffect(() => {
    return subscribeToMarketChanges((market) => {
      setActiveMarketState(market);
      setMarketOptions(getMarketOptions());
      setBudget(null);
      fetchBudget();
    });
  }, [fetchBudget]);

  const handleMarketSwitch = (marketId) => {
    try {
      const market = marketOptions.find((option) => option.id === marketId);

      if (marketId === "dev" && !market?.address) {
        const address = window.prompt(
          "Paste the development factory contract address"
        );

        if (!address) return;
        if (!isValidAddress(address)) {
          window.alert("That does not look like a valid contract address.");
          return;
        }

        setDevelopmentFactoryAddress(address);
        setMarketOptions(getMarketOptions());
      }

      setActiveMarketState(setActiveMarket(marketId));
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
              className={componentStyles.marketSwitch}
              aria-label="Market selector"
            >
              {marketOptions.map((market) => (
                <button
                  key={market.id}
                  type="button"
                  className={
                    activeMarket.id === market.id
                      ? componentStyles.marketSwitchActive
                      : ""
                  }
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

            <Typography
              variant="body2"
              style={{
                color: "#F0F0F0",
                border: "1px solid rgba(240, 240, 240, 0.06)",
                padding: "0.5rem",
                borderRadius: "20px",
              }}
            >
              Budget: {budget ?? "Loading..."}
            </Typography>

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
