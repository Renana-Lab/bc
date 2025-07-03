// after refunding non winners , we have to make sure we dont refund them twice
// evrything has to be initialized
// approvers , approvercount , approversmonney , addresses
// approvers (mapping adress with flag will stay same)
// approverscount (is not usefull anymore we can reinitalize it )
// approversMonney (mapping adress with money sould be initialise)
// transactions (array of Bid should remain the same)
// adreeses (array of addresses which contributes sould stay the same)
// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

contract Campaign {
    event RefundProcessed(address indexed contributor, uint256 amount);
    event SellerPaid(address indexed seller, uint256 amount);

    struct Bid {
        uint256 value;
        uint256 time;
        address bidderAddress;
    }

    address public manager;
    uint256 public minimumContribution;
    string public dataForSell;
    string public dataDescription;

    mapping(address => bool) public approvers;
    mapping(address => uint256) public approversMoney;
    uint256 public approversCount;

    address[] public addresses;
    Bid[] public transactions;

    address public highestBidder;
    uint256 public highestBid;
    uint256 public endTime;
    bool public closed;

    modifier onlyBeforeEnd() {
        require(block.timestamp < endTime, "Auction ended");
        _;
    }

    modifier onlyAfterEnd() {
        require(block.timestamp >= endTime, "Auction not ended yet");
        _;
    }

    constructor(
        uint256 minimum,
        string memory dataSell,
        string memory dataDesc,
        address creator,
        uint256 duration
    ) {
        manager = creator;
        minimumContribution = minimum;
        dataForSell = dataSell;
        dataDescription = dataDesc;
        endTime = duration;
        closed = false;
    }

    function contribute() public payable onlyBeforeEnd {
        require(msg.sender != manager, "You can't bid on your own auction");
        require(msg.value >= minimumContribution, "Bid below minimum");
        require(msg.value > highestBid, "There is already a higher or equal bid");

        if (approversMoney[msg.sender] > 0) {
            uint256 oldBid = approversMoney[msg.sender];
            payable(msg.sender).transfer(oldBid);
            emit RefundProcessed(msg.sender, oldBid);
        }

        approversMoney[msg.sender] = msg.value;
        highestBid = msg.value;
        highestBidder = msg.sender;

        transactions.push(Bid(msg.value, block.timestamp, msg.sender));

        if (!approvers[msg.sender]) {
            approvers[msg.sender] = true;
            approversCount++;
            addresses.push(msg.sender);
        }
    }

    function finalizeAuctionIfNeeded() public onlyAfterEnd {
        require(!closed, "Auction already finalized");

        for (uint256 i = 0; i < addresses.length; i++) {
            address contributor = addresses[i];
            if (contributor != highestBidder) {
                uint256 refundAmount = approversMoney[contributor];
                if (refundAmount > 0) {
                    approversMoney[contributor] = 0;
                    payable(contributor).transfer(refundAmount);
                    emit RefundProcessed(contributor, refundAmount);
                }
            }
        }

        if (highestBid > 0) {
            require(address(this).balance >= highestBid, "Insufficient balance");
            payable(manager).transfer(highestBid);
            emit SellerPaid(manager, highestBid);
        }

        closed = true;
    }

    function getStatus() public view returns (bool) {
        return closed;
    }

    function getBid(address bidder) public view returns (uint256) {
        return approversMoney[bidder];
    }

    function getTransactions() public view returns (Bid[] memory) {
        return transactions;
    }

    function getData() public view returns (string memory) {
        require(closed, "Auction not finalized");
        require(msg.sender == highestBidder, "Only winner can access the data");
        return dataForSell;
    }

    function getAddresses() public view returns (address[] memory) {
        return addresses;
    }

    function getSummary()
        public
        view
        returns (
            uint256, uint256, uint256, address,
            uint256, string memory, string memory,
            address, address[] memory, uint256
        )
    {
        return (
            minimumContribution,
            address(this).balance,
            approversCount,
            manager,
            highestBid,
            dataForSell,
            dataDescription,
            highestBidder,
            addresses,
            endTime
        );
    }
}

contract CampaignFactory {
    address payable[] public deployedCampaigns;

    function createCampaign(
        uint256 minimum,
        string memory dataSell,
        string memory dataDesc,
        uint256 duration
    ) public {
        uint256 end = 60 * duration + block.timestamp;
        address newCampaign = address(
            new Campaign(minimum, dataSell, dataDesc, msg.sender, end)
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
        for (uint256 i = 0; i < deployedCampaigns.length; i++) {
            Campaign campaign = Campaign(deployedCampaigns[i]);
            if (!campaign.getStatus() && block.timestamp >= campaign.endTime()) {
                campaign.finalizeAuctionIfNeeded();
            }
        }
    }
}
