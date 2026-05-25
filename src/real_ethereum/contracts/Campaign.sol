// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

contract Campaign {
    CampaignFactory public factory;

    event BidAdded(address contributor);
    event BidRecorded(
        address indexed bidder,
        uint256 amount,
        uint256 cumulativeBid,
        uint256 budgetBefore,
        uint256 budgetAfter,
        uint256 time,
        address indexed previousHighestBidder,
        uint256 previousHighestBid
    );
    event RefundProcessed(address indexed contributor, uint256 amount);
    event SellerPaid(address indexed seller, uint256 amount);

    struct Bid {
        uint256 value;
        uint256 time;
        address bidderAddress;
    }

    struct BidLedgerEntry {
        uint256 value;
        uint256 time;
        address bidderAddress;
        uint256 cumulativeBid;
        uint256 budgetBefore;
        uint256 budgetAfter;
        address previousHighestBidder;
        uint256 previousHighestBid;
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
    BidLedgerEntry[] public bidLedger;

    address public highestBidder;
    uint256 public highestBid;
    uint256 public endTime;
    bool public closed;
    uint256 public nextRefundIndex;

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
        uint256 duration,
        address factoryAddress
    ) {
        manager = creator;
        minimumContribution = minimum;
        dataForSell = dataSell;
        dataDescription = dataDesc;
        endTime = duration;
        closed = false;
        factory = CampaignFactory(factoryAddress);
    }

    function contribute() public payable onlyBeforeEnd {
        require(msg.sender != manager, "You can't bid on your own auction");
        require(msg.value > 0, "Must send some ether");

        uint256 previous = approversMoney[msg.sender];
        uint256 newTotal = previous + msg.value;
        uint256 previousHighestBid = highestBid;
        address previousHighestBidder = highestBidder;
        uint256 budgetBefore;
        uint256 budgetAfter;

        if (highestBidder == address(0)) {
            require(newTotal >= minimumContribution, "Below minimum bid");
            (budgetBefore, budgetAfter) = factory.changeBudget(
                msg.sender,
                msg.value,
                false
            );
        } else {
            require(newTotal > highestBid, "Bid must exceed current highest");

            if (msg.sender != highestBidder) {
                factory.changeBudget(highestBidder, highestBid, true);
                (budgetBefore, budgetAfter) = factory.changeBudget(
                    msg.sender,
                    newTotal,
                    false
                );
            } else {
                (budgetBefore, budgetAfter) = factory.changeBudget(
                    msg.sender,
                    msg.value,
                    false
                );
            }
        }

        approversMoney[msg.sender] = newTotal;
        highestBid = newTotal;
        highestBidder = msg.sender;

        transactions.push(Bid(msg.value, block.timestamp, msg.sender));
        bidLedger.push(
            BidLedgerEntry(
                msg.value,
                block.timestamp,
                msg.sender,
                newTotal,
                budgetBefore,
                budgetAfter,
                previousHighestBidder,
                previousHighestBid
            )
        );

        if (!approvers[msg.sender]) {
            approvers[msg.sender] = true;
            approversCount++;
            addresses.push(msg.sender);
        }

        emit BidAdded(msg.sender);
        emit BidRecorded(
            msg.sender,
            msg.value,
            newTotal,
            budgetBefore,
            budgetAfter,
            block.timestamp,
            previousHighestBidder,
            previousHighestBid
        );
    }

    function finalizeAuctionIfNeeded() public onlyAfterEnd {
        require(!closed, "Auction already finalized");

        closed = true;

        if (highestBid > 0) {
            require(address(this).balance >= highestBid, "Insufficient balance");
            approversMoney[highestBidder] = 0;

            (bool sent, ) = payable(manager).call{value: highestBid}("");
            require(sent, "Seller payment failed");

            factory.changeBudget(manager, highestBid, true);
            emit SellerPaid(manager, highestBid);
        }
    }

    function withdrawRefund() public {
        require(closed, "Auction not finalized");
        require(msg.sender != highestBidder, "Winner has no refund");

        uint256 refundAmount = approversMoney[msg.sender];
        require(refundAmount > 0, "No refund available");

        approversMoney[msg.sender] = 0;

        (bool sent, ) = payable(msg.sender).call{value: refundAmount}("");
        require(sent, "Refund failed");

        emit RefundProcessed(msg.sender, refundAmount);
    }

    function processRefunds(uint256 maxRefunds) public {
        require(closed, "Auction not finalized");
        require(maxRefunds > 0, "Batch size required");

        uint256 processed = 0;

        while (nextRefundIndex < addresses.length && processed < maxRefunds) {
            address contributor = addresses[nextRefundIndex];
            nextRefundIndex++;

            if (contributor == highestBidder) {
                continue;
            }

            uint256 refundAmount = approversMoney[contributor];
            if (refundAmount == 0) {
                continue;
            }

            approversMoney[contributor] = 0;

            (bool sent, ) = payable(contributor).call{value: refundAmount}("");
            require(sent, "Refund failed");

            emit RefundProcessed(contributor, refundAmount);
            processed++;
        }
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

    function getTransactionCount() public view returns (uint256) {
        return transactions.length;
    }

    function getTransactionAt(uint256 index) public view returns (Bid memory) {
        require(index < transactions.length, "Bid index out of range");
        return transactions[index];
    }

    function getBidLedger() public view returns (BidLedgerEntry[] memory) {
        return bidLedger;
    }

    function getBidLedgerAt(uint256 index)
        public
        view
        returns (BidLedgerEntry memory)
    {
        require(index < bidLedger.length, "Bid index out of range");
        return bidLedger[index];
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
            uint256,
            uint256,
            uint256,
            address,
            uint256,
            string memory,
            string memory,
            address,
            address[] memory,
            uint256
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

    function getListSummary()
        public
        view
        returns (
            uint256,
            uint256,
            uint256,
            address,
            uint256,
            string memory,
            address,
            uint256,
            bool
        )
    {
        return (
            minimumContribution,
            address(this).balance,
            approversCount,
            manager,
            highestBid,
            dataDescription,
            highestBidder,
            endTime,
            closed
        );
    }

    function getUserAuctionStatus(address user)
        public
        view
        returns (bool, uint256, bool, bool, bool)
    {
        bool participated = approvers[user];
        uint256 bid = approversMoney[user];
        bool isManager = user == manager;
        bool isHighestBidder = user == highestBidder;
        bool refunded = closed && participated && !isHighestBidder && bid == 0;

        return (participated, bid, refunded, isManager, isHighestBidder);
    }
}

contract CampaignFactory {
    event AuctionCreated(address campaignAddress);
    event AuctionCreatedDetailed(
        address indexed campaignAddress,
        address indexed seller,
        uint256 minimum,
        uint256 endTime,
        string dataDescription
    );
    event BudgetUpdated(address indexed user, uint256 newBudget);
    event BudgetChanged(
        address indexed campaignAddress,
        address indexed user,
        uint256 amount,
        bool increase,
        uint256 budgetBefore,
        uint256 budgetAfter
    );

    uint256 defaultBudget = 2000;
    address payable[] public deployedCampaigns;
    mapping(address => bool) public isCampaign;
    mapping(address => uint256) public usersBudget;
    mapping(address => bool) public isRegistered;
    address[] public allUsers;

    modifier onlyCampaigns() {
        require(isCampaign[msg.sender], "Only campaigns can modify budgets");
        _;
    }

    modifier ensureRegistered(address user) {
        if (!isRegistered[user]) {
            isRegistered[user] = true;
            usersBudget[user] = defaultBudget;
            allUsers.push(user);
        }
        _;
    }

    function getBudget(address user) public view returns (uint256) {
        if (!isRegistered[user]) {
            return defaultBudget;
        }
        return usersBudget[user];
    }

    function changeBudget(
        address user,
        uint256 amount,
        bool increase
    )
        external
        onlyCampaigns
        ensureRegistered(user)
        returns (uint256 budgetBefore, uint256 budgetAfter)
    {
        budgetBefore = usersBudget[user];

        if (increase) {
            usersBudget[user] += amount;
        } else {
            require(usersBudget[user] >= amount, "Insufficient budget");
            usersBudget[user] -= amount;
        }

        budgetAfter = usersBudget[user];
        emit BudgetUpdated(user, budgetAfter);
        emit BudgetChanged(
            msg.sender,
            user,
            amount,
            increase,
            budgetBefore,
            budgetAfter
        );
    }

    function resetAllBudgets(uint256 newBudget) public {
        defaultBudget = newBudget;
        for (uint256 i = 0; i < allUsers.length; i++) {
            address user = allUsers[i];
            uint256 budgetBefore = usersBudget[user];
            bool increased = newBudget >= budgetBefore;
            uint256 amountChanged = increased
                ? newBudget - budgetBefore
                : budgetBefore - newBudget;
            usersBudget[user] = defaultBudget;
            emit BudgetUpdated(user, defaultBudget);
            emit BudgetChanged(
                address(0),
                user,
                amountChanged,
                increased,
                budgetBefore,
                defaultBudget
            );
        }
    }

    function createCampaign(
        uint256 minimum,
        string memory dataSell,
        string memory dataDesc,
        uint256 duration
    ) public {
        uint256 end = 60 * duration + block.timestamp;
        address newCampaign = address(
            new Campaign(minimum, dataSell, dataDesc, msg.sender, end, address(this))
        );
        isCampaign[newCampaign] = true;
        deployedCampaigns.push(payable(newCampaign));
        emit AuctionCreated(newCampaign);
        emit AuctionCreatedDetailed(
            newCampaign,
            msg.sender,
            minimum,
            end,
            dataDesc
        );
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
