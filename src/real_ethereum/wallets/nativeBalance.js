import { formatUnits, parseUnits } from "ethers";

// Native-token (TEST) amounts: bigint wei in, short strings out.
export const formatNative = (wei, digits = 4) => {
  const [whole, fraction = ""] = formatUnits(BigInt(wei), 18).split(".");
  return `${whole}.${fraction.padEnd(digits, "0").slice(0, digits)}`;
};

// "0.5" -> 500000000000000000n; anything that is not a positive amount -> null.
export const parseNative = (text) => {
  try {
    const value = parseUnits(String(text ?? "").trim(), 18);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
};

export const toHexWei = (wei) => `0x${BigInt(wei).toString(16)}`;

// Gas the admin wallet keeps back when it tops up others (a plain Sapphire transfer costs well under this).
export const ADMIN_GAS_RESERVE_WEI = 10n ** 16n; // 0.01 TEST
