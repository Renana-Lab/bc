// "How to access and maintain each component": static, public information only. Links go to public AWS consoles and the
// Sapphire explorer; there are no secrets, passwords, private keys or account ids here (see infrastructure/faucet/README.md
// for the deploy procedure). Values that identify the deployment are the ones the README already prints.
export const AWS_REGION = "us-east-2";
export const AMPLIFY_APP_ID = "dk7l5cq2vi9oh";
export const AMPLIFY_BRANCH = "spike/embedded-wallets-sapphire";
export const FAUCET_STACK = "test-bc-faucet";
export const DEPLOY_README = "infrastructure/faucet/README.md";

const consoleUrl = (service, hash = "") => `https://${AWS_REGION}.console.aws.amazon.com/${service}/home?region=${AWS_REGION}${hash}`;

// Names only: set them in the Amplify console (Hosting > Environment variables). Never paste values here.
export const FRONTEND_ENV_VARS = [
  "REACT_APP_NETWORK",
  "REACT_APP_RPC_URL / REACT_APP_RPC_URLS",
  "REACT_APP_WS_RPC_URL",
  "REACT_APP_FACTORY_ADDRESS",
  "REACT_APP_ADMIN_ADDRESSES",
  "REACT_APP_WALLET_MODE",
  "REACT_APP_FAUCET_URL",
  "REACT_APP_FAUCET_ADDRESS",
  "REACT_APP_SWEEP_ADDRESS",
  "REACT_APP_PRESENCE_API_URL",
  "REACT_APP_BOTNET_API_URL",
  "REACT_APP_BIDDER_NAMES",
];

export const buildRunbook = ({ factoryAddress = "", network = {} } = {}) => {
  const explorer = String(network.blockExplorerUrls?.[0] || "https://explorer.oasis.io/testnet/sapphire").replace(/\/+$/, "");
  return {
    deploy: { text: `Deploy: see ${DEPLOY_README} (deployFaucet.js builds and deploys the faucet stack; the frontend builds from its Amplify branch).`, path: DEPLOY_README },
    components: [
      {
        name: "Frontend",
        lines: [
          `AWS Amplify app ${AMPLIFY_APP_ID}, branch ${AMPLIFY_BRANCH}. A push to that branch builds and publishes it.`,
          "Check builds and logs in the Amplify console; set the environment variables there, then redeploy the branch to apply them.",
          `Environment variables (names only): ${FRONTEND_ENV_VARS.join(", ")}.`,
        ],
        links: [{ label: "Amplify console", href: `https://console.aws.amazon.com/amplify/home#/${AMPLIFY_APP_ID}` }],
      },
      {
        name: "Faucet API",
        lines: [
          `CloudFormation stack ${FAUCET_STACK} in ${AWS_REGION}. Lambda functions: FaucetFunction (payouts, admin, inbox endpoints), SweepJobFunction (auto-return job), MonitorFunction (balance alarm). InboxFunction does not exist: the inbox is served by FaucetFunction.`,
          "Logs: CloudWatch log groups of each function. Change code or settings by redeploying the stack, not by editing functions by hand.",
        ],
        links: [
          { label: "CloudFormation stack", href: consoleUrl("cloudformation", `#/stacks?filteringText=${FAUCET_STACK}`) },
          { label: "Lambda functions", href: consoleUrl("lambda", "#/functions") },
          { label: "CloudWatch logs", href: consoleUrl("cloudwatch", "#logsV2:log-groups") },
        ],
      },
      {
        name: "Data",
        lines: [
          "DynamoDB tables FaucetTable (pids, payouts, sweeps, messages) and RateTable (hashed rate-limit counters); the Lambda package bucket test-bc-artifacts-<account id> holds the deploy artifacts.",
          "Do not edit table items by hand; use the Admin Zone faucet cards or the scripts under scripts/faucet.",
        ],
        links: [
          { label: "DynamoDB tables", href: consoleUrl("dynamodbv2", "#tables") },
          { label: "S3 buckets", href: "https://s3.console.aws.amazon.com/s3/buckets?region=" + AWS_REGION },
        ],
      },
      {
        name: "Scheduler",
        lines: [
          "Amazon EventBridge rules SweepSchedule and MonitorSchedule run every 5 minutes (rate(5 minutes)): the auto-return sweep job and the faucet balance monitor.",
          "Pause or resume a job by disabling or enabling its rule.",
        ],
        links: [{ label: "EventBridge rules", href: consoleUrl("events", "#/rules") }],
      },
      {
        name: "Chain",
        lines: [
          `Oasis Sapphire testnet (chain id 23295). Active factory: ${factoryAddress || "not configured"}.`,
          "Read-only checks go through the configured RPC; contract writes need an on-chain admin wallet.",
        ],
        links: [
          { label: "Sapphire testnet explorer", href: explorer },
          ...(factoryAddress ? [{ label: "Factory on the explorer", href: `${explorer}/address/${factoryAddress}` }] : []),
        ],
      },
    ],
  };
};
