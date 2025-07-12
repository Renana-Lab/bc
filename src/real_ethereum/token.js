// ../real_ethereum/token.js
import web3 from "./web3.js";
import tokenAbi from "../abis/MyToken.json";
import tokenAddress from "./tokenAddress.js";

export default (address = tokenAddress) =>
  new web3.eth.Contract(tokenAbi.abi, address);
