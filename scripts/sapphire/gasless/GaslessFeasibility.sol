// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

// TEST-ONLY feasibility code for Oasis' "on-chain signer" gasless pattern
// (https://docs.oasis.io/build/sapphire/develop/gasless). It is NOT part of the marketplace
// contracts and is never deployed by the app.
import {EIP155Signer} from "@oasisprotocol/sapphire-contracts/contracts/EIP155Signer.sol";
import {EthereumUtils} from "@oasisprotocol/sapphire-contracts/contracts/EthereumUtils.sol";
import {encryptCallData} from "@oasisprotocol/sapphire-contracts/contracts/CalldataEncryption.sol";

// Stand-in for Campaign: records who the bidder is, exactly like contribute() uses msg.sender.
contract MarketStub {
    address public lastSender;
    uint256 public total;

    function contribute() external payable {
        lastSender = msg.sender;
        total += msg.value;
    }
}

contract GaslessProxy {
    address public immutable owner;
    address public immutable allowedTarget;
    address public relayer; // address of the contract-held keypair (the app pays for its gas)
    bytes32 private relayerSecret;
    uint64 private relayerNonce;

    constructor(address target) {
        owner = msg.sender;
        allowedTarget = target;
    }

    function initKeypair() external {
        require(msg.sender == owner, "owner only");
        (relayer, relayerSecret) = EthereumUtils.generateKeypair();
    }

    // Returns a signed EIP-155 tx (confidential view call) that the participant broadcasts
    // themselves with a zero balance. Gas price/limit are fixed so callers cannot drain the relayer.
    // NOTE: there is no per-user access control here; the docs say to add one.
    function makeProxyTx(bytes calldata innercall, uint256 value) external view returns (bytes memory) {
        return EIP155Signer.sign(
            relayer,
            relayerSecret,
            EIP155Signer.EthTx({
                nonce: relayerNonce,
                gasPrice: 100_000_000_000,
                gasLimit: 250_000,
                to: address(this),
                value: value,
                data: encryptCallData(abi.encodeCall(this.proxy, (innercall))),
                chainId: block.chainid
            })
        );
    }

    function proxy(bytes calldata innercall) external payable {
        require(msg.sender == relayer, "relayer only");
        (bool ok, bytes memory ret) = allowedTarget.call{value: msg.value}(innercall);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        relayerNonce += 1;
    }
}
