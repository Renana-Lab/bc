// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status;

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

contract CampaignFactory {
    address payable[] public deployedCampaigns;

    function createCampaign(
        uint256 minimum,
        string memory dataForSale,
        string memory dataDesc,
        uint256 durationInMinutes
    ) public {
        require(minimum > 0, "Minimum must be greater than 0");
        uint256 deadline = block.timestamp + durationInMinutes * 60;

        address newCampaign = address(
            new Campaign(minimum, dataForSale, dataDesc, msg.sender, deadline)
        );
        deployedCampaigns.push(payable(newCampaign));
    }

    function getDeployedCampaigns()
        public
        view
        returns (address payable[] memory)
    {
        return deployedCampaigns;
    }

    function checkEndedAuctions() public {
        uint256 campaignsLength = deployedCampaigns.length;
        for (uint256 i = 0; i < campaignsLength; ) {
            Campaign campaign = Campaign(deployedCampaigns[i]);
            campaign.endAuction();
            unchecked {
                i++;
            }
        }
    }
}

contract Campaign is ReentrancyGuard {
    struct Bid {
        uint256 value;
        uint256 time;
        address sellerAddress;
    }

    Bid[] public transactions;
    address public manager;
    uint256 public minimumContribution;
    string public dataForSale;
    string public dataDescription;
    mapping(address => bool) public bidders;
    mapping(address => uint256) public biddersMoney;
    uint256 public biddersCount;
    address[] public bidderAddresses;
    address public highestBidder;
    uint256 public highestBid;
    uint256 public endTime;
    bool public closed;
    bool public auctionEnded;

    modifier onlyManager() {
        require(msg.sender == manager, "Only manager can call this");
        _;
    }

    constructor(
        uint256 minimum,
        string memory _dataForSale,
        string memory _dataDescription,
        address creator,
        uint256 _endTime
    ) {
        manager = creator;
        minimumContribution = minimum;
        dataForSale = _dataForSale;
        dataDescription = _dataDescription;
        endTime = _endTime;
        closed = false;
        auctionEnded = false;
    }

    function endAuction() public nonReentrant {
        if (block.timestamp >= endTime && !auctionEnded) {
            auctionEnded = true;

            for (uint256 i = 0; i < bidderAddresses.length; ) {
                address bidder = bidderAddresses[i];
                if (bidder != highestBidder) {
                    withdrawBid(payable(bidder));
                }
                unchecked {
                    i++;
                }
            }
        }
    }

    function contribute() public payable nonReentrant {
        require(msg.sender != manager, "You can't bid on your own data");
        require(block.timestamp < endTime, "Auction ended");

        uint256 newBidAmount = biddersMoney[msg.sender] + msg.value;
        require(newBidAmount > highestBid, "Bid too low");
        require(newBidAmount >= minimumContribution, "Below minimum");

        transactions.push(Bid(msg.value, block.timestamp, msg.sender));

        if (!bidders[msg.sender]) {
            bidders[msg.sender] = true;
            biddersCount++;
            bidderAddresses.push(msg.sender);
        }

        biddersMoney[msg.sender] = newBidAmount;
        highestBidder = msg.sender;
        highestBid = newBidAmount;
    }

    function withdrawBid(address payable bidder) internal {
        uint256 amount = biddersMoney[bidder];
        if (amount > 0) {
            biddersMoney[bidder] = 0;
            (bool sent, ) = bidder.call{value: amount}("");
            require(sent, "Transfer failed");
        }
    }

    function withdrawFunds() public nonReentrant onlyManager {
        require(auctionEnded, "Auction not yet ended");

        uint256 amount = biddersMoney[highestBidder];
        biddersMoney[highestBidder] = 0;

        (bool sent, ) = payable(manager).call{value: amount}("");
        require(sent, "Transfer failed");

        closed = true;
    }

    function getSummary()
        public
        view
        returns (
            uint256,
            uint256,
            uint256,
            address,
            uint256,
            string memory,
            string memory,
            uint256,
            address,
            address[] memory
        )
    {
        return (
            minimumContribution,
            address(this).balance,
            biddersCount,
            manager,
            highestBid,
            dataForSale,
            dataDescription,
            endTime,
            highestBidder,
            bidderAddresses
        );
    }

    function getBid(address bidder) public view returns (uint256) {
        return biddersMoney[bidder];
    }

    function getStatus() public view returns (bool) {
        return closed;
    }

    function getBidders() public view returns (address[] memory) {
        return bidderAddresses;
    }

    function getTransactions() public view returns (Bid[] memory) {
        return transactions;
    }

    function isAuctionActive() public view returns (bool) {
        return block.timestamp < endTime && !auctionEnded;
    }
}
// This contract is a simplified version of a crowdfunding campaign on Ethereum. It allows users to create campaigns, contribute funds, and manage bids. The contract includes features like minimum contributions, auction end times, and bid withdrawals. The CampaignFactory contract manages multiple campaigns and allows for checking the status of all campaigns.
// The Campaign contract includes functions for contributing to the campaign, withdrawing bids, and checking the status of the auction. It also implements a reentrancy guard to prevent reentrant calls. Overall, this contract provides a basic framework for crowdfunding campaigns on Ethereum.
