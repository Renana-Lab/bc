import React, { useState } from "react";
import withStyles from "@material-ui/core/styles/withStyles";
import styles1 from "./../styles/components.module.scss";
// import { Router } from "./../routes";
// import { Link } from "./../routes";

import {
  ListItem,
  ListItemText,
  Drawer,
  Button
} from "@material-ui/core";
import InboxIcon from "@material-ui/icons/MoveToInbox";
import MailIcon from "@material-ui/icons/Mail";
// import Link from "../routes";


const styles = (theme) => ({
  list: {
    width: 250
  },
  fullList: {
    width: "auto"
  }
});

const DrawerComponent = (props) => {
  const { classes } = props;

  const sideList = () => (
    <div
      className={classes.list}
      role="presentation"
      onClick={props.toggleDrawerHandler}
      onKeyDown={props.toggleDrawerHandler}
    >
           <ListItem button key="Home Page" >
            <span className={styles1.homePage}></span>
            {/* <Link route={`/`}> */}
              <ListItemText>
              Home
              </ListItemText>
            {/* </Link> */}
          </ListItem>
     <ListItem button key="Metamask Tutorial">
            <span className={styles1.metamaskIcon}></span>
            <ListItemText >
            <a className={styles1.link} href="https://support.metamask.io/hc/en-us/articles/360015489531-Getting-started-with-MetaMask">Metamask Tutorial</a>    
              </ListItemText>
          </ListItem>
        <ListItem button key="Create an Auction">
         <span className={styles1.createAuction}></span>
            {/* <Link route={`/open-auction`}> */}
              <ListItemText>
              Start An Auction
              </ListItemText>
            {/* </Link> */}
          </ListItem>
          <ListItem button key="View Auctions">
          <span className={styles1.ViewAuctions}></span>
          {/* <Link route={`/auctions-list`}> */}
              <ListItemText>
              View Auctions
              </ListItemText>
            {/* </Link> */}
          </ListItem>
    </div>
  );

  return (
    <Drawer open={props.open} onClose={props.toggleDrawerHandler}>
      {sideList()}
    </Drawer>
  );
};

export default withStyles(styles)(DrawerComponent);
