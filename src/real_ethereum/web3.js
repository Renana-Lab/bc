import Web3 from "web3";

let web3;

if (typeof window !== "undefined" && typeof window.ethereum !== "undefined") {
  web3 = new Web3(window.ethereum);

  window.ethereum
    .request({ method: "eth_chainId" })
    .then((chainId) => {
      if (chainId !== "0xaa36a7" && chainId !== "0xAA36A7") {
        console.warn("Please switch MetaMask to Sepolia.");
      }
    })
    .catch((error) => console.error("Error reading network:", error));
} else {
  const provider = new Web3.providers.HttpProvider(
    "https://sepolia.infura.io/v3/6426761d274542bb9652e9a5aff35a0c"
  );
  web3 = new Web3(provider);
}

export default web3;
