/* eslint-env node */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const getArg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
};
const experimentId = getArg("id");
if (!/^EXP-[A-Za-z0-9._:-]+$/.test(experimentId)) {
  throw new Error("Use --id <experiment-id>.");
}
if (getArg("confirm") !== experimentId) {
  throw new Error(`Cleanup blocked. Add --confirm ${experimentId}`);
}
const privateDir = path.resolve(ROOT, "experiment-data", "private");
const target = path.resolve(privateDir, `${experimentId}.json`);
if (!target.startsWith(`${privateDir}${path.sep}`)) throw new Error("Refusing path outside private experiment directory.");
if (fs.existsSync(target)) {
  fs.unlinkSync(target);
  console.log(`Deleted private experiment keys for ${experimentId}.`);
} else {
  console.log(`No private experiment file exists for ${experimentId}.`);
}
