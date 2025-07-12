// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MyToken is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 100 * 10 ** 18;
    mapping(address => bool) public hasClaimed;

    constructor(address initialOwner) ERC20("ResearchToken", "RST") Ownable(initialOwner) {
        _mint(initialOwner, 1_000_000 * 10 ** decimals());
    }

    function faucet() external {
        require(!hasClaimed[msg.sender], "You already claimed");
        hasClaimed[msg.sender] = true;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
