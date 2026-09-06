import Web3 from "web3";
import { getConfiguredRpcUrls } from "./rpcConfig";
import { createWalletTransport } from "./walletTransport";

const fallback = new Web3.providers.HttpProvider(getConfiguredRpcUrls()[0]);
const web3 = new Web3(createWalletTransport(fallback));
export default web3;
