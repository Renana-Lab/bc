import { useState } from "react";
import { Alert, Box, Button, Link, Stack, Typography } from "@mui/material";

export default function ProtectedStatusPanel() {
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const resources = [
    ["Encrypted objects (S3)", "https://s3.console.aws.amazon.com/s3/buckets/marketplace-protected-bucket-ihpkz41ajcxv?region=us-east-1&tab=objects"],
    ["Envelope metadata (DynamoDB)", "https://us-east-1.console.aws.amazon.com/dynamodbv2/home?region=us-east-1#item-explorer?table=marketplace-protected-Table-OIE309CC05L7"],
    ["Wrapping key (KMS)", "https://us-east-1.console.aws.amazon.com/kms/home?region=us-east-1#/kms/keys/3be9a069-b6ce-4488-8686-ecde73dc414b"],
    ["Key release service", "https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/marketplace-protected-service"],
    ["Automatic finalizer", "https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/marketplace-protected-finalizer"],
    ["Release monitoring", "https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Faws$252Flambda$252Fmarketplace-protected-service"],
    ["Deployment (Amplify)", "https://us-east-2.console.aws.amazon.com/amplify/apps/d1n93p6nqw0kho/branches/main"],
  ];
  const check = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${(process.env.REACT_APP_PROTECTED_API_URL || "").replace(/\/$/, "")}/config`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const config = await response.json();
      if (String(config.factory).toLowerCase() !== String(process.env.REACT_APP_FACTORY_ADDRESS).toLowerCase() || Number(config.chainId) !== 11155111 || !config.publicKey) throw new Error();
      setStatus("Protected storage configuration verified. Access is checked independently for every data release.");
    } catch (_) { setStatus("Protected storage is unavailable or its configuration does not match this deployment."); }
    finally { setLoading(false); }
  };
  return <Box sx={{ width: "100%", my: 2 }}>
    <Typography variant="h6">Protected information</Typography>
    <Typography variant="body2" color="text.secondary">New payloads are encrypted before upload. Historical plaintext cannot be hidden retroactively.</Typography>
    <Stack direction="row" spacing={2} sx={{ my: 1, flexWrap: "wrap" }}>
      <Button onClick={check} disabled={loading}>{loading ? "Checking..." : "Check protected storage"}</Button>
      <Link target="_blank" rel="noopener noreferrer" href="https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks">AWS resources</Link>
      <Link target="_blank" rel="noopener noreferrer" href={`https://sepolia.etherscan.io/address/${process.env.REACT_APP_FACTORY_ADDRESS}`}>Protected factory</Link>
    </Stack>
    <Stack direction="row" useFlexGap spacing={2} sx={{ my: 1, flexWrap: "wrap" }}>
      {resources.map(([label, href]) => <Link key={label} target="_blank" rel="noopener noreferrer" href={href} variant="body2">{label}</Link>)}
    </Stack>
    {status && <Alert severity={status.startsWith("Protected storage configuration verified") ? "success" : "warning"}>{status}</Alert>}
  </Box>;
}
