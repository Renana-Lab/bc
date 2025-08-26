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
    CampaignFactory public factory;
    event BidAdded(address contributor);
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

    // ביד ראשון חייב לעמוד במינימום
    if (highestBidder == address(0)) {
        require(newTotal >= minimumContribution, "Below minimum bid");
        factory.changeBudget(msg.sender, msg.value, false); // חייב את הביד הראשון
    } else {
        require(newTotal > highestBid, "Bid must exceed current highest");

        // אם זה יוזר אחר → החזר ל־prev, חיוב מלא ל־new
        if (msg.sender != highestBidder) {
            factory.changeBudget(highestBidder, highestBid, true);       // החזר מלא לקודם
            factory.changeBudget(msg.sender, newTotal, false);           // חיוב מלא לחדש
        } else {
            // אם זה אותו יוזר → חיוב על ההפרש בלבד
            factory.changeBudget(msg.sender, msg.value, false);
        }
    }

    approversMoney[msg.sender] = newTotal;
    highestBid = newTotal;
    highestBidder = msg.sender;

    transactions.push(Bid(msg.value, block.timestamp, msg.sender));

    if (!approvers[msg.sender]) {
        approvers[msg.sender] = true;
        approversCount++;
        addresses.push(msg.sender);
    }
    emit BidAdded(msg.sender);
     
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
            factory.changeBudget(manager, highestBid, true);
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
    event AuctionCreated(address campaignAddress);
    uint256 defaultBudget = 2000;
    address payable[] public deployedCampaigns;
    mapping(address => bool) public isCampaign;
    mapping(address => uint256) public usersBudget; // budgets
    mapping(address => bool) public isRegistered; // for first contribute
    address[] public allUsers; // for reset purposes

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
    function changeBudget(address user, uint256 amount, bool increase)
    external
    onlyCampaigns
    ensureRegistered(user)
    {
        if (increase) {
            usersBudget[user] += amount;
        } else {
            require(usersBudget[user] >= amount, "Insufficient budget");
            usersBudget[user] -= amount;
        } 
    }


    function resetAllBudgets(uint256 newBudget) public {
        for (uint256 i = 0; i < allUsers.length; i++) {
            address user = allUsers[i];
            usersBudget[user] = newBudget;
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
        isCampaign[newCampaign] = true; // ✅ הוספה לסט
        deployedCampaigns.push(payable(newCampaign));
        emit AuctionCreated(newCampaign);

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
