import React from "react";
import { ListItemButton, ListItemText, Drawer } from "@mui/material";
import { makeStyles } from "@mui/styles";
import styles1 from "./../styles/components.module.scss";
import { useLocation, useNavigate } from "react-router-dom";

const useStyles = makeStyles({
  paper: {
    width: "min(285px, 84vw)",
    background:
      "linear-gradient(155deg, rgba(255, 255, 255, 0.99), rgba(250, 251, 255, 0.97)) !important",
    borderRight: "1px solid rgba(16, 48, 144, 0.045) !important",
    boxShadow:
      "7px 0 18px rgba(16, 48, 144, 0.07), inset -1px 0 0 rgba(255, 255, 255, 0.58) !important",
    backdropFilter: "blur(2px) saturate(1.01)",
    WebkitBackdropFilter: "blur(2px) saturate(1.01)",
    contain: "paint",
    overflowX: "hidden",
  },
  list: {
    minHeight: "100%",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "2.35rem 0.9rem 1.1rem",
  },
  navGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "0.85rem",
  },
  item: {
    minHeight: "4rem",
    color: "#101070 !important",
    display: "grid !important",
    gridTemplateColumns: "3.1rem minmax(0, 1fr)",
    alignItems: "center",
    columnGap: "0.8rem",
    borderRadius: "14px !important",
    padding: "0.6rem 0.75rem !important",
    position: "relative",
    overflow: "hidden",
    transition:
      "background-color 150ms ease, box-shadow 150ms ease, transform 150ms ease, color 150ms ease",
    cursor: "pointer",
    "&::before": {
      content: '""',
      position: "absolute",
      inset: 0,
      background:
        "linear-gradient(110deg, rgba(255, 255, 255, 0.36), transparent 42%, rgba(240, 208, 112, 0.13))",
      opacity: 0,
      transition: "opacity 150ms ease",
      pointerEvents: "none",
    },
    "&:hover": {
      backgroundColor: "rgba(224, 224, 255, 0.72)",
      boxShadow: "none",
      transform: "translate3d(1px, 0, 0)",
    },
    "&:hover::before": {
      opacity: 1,
    },
  },
  activeItem: {
    background:
      "linear-gradient(135deg, rgba(224, 224, 255, 0.82), rgba(255, 255, 255, 0.7)) !important",
    boxShadow: "inset 0 0 0 1px rgba(16, 48, 144, 0.055)",
  },
  iconTile: {
    width: "3.1rem",
    height: "3.1rem",
    flex: "0 0 3.1rem",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    borderRadius: "0",
    background: "transparent",
    boxShadow: "none",
    transform: "translate3d(0, 0.16rem, 0)",
    "& > span": {
      marginRight: "0 !important",
      transform: "scale(0.68)",
      backgroundPosition: "center !important",
      backgroundSize: "contain !important",
    },
  },
  primaryText: {
    "& .MuiListItemText-root": {
      height: "3.1rem",
      display: "flex",
      alignItems: "center",
      margin: "0 !important",
      minWidth: 0,
    },
    "& .MuiListItemText-primary": {
      fontSize: "1.02rem",
      fontWeight: 400,
      lineHeight: 1.2,
      letterSpacing: "0",
      color: "inherit",
      whiteSpace: "nowrap",
    },
  },
  adminSection: {
    paddingTop: "1rem",
    borderTop: "1px solid rgba(16, 48, 144, 0.055)",
  },
  adminItem: {
    minHeight: "3.25rem",
    display: "flex !important",
    alignItems: "center !important",
    justifyContent: "center !important",
    color: "#222222 !important",
    fontWeight: 400,
    background:
      "linear-gradient(135deg, rgba(209, 243, 252, 0.2), rgba(248, 250, 255, 0.92)) !important",
    "& .MuiListItemText-root": {
      width: "100%",
      height: "auto",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      margin: "0 !important",
    },
    "& .MuiListItemText-primary": {
      fontSize: "0.95rem",
      fontWeight: 400,
      letterSpacing: "0.04em",
      textAlign: "center !important",
    },
  },
  link: {
    textDecoration: "none",
    color: "inherit",
    "&:hover": {
      textDecoration: "none",
    },
  },
});

const DrawerComponent = (props) => {
  const nav = useNavigate();
  const location = useLocation();
  const classes = useStyles();

  const itemClassName = (path) =>
    [classes.item, classes.primaryText, location.pathname === path ? classes.activeItem : ""]
      .filter(Boolean)
      .join(" ");

  const sideList = () => (
    <div
      className={classes.list}
      role="presentation"
      onClick={props.toggleDrawerHandler}
      onKeyDown={props.toggleDrawerHandler}
    >
      <div className={classes.navGroup}>
        <ListItemButton className={itemClassName("/")} onClick={() => nav("/")}>
          <span className={classes.iconTile}>
            <span className={styles1.homePage}></span>
          </span>
          <ListItemText>Back to Login</ListItemText>
        </ListItemButton>

        <ListItemButton
          className={itemClassName("/auctions-list")}
          onClick={() => nav("/auctions-list")}
        >
          <span className={classes.iconTile}>
            <span className={styles1.ViewAuctions}></span>
          </span>
          <ListItemText>View Auctions</ListItemText>
        </ListItemButton>

        <ListItemButton
          className={itemClassName("/open-auction")}
          onClick={() => nav("/open-auction")}
        >
          <span className={classes.iconTile}>
            <span className={styles1.createAuction}></span>
          </span>
          <ListItemText>Start An Auction</ListItemText>
        </ListItemButton>

        <ListItemButton className={`${classes.item} ${classes.primaryText}`}>
          <span className={classes.iconTile}>
            <span className={styles1.metamaskIcon}></span>
          </span>
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
      </div>

      <div className={classes.adminSection}>
        <ListItemButton
          className={`${itemClassName("/manage-budget")} ${classes.adminItem}`}
          dense
          onClick={() => nav("/manage-budget")}
        >
          <ListItemText>-- Admin Zone --</ListItemText>
        </ListItemButton>
      </div>
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
