import React, { useEffect, useState } from "react";
import { AppBar, Button, Toolbar, Typography } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import HomeIcon from "@mui/icons-material/Home";
import { useNavigate } from "react-router-dom";
import { getDefaultBudget } from "../pages/ManageBudget/ManageBudgetPage";
import componentStyles from "./../styles/components.module.scss";

const ToolbarComponent = (props) => {
  const navigate = useNavigate();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [budget, setBudget] = useState(null); // ✅ בתוך ToolbarComponent


  // Update clock every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);


  // הבאת תקציב מהבלוקצ'יין
  useEffect(() => {
    const fetchBudget = async () => {
      try {
        const result = await getDefaultBudget();
        setBudget(result);
      } catch (err) {
        console.error("❌ Failed to fetch budget:", err);
      }
    };

    fetchBudget();
  }, []);


  const formatTime = (date) =>
    date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div style={{ flexGrow: 1 }}>
      <AppBar position="static">
        <Toolbar
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            backgroundColor: `#103090`,
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

          {/* צד ימין – שעון + תקציב */}
          <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginRight: "1rem" }}>
            <Typography
              variant="body2"
              style={{
                color: "#F0F0F0",
                border: "1px solid rgba(240, 240, 240, 0.06)",
                padding: "0.5rem",
                borderRadius: "20px",
              }}
            >
              💰 Budget: {budget ?? "Loading..."}
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
              🕒 {formatTime(currentTime)}
            </Typography>
          </div>
        </Toolbar>
      </AppBar>
    </div>
  );
};

export default ToolbarComponent;
