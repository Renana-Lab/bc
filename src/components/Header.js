import React from "react";
// import { Link } from "../routes";
import styles from "./../styles/components.module.scss";

const Header = () => {
  return (
      <nav className={styles.navbarContainer}>
      {/* <Link route="/"> */}
        <h3 className={styles.item}>Blockchain Market Data</h3>
      {/* </Link> */}
        <button
          type="button"
          id="navbar-toggle"
          aria-controls="navbar-menu"
          aria-label="Toggle menu"
          aria-expanded="false"
        >
          <span className={styles.iconBar}></span>
          <span className={styles.iconBar}></span>
          <span className={styles.iconBar}></span>
        </button>
        <div id="navbarMenu" aria-labelledby="navbar-toggle">
          <ul className={styles.navbarLinks}>
            <li className={styles.navbarItem}><a className={styles.navbarLink} href="/about">About</a></li>
              <li className={styles.navbarItem}><a className={styles.navbarLink} href="/blog">Blog</a></li>
              <li className={styles.navbarItem}><a className={styles.navbarLink} href="/careers">Careers</a></li>
            <li className={styles.navbarItem}><a className={styles.navbarLink} href="/contact">Contact</a></li>
          </ul>
        </div>
      </nav>
  );
};

export default Header;
