import React from "react";
import { Container } from "semantic-ui-react";
// import Head from "next/head";
import Navbar from "./Navbar.js";
import styles from "./../styles/components.module.scss";

const Layout = (props) => {
  return (
    <Container className={styles.container}>
      {/* <Head>
        <link
          rel="stylesheet"
          href="//cdnjs.cloudflare.com/ajax/libs/semantic-ui/2.2.12/semantic.min.css"
        ></link>
      </Head> */}
      <Navbar className={styles.navbar} />
      <main className={styles.pageData} id="main-content">
        {props.children}
      </main>
    </Container>
  );
};
export default Layout;
