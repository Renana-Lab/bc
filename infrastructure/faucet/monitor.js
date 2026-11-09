"use strict";
// Scheduled Lambda (every 5 minutes): publishes the faucet balance as a CloudWatch metric.
// The CloudWatch alarm in the stack fires when the balance is below the threshold OR when this
// metric stops arriving (TreatMissingData = breaching), so a broken monitor also alerts.
// It only needs the faucet's PUBLIC address (FAUCET_ADDRESS); it has no access to the key.
const { JsonRpcProvider, formatEther } = require("ethers");

const publishBalance = async ({ balanceWei, putMetric, namespace = "BcFaucet" }) => {
  await putMetric({
    Namespace: namespace,
    MetricData: [{ MetricName: "FaucetBalance", Unit: "None", Value: Number(formatEther(balanceWei)) }],
  });
};

const handler = async () => {
  const provider = new JsonRpcProvider(process.env.RPC_URL, Number(process.env.CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
  const { CloudWatchClient, PutMetricDataCommand } = require("@aws-sdk/client-cloudwatch");
  const cloudwatch = new CloudWatchClient({});
  const balanceWei = await provider.getBalance(process.env.FAUCET_ADDRESS);
  await publishBalance({ balanceWei, putMetric: (input) => cloudwatch.send(new PutMetricDataCommand(input)) });
  console.log(JSON.stringify({ event: "balance_published" }));
};

module.exports = { handler, publishBalance };
