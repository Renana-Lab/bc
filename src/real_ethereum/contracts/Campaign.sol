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
}

contract Campaign is ReentrancyGuard {
    struct Bid {
        uint256 value;
        uint256 time;
        address bidder;
    }

    address public manager;
    uint256 public minimumContribution;
    string public dataForSale;
    string public dataDescription;
    uint256 public endTime;

    address public highestBidder;
    uint256 public highestBid;

    bool public auctionEnded;
    bool public sellerPaid;

    Bid[] public bids;
    address[] public allBidders;
    mapping(address => uint256) public pendingReturns;
    mapping(address => bool) public hasBid;

    modifier onlyManager() {
        require(msg.sender == manager, "Only manager can call this");
        _;
    }

    modifier auctionActive() {
        require(block.timestamp < endTime, "Auction has ended");
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
        auctionEnded = false;
        sellerPaid = false;
    }

    function contribute() public payable nonReentrant auctionActive {
        require(msg.sender != manager, "Owner cannot bid");
        require(msg.value >= minimumContribution, "Bid below minimum");
        require(msg.value > highestBid, "There already is a higher bid");

        // Refund old bid if bidder is rebidding
        if (pendingReturns[msg.sender] > 0) {
            uint256 oldBid = pendingReturns[msg.sender];
            pendingReturns[msg.sender] = 0;
            (bool refunded, ) = payable(msg.sender).call{value: oldBid}("");
            require(refunded, "Old bid refund failed");
        }

        // Refund previous highest bidder
        if (highestBid > 0) {
            pendingReturns[highestBidder] = highestBid;
        }

        highestBidder = msg.sender;
        highestBid = msg.value;

        bids.push(Bid(msg.value, block.timestamp, msg.sender));

        if (!hasBid[msg.sender]) {
            hasBid[msg.sender] = true;
            allBidders.push(msg.sender);
        }
    }

    function endAuction() public nonReentrant auctionExpired {
        require(!auctionEnded, "Auction already ended");

        auctionEnded = true;

        // Auto-refund all non-winning bidders
        for (uint256 i = 0; i < allBidders.length; i++) {
            address bidder = allBidders[i];
            if (bidder != highestBidder) {
                uint256 amount = pendingReturns[bidder];
                if (amount > 0) {
                    pendingReturns[bidder] = 0;
                    (bool sent, ) = payable(bidder).call{value: amount}("");
                    require(sent, "Refund failed");
                }
            }
        }
    }

    function withdrawSellerFunds() public nonReentrant onlyManager auctionExpired {
        require(auctionEnded, "Auction must be ended");
        require(!sellerPaid, "Funds already withdrawn");

        uint256 amount = highestBid;
        highestBid = 0;
        sellerPaid = true;

        (bool sent, ) = payable(manager).call{value: amount}("");
        require(sent, "Seller withdraw failed");
    }

    function getSummary()
        public
        view
        returns (
            uint256, uint256, address, address,
            string memory, string memory, uint256,
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
