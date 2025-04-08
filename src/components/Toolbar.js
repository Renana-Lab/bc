import React from "react";
import { AppBar, Button, Toolbar, Typography } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import HomeIcon from "@mui/icons-material/Home";
import { useNavigate } from "react-router-dom"; // ✅ useNavigate

import componentStyles from "./../styles/components.module.scss";

const ToolbarComponent = (props) => {
  const navigate = useNavigate(); // ✅ corrected

  return (
    <div style={{ flexGrow: 1 }}>
      <AppBar position="static">
        <Toolbar
          style={{
            display: "flex",
            justifyContent: "flex-start",
            gap: "1rem",
            backgroundColor: `#103090`,
          }}
        >
          <Button variant="text" onClick={props.openDrawerHandler}>
            <MenuIcon htmlColor="#F0B030" color="inherit" fontSize="large" />
          </Button>

          <Button variant="text" onClick={() => navigate("/auctions-list")}>
            <HomeIcon htmlColor="#F0B030" fontSize="large" color="inherit" />
          </Button>

          <Typography variant="h6" className={componentStyles.bigTitle}>
            Blockchain Data Market
          </Typography>
        </Toolbar>
      </AppBar>
    </div>
  );
};

export default ToolbarComponent;
