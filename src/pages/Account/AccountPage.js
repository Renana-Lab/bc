import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import Layout from "../../components/Layout";
import { useMetaMask } from "../../Context/Context";
import { getDefaultBudget, subscribeToBudgetChanges } from "../../real_ethereum/budget";
import { shortIdentifier } from "../../real_ethereum/wallets/participantCopy";
import { isInvisibleWalletMode } from "../../real_ethereum/wallets/walletMode.mjs";
import styles from "./account.module.scss";

const Row = ({ label, children, className = "" }) => (
  <div className={styles.row}>
    <span className={styles.label}>{label}: </span>
    <span className={`${styles.value} ${className}`.trim()}>{children}</span>
  </div>
);

// Participant profile (market parity). Shows the shortened identifier and the budget only:
// never a key, a passphrase or a native-token balance.
function AccountPage() {
  const { account } = useMetaMask();
  const [budget, setBudget] = useState(null);

  useEffect(() => {
    let active = true;
    getDefaultBudget()
      .then((value) => { if (active) setBudget(value); })
      .catch(() => {});
    const unsubscribe = subscribeToBudgetChanges(({ budget: next } = {}) => {
      if (active && next !== null && next !== undefined) setBudget(String(next));
    });
    return () => { active = false; unsubscribe?.(); };
  }, [account]);

  if (!isInvisibleWalletMode()) return <Navigate to="/" replace />;

  return (
    <Layout>
      <div className={styles.card}>
        <h1 className={styles.title}>Account Profile</h1>
        <hr className={styles.rule} />
        <Row label="Name">{"—"}</Row>
        <Row label="Identifier">
          <span title={account || undefined}>{account ? shortIdentifier(account) : "—"}</span>
        </Row>
        <Row label="Role">User</Row>
        <Row label="Budget" className={styles.budget}>{budget ?? "—"}</Row>
      </div>
    </Layout>
  );
}

export default AccountPage;
