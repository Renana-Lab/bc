import React from "react";
import { ListItem, ListItemText, Drawer } from "@mui/material";
import { makeStyles } from "@mui/styles";
import styles1 from "./../styles/components.module.scss";
import { useNavigate } from "react-router-dom";

const useStyles = makeStyles({
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
      <ListItem className={classes.item} button onClick={() => nav("/")}>
        <span className={styles1.homePage}></span>
        <ListItemText >Home</ListItemText>
      </ListItem>

      <ListItem className={classes.item} button onClick={() => nav("/auctions-list")}>
        <span className={styles1.ViewAuctions}></span>
        <ListItemText >
          View Auctions
        </ListItemText>
      </ListItem>

      <ListItem className={classes.item} button  onClick={() => nav("/open-auction")}>
        <span className={styles1.createAuction}></span>
        <ListItemText>
          Start An Auction
        </ListItemText>
      </ListItem>

      <ListItem className={classes.item} button>
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
      </ListItem>
    </div>
  );

  return (
    <Drawer open={props.open} onClose={props.toggleDrawerHandler}>
      {sideList()}
    </Drawer>
  );
};

export default DrawerComponent;
