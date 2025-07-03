import Web3 from "web3";

let web3;

if (typeof window !== "undefined" && typeof window.ethereum !== "undefined") {
  // We are in the browser and MetaMask is running
  web3 = new Web3(window.ethereum);

  window.ethereum
    .request({ method: "eth_requestAccounts" }) 
    .then(() => {
      return window.ethereum.request({ method: "net_version" });
    })
    .then((networkId) => {
      console.log("Connected Network ID:", networkId);
      if (networkId !== "11155111") {
        // Sepolia network ID is 11155111
        console.warn("⚠️ You are not connected to Sepolia! Switching...");
        window.ethereum
          .request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0xAA36A7" }], // 0xAA36A7 is 11155111 in hex (Sepolia)
          })
          .catch((error) => console.error("Error switching network:", error));
      }
    })
    .catch((error) => console.error("Error requesting accounts:", error));

} else {
  // We are on the server *OR* the user is not running MetaMask
  const provider = new Web3.providers.HttpProvider(
    "https://sepolia.infura.io/v3/6426761d274542bb9652e9a5aff35a0c"
  );
  web3 = new Web3(provider);
}

export default web3;
