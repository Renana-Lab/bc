import React, { useState } from "react";
import { withStyles } from "@material-ui/core/styles";
import {
  AppBar,
  Toolbar,
  IconButton,
} from "@material-ui/core";
import MenuIcon from "@material-ui/icons/Menu";
import HomeIcon from "@material-ui/icons/Home";

// import { Link } from "../routes";
import componentStyles from "./../styles/components.module.scss";

const styles = (theme) => ({
  grow: {
    flexGrow: 1,
  },
  menuButton: {
    marginRight: theme.spacing(2),
  },
  homeButton:{
    float:"right",
  },
  title: {
    display: "none",
    [theme.breakpoints.up("sm")]: {
      display: "block",
    },
  },
  inputRoot: {
    color: "inherit",
  },
  inputInput: {
    padding: theme.spacing(1, 1, 1, 7),
    transition: theme.transitions.create("width"),
    width: "100%",
    [theme.breakpoints.up("md")]: {
      width: 200,
    },
  },
  sectionDesktop: {
    display: "none",
    [theme.breakpoints.up("md")]: {
      display: "flex",
    },
  },
  sectionMobile: {
    display: "flex",
    [theme.breakpoints.up("md")]: {
      display: "none",
    },
  },
});

const ToolbarComponent = (props) => {
  // const [anchorEl, setAnchorEl] = useState(false);
  // const [mobileMoreAnchorEl, setMobileMoreAnchorEl] = useState(false);


  const { classes } = props;

  return (
    <div className={classes.grow}>
      <AppBar position="static">
        <Toolbar>
          <IconButton
            edge="start"
            className={classes.menuButton}
            color="inherit"
            aria-label="open drawer"
            onClick={props.openDrawerHandler}
          >
            <MenuIcon />
          </IconButton>
          <div className={componentStyles.bigTitle}>Blockchain Data Market </div>
          {/* <Link route="/"> */}
            <IconButton
        edge="end"
        className={classes.homeButton}
        color="inherit"
        style={{ marginLeft: 'auto' }}
            >
              <HomeIcon />
            </IconButton>
            {/* </Link> */}
        </Toolbar>
      </AppBar>
    </div>
  );
};

export default withStyles(styles)(ToolbarComponent);
