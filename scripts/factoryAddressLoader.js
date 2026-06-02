const fs = require("fs");
const path = require("path");

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const normalizeAddress = (value) => String(value || "").trim();
const isValidAddress = (value) => ADDRESS_PATTERN.test(normalizeAddress(value));

const firstValidAddress = (...addresses) =>
  addresses.map(normalizeAddress).find((address) => isValidAddress(address)) || "";

const splitCsv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const uniqueAddresses = (addresses) => {
  const seen = new Set();
  const unique = [];

  addresses.forEach((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(address);
  });

  return unique;
};

const validateAddressList = (name, addresses) => {
  const invalid = addresses.filter((address) => !isValidAddress(address));
  if (invalid.length) {
    throw new Error(`${name} contains invalid factory address: ${invalid.join(", ")}`);
  }
};

const readFileIfPresent = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const readConstAddress = (source, constName, visited = new Set()) => {
  if (!source || visited.has(constName)) return "";
  visited.add(constName);

  const match = source.match(
    new RegExp(
      `(?:const|export\\s+const)\\s+${constName}\\s*=\\s*([^;\\n]+)`,
      "m"
    )
  );
  const value = match?.[1]?.trim() || "";
  const directAddress = value.match(/["'](0x[a-fA-F0-9]{40})["']/)?.[1];

  if (directAddress) return directAddress;

  const alias = value.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  if (alias) {
    return readConstAddress(source, alias, visited);
  }

  return "";
};

function loadFactoryAddress(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, "..");
  const requestedMarket = String(
    options.market ||
      process.env.FACTORY_MARKET ||
      process.env.AUTO_FINALIZE_MARKET ||
      process.env.AUCTION_INDEXER_MARKET ||
      "production"
  ).toLowerCase();
  const isTestingMarket = ["dev", "test", "testing", "staging"].includes(
    requestedMarket
  );

  const marketConfigPath = path.resolve(rootDir, "src/real_ethereum/marketConfig.js");
  const factoryAddressPath = path.resolve(rootDir, "src/real_ethereum/factoryAddress.js");
  const marketConfigSource = readFileIfPresent(marketConfigPath);
  const factoryAddressSource = readFileIfPresent(factoryAddressPath);

  const envAddress = isTestingMarket
    ? firstValidAddress(
        process.env.FACTORY_ADDRESS,
        process.env.REACT_APP_FACTORY_ADDRESS,
        process.env.REACT_APP_MARKET_FACTORY_ADDRESS,
        process.env.REACT_APP_DEV_FACTORY_ADDRESS,
        process.env.REACT_APP_TEST_FACTORY_ADDRESS
      )
    : firstValidAddress(
        process.env.FACTORY_ADDRESS,
        process.env.REACT_APP_FACTORY_ADDRESS,
        process.env.REACT_APP_MARKET_FACTORY_ADDRESS,
        process.env.REACT_APP_REAL_FACTORY_ADDRESS
      );

  const configAddress = isTestingMarket
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

function loadFactoryAddresses(options = {}) {
  const explicitAddresses = splitCsv(options.addresses || process.env.FACTORY_ADDRESSES);
  if (explicitAddresses.length) {
    validateAddressList("FACTORY_ADDRESSES", explicitAddresses);
    return uniqueAddresses(explicitAddresses);
  }

  const singleAddress = normalizeAddress(process.env.FACTORY_ADDRESS);
  if (singleAddress) {
    validateAddressList("FACTORY_ADDRESS", [singleAddress]);
    return [singleAddress];
  }

  const requestedMarkets = splitCsv(
    options.markets ||
      process.env.FACTORY_MARKETS ||
      process.env.AUTO_FINALIZE_MARKETS ||
      process.env.AUCTION_INDEXER_MARKETS ||
      process.env.FACTORY_MARKET ||
      process.env.AUTO_FINALIZE_MARKET ||
      process.env.AUCTION_INDEXER_MARKET ||
      "production"
  );

  const addresses = requestedMarkets.map((market) =>
    loadFactoryAddress({
      ...options,
      market,
    })
  );

  return uniqueAddresses(addresses);
}

module.exports = {
  isValidAddress,
  loadFactoryAddress,
  loadFactoryAddresses,
};
