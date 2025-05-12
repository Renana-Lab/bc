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

        Campaign newCampaign = new Campaign(
            minimum,
            dataForSale,
            dataDesc,
            msg.sender,
            deadline
        );

        deployedCampaigns.push(payable(address(newCampaign)));
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

    mapping(address => uint256) public biddersMoney;
    mapping(address => bool) public bidders;
    address[] public bidderAddresses;

    uint256 public biddersCount;
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

    function contribute() public payable nonReentrant {
        require(msg.sender != manager, "You can't bid on your own data");
        require(block.timestamp < endTime, "Auction ended");
        require(msg.value > highestBid, "Bid too low");
        require(msg.value >= minimumContribution, "Below minimum");

        uint256 previousBid = biddersMoney[msg.sender];

        // Refund previous bid if it exists
        if (previousBid > 0) {
            (bool refunded, ) = payable(msg.sender).call{value: previousBid}(
                ""
            );
            require(refunded, "Refund failed");
        }

        // Replace previous bid with the new one
        biddersMoney[msg.sender] = msg.value;
        highestBid = msg.value;
        highestBidder = msg.sender;

        // Record bid
        transactions.push(Bid(msg.value, block.timestamp, msg.sender));

        // Track unique bidders
        if (!bidders[msg.sender]) {
            bidders[msg.sender] = true;
            biddersCount++;
            bidderAddresses.push(msg.sender);
        }
    }

    function endAuction() public nonReentrant {
        if (block.timestamp >= endTime && !auctionEnded) {
            auctionEnded = true;
        }
    }

    function refund() public nonReentrant {
        require(auctionEnded, "Auction not yet ended");
        require(msg.sender != highestBidder, "Winner cannot refund");

        uint256 amount = biddersMoney[msg.sender];
        require(amount > 0, "No funds to refund");

        biddersMoney[msg.sender] = 0;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "Refund failed");
    }

    function withdrawFunds() public nonReentrant onlyManager {
        require(auctionEnded, "Auction not yet ended");

        uint256 amount = biddersMoney[highestBidder];
        require(amount > 0, "No funds to withdraw");

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
