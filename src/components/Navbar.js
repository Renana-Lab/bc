import React, { useCallback, useState } from "react";
import DrawerComponent from "./Drawer.js";
import ToolbarComponent from "./Toolbar.js";

const Navbar = () => {
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const toggleDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);
  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
  }, []);
  return (
    <div className="App">
      <ToolbarComponent openDrawerHandler={openDrawer} />
      <DrawerComponent open={isDrawerOpen} toggleDrawerHandler={toggleDrawer} />
    </div>
  );
};

export default Navbar;
