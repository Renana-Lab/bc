// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

/// @title Campaign Auction Smart Contract
/// @notice Supports one-shot auctions where highest bidder wins access to data
/// @dev Includes ReentrancyGuard, pull-based refund handling, and event logging

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
}

contract Campaign is ReentrancyGuard {
    struct Bid {
        uint256 value;
        uint256 time;
        address bidder;
    }

    // Events
    event AuctionFinalized(address winner, uint256 winningAmount);
    event RefundIssued(address bidder, uint256 amount);
    event BidPlaced(address bidder, uint256 totalBid);

    // State
    address public manager;
    uint256 public minimumContribution;
    string public dataForSale;
    string public dataDescription;
    uint256 public endTime;

    address public highestBidder;
    uint256 public highestBid;

    bool public auctionEnded;

    Bid[] public bids;
    address[] public allBidders;
    mapping(address => bool) public hasBid;

    mapping(address => uint256) public userBids;
    mapping(address => uint256) public pendingReturns;

    // Modifiers
    modifier onlyManager() {
        require(msg.sender == manager, "Only manager");
        _;
    }

    modifier auctionActive() {
        require(block.timestamp < endTime, "Auction ended");
        _;
    }

    modifier auctionExpired() {
        require(block.timestamp >= endTime, "Auction still active");
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
    }

    function contribute(
        uint256 newTotalBid
    ) public payable nonReentrant auctionActive {
        require(msg.sender != manager, "Owner cannot bid");
        require(newTotalBid >= minimumContribution, "Bid below minimum");
        require(newTotalBid > highestBid, "There already is a higher bid");

        uint256 currentBid = userBids[msg.sender];
        require(newTotalBid > currentBid, "New bid must exceed previous");

        uint256 requiredIncrement = newTotalBid - currentBid;
        require(msg.value == requiredIncrement, "Send exact difference");

        // Refund old highestBidder using pull method
        if (highestBid != 0) {
            pendingReturns[highestBidder] += highestBid;
        }

        userBids[msg.sender] = newTotalBid;
        highestBidder = msg.sender;
        highestBid = newTotalBid;

        bids.push(Bid(newTotalBid, block.timestamp, msg.sender));

        if (!hasBid[msg.sender]) {
            hasBid[msg.sender] = true;
            allBidders.push(msg.sender);
        }

        emit BidPlaced(msg.sender, newTotalBid);
    }

    function endAuction() public auctionExpired onlyManager {
        require(!auctionEnded, "Auction already ended");
        auctionEnded = true;

        address winner = highestBidder;
        uint256 winningAmount = highestBid;

        // Pay seller immediately
        (bool sellerPaid, ) = payable(manager).call{value: winningAmount}("");
        require(sellerPaid, "Payment to seller failed");

        // Clear winner's bid
        userBids[winner] = 0;
        highestBid = 0;

        emit AuctionFinalized(winner, winningAmount);
    }

    /// @notice Allows bidders to withdraw their refunds
    function withdrawRefund() public nonReentrant {
        uint256 amount = pendingReturns[msg.sender];
        require(amount > 0, "No refund available");

        pendingReturns[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Refund transfer failed");

        emit RefundIssued(msg.sender, amount);
    }

    /// @notice Allows the manager to withdraw funds on behalf of a bidder
    function withdrawBid(
        address payable _address
    ) public onlyManager nonReentrant {
        require(auctionEnded, "Auction has not ended");
        require(_address != address(0), "Invalid address");
        require(_address != highestBidder, "Winner cannot withdraw");

        uint256 amount = userBids[_address] + pendingReturns[_address];
        require(amount > 0, "No funds to withdraw");

        // Clear both userBids and pendingReturns for the address
        userBids[_address] = 0;
        pendingReturns[_address] = 0;

        (bool sent, ) = _address.call{value: amount}("");
        require(sent, "Failed to send Ether");

        emit RefundIssued(_address, amount);
    }

    /// @notice Auto-callable helper for frontend or scripts to finalize auction
    function finalizeAuctionIfEnded() public {
        if (!auctionEnded && block.timestamp >= endTime) {
            endAuction();
        }
    }

    /// @notice Allows the manager to withdraw any remaining funds if something goes wrong
    function withdrawRemainingFunds() public onlyManager nonReentrant {
        require(auctionEnded, "Auction has not ended");
        uint256 remainingBalance = address(this).balance;
        require(remainingBalance > 0, "No funds remaining");

        (bool sent, ) = payable(manager).call{value: remainingBalance}("");
        require(sent, "Failed to send remaining funds");
    }

    // View functions
    function getSummary()
        public
        view
        returns (
            uint256,
            uint256,
            address,
            address,
            string memory,
            string memory,
            uint256,
            address[] memory
        )
    {
        return (
            minimumContribution,
            address(this).balance,
            manager,
            highestBidder,
            dataForSale,
            dataDescription,
            endTime,
            allBidders
        );
    }

    function getBids() public view returns (Bid[] memory) {
        return bids;
    }

    function getPendingReturn(address user) public view returns (uint256) {
        return pendingReturns[user];
    }

    function isAuctionActive() public view returns (bool) {
        return block.timestamp < endTime && !auctionEnded;
    }
}
