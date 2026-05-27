import React from "react";
import { ListItemButton, ListItemText, Drawer } from "@mui/material";
import { makeStyles } from "@mui/styles";
import styles1 from "./../styles/components.module.scss";
import { useNavigate } from "react-router-dom";

const useStyles = makeStyles({
  paper: {
    background:
      "linear-gradient(145deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 255, 0.94)) !important",
    borderRight: "1px solid rgba(16, 48, 144, 0.04) !important",
    boxShadow:
      "8px 0 20px rgba(16, 48, 144, 0.07), inset -1px 0 0 rgba(255, 255, 255, 0.54) !important",
    backdropFilter: "blur(5px) saturate(1.02)",
    WebkitBackdropFilter: "blur(5px) saturate(1.02)",
    contain: "paint",
  },
  list: {
    width: 250,
    marginTop: "40px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "10px",
  },
  item: {
    color: "#101070",
    display: "flex",
    alignItems: "center",
    borderRadius: "12px",
    transition: "background-color 0.3s ease",
    cursor: "pointer",
    "&:hover": {
      backgroundColor: "#e0e0ff",
      borderRadius: "20px",
    },
  },
  link: {
    textDecoration: "none",
    color: "#101070",
    "&:hover": {
      textDecoration: "underline",
    },
  },
});

const DrawerComponent = (props) => {
  const nav = useNavigate();
  const classes = useStyles();

  const sideList = () => (
    <div
      className={classes.list}
      role="presentation"
      onClick={props.toggleDrawerHandler}
      onKeyDown={props.toggleDrawerHandler}
    >
      <ListItemButton className={classes.item} onClick={() => nav("/")}>
        <span className={styles1.homePage}></span>
        <ListItemText>Back to Login</ListItemText>
      </ListItemButton>

      <ListItemButton
        className={classes.item}
        onClick={() => nav("/auctions-list")}
      >
        <span className={styles1.ViewAuctions}></span>
        <ListItemText>View Auctions</ListItemText>
      </ListItemButton>

      <ListItemButton
        className={classes.item}
        onClick={() => nav("/open-auction")}
      >
        <span className={styles1.createAuction}></span>
        <ListItemText>Start An Auction</ListItemText>
      </ListItemButton>

      <ListItemButton className={classes.item}>
        <span className={styles1.metamaskIcon}></span>
        <ListItemText>
          <a
            href="https://support.metamask.io/start/getting-started-with-metamask/"
            className={classes.link}
            target="_blank"
            rel="noopener noreferrer"
          >
            Metamask Tutorial
          </a>
        </ListItemText>
      </ListItemButton>

      <ListItemButton
        sx={{ marginTop: "230%", textAlign: "center" }}
        className={classes.item}
        dense
        onClick={() => nav("/manage-budget")}
      >
        <ListItemText> - - ADMIN ZONE - - </ListItemText>
      </ListItemButton>
    </div>
  );

  return (
    <Drawer
      open={props.open}
      onClose={props.toggleDrawerHandler}
      PaperProps={{ className: classes.paper }}
    >
      {sideList()}
    </Drawer>
  );
};

export default DrawerComponent;
