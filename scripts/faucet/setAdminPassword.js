"use strict";
// Prompts for the faucet admin password (hidden input, never echoed, never written to a file) and prints
// ONLY a salted scrypt hash record for you to store in AWS Secrets Manager. Makes no AWS calls.
//   node scripts/faucet/setAdminPassword.js
// Then store the printed JSON yourself (the password is not part of it):
//   aws secretsmanager create-secret --name test-bc-faucet/admin --secret-string '<printed JSON>'
//   (to change the password later: put-secret-value on the same secret). Never commit the output.
const { hashPassword } = require("../../infrastructure/faucet/adminAuth");

const MIN_LENGTH = 12;

// Reads one line from the terminal in raw mode without echoing characters.
const promptHidden = (label) =>
  new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });

(async () => {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    console.error("This script needs an interactive terminal (the password is typed hidden and is not accepted from pipes or arguments).");
    process.exit(1);
  }
  const first = await promptHidden(`New admin password (min ${MIN_LENGTH} characters, hidden): `);
  if (first.length < MIN_LENGTH || first.length > 200) throw new Error(`The password must be ${MIN_LENGTH}-200 characters`);
  const second = await promptHidden("Repeat the password: ");
  if (first !== second) throw new Error("The passwords do not match");
  const record = await hashPassword(first);
  console.error("\nStore this JSON in AWS Secrets Manager as the faucet admin secret. It is a hash, not the password; do not commit it:\n");
  console.log(JSON.stringify(record));
})().catch((error) => {
  console.error(`Failed: ${error?.message || "error"}`);
  process.exit(1);
});
