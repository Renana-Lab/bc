const fs = require("fs");
const path = require("path");

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const normalizeAddress = (value) => String(value || "").trim();
const isValidAddress = (value) => ADDRESS_PATTERN.test(normalizeAddress(value));

const firstValidAddress = (...addresses) =>
  addresses.map(normalizeAddress).find((address) => isValidAddress(address)) || "";

const readFileIfPresent = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const readConstAddress = (source, constName) => {
  const match = source.match(
    new RegExp(`(?:const|export\\s+const)\\s+${constName}\\s*=\\s*["'](0x[a-fA-F0-9]{40})["']`)
  );

  return match?.[1] || "";
};

function loadFactoryAddress(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, "..");
  const requestedMarket = String(
    options.market ||
      process.env.FACTORY_MARKET ||
      process.env.AUTO_FINALIZE_MARKET ||
      process.env.AUCTION_INDEXER_MARKET ||
      "real"
  ).toLowerCase();

  const marketConfigPath = path.resolve(rootDir, "src/real_ethereum/marketConfig.js");
  const factoryAddressPath = path.resolve(rootDir, "src/real_ethereum/factoryAddress.js");
  const marketConfigSource = readFileIfPresent(marketConfigPath);
  const factoryAddressSource = readFileIfPresent(factoryAddressPath);

  const envAddress =
    requestedMarket === "dev"
      ? firstValidAddress(
          process.env.FACTORY_ADDRESS,
          process.env.REACT_APP_DEV_FACTORY_ADDRESS,
          process.env.REACT_APP_TEST_FACTORY_ADDRESS
        )
      : firstValidAddress(process.env.FACTORY_ADDRESS, process.env.REACT_APP_REAL_FACTORY_ADDRESS);

  const configAddress =
    requestedMarket === "dev"
      ? readConstAddress(marketConfigSource, "DEFAULT_DEV_FACTORY_ADDRESS")
      : readConstAddress(marketConfigSource, "DEFAULT_FACTORY_ADDRESS");

  const legacyAddress = factoryAddressSource.match(/0x[a-fA-F0-9]{40}/)?.[0] || "";
  const address = firstValidAddress(envAddress, configAddress, legacyAddress);

  if (!address) {
    throw new Error(
      `Could not find a ${requestedMarket} factory address. Set FACTORY_ADDRESS, or add a valid default in ${marketConfigPath}.`
    );
  }

  return address;
}

module.exports = {
  isValidAddress,
  loadFactoryAddress,
};
