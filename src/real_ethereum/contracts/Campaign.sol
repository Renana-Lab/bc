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

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";




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


    IERC20Permit public token;


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
        address tokenAddress

    ) {
        manager = creator;
        minimumContribution = minimum;
        dataForSell = dataSell;
        dataDescription = dataDesc;
        endTime = duration;
        closed = false;
        token = IERC20Permit(tokenAddress);
    }

    function contribute(uint256 amount) public onlyBeforeEnd {
        require(msg.sender != manager, "You can't bid on your own auction");

        uint256 previous = approversMoney[msg.sender];
        uint256 newTotal = previous + amount;

        // בביד הראשון נדרש לעמוד במינימום, בבידים הבאים לא
        if (previous == 0) {
            require(newTotal >= minimumContribution, "Below minimum bid");
        }

        require(newTotal > highestBid, "Bid must exceed current highest");


        require(IERC20(address(token)).transferFrom(msg.sender, address(this), amount), "Transfer failed");


        // מעדכנים את המאזן המצטבר
        approversMoney[msg.sender] = newTotal;
        highestBid = newTotal;
        highestBidder = msg.sender;

        // שומרים רק את **סכום ההפרש** כהיסטוריה
        transactions.push(Bid(amount, block.timestamp, msg.sender));

        // רישום כתובת חדשה (פעם אחת בלבד)
        if (!approvers[msg.sender]) {
            approvers[msg.sender] = true;
            approversCount++;
            addresses.push(msg.sender);
        }
    }

    event PermitAttempt(
        address indexed owner,
        address indexed spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    );

    event PermitSuccess(address indexed owner, uint256 allowanceAfter);
    event PermitFailed(string reason);
    event AllowanceCheck(uint256 allowance, uint256 required);
    event NonceCheck(uint256 onChainNonce);
    event ContributeCalled(address contributor, uint256 amount);

    function permitAndContribute(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        address owner = msg.sender;
        address spender = address(this);

        // Emit on-chain nonce for visibility
        uint256 nonce = token.nonces(owner);
        emit NonceCheck(nonce);

        emit PermitAttempt(owner, spender, amount, nonce, deadline);

        // Try calling permit
        try token.permit(owner, spender, amount, deadline, v, r, s) {
            // Continue
        } catch Error(string memory reason) {
            emit PermitFailed(reason);
            revert(string(abi.encodePacked("Permit failed: ", reason)));
        } catch {
            emit PermitFailed("Unknown error");
            revert("Permit failed: unknown error");
        }

        // Confirm allowance is now set
        uint256 allowance = IERC20(address(token)).allowance(owner, spender);
        emit AllowanceCheck(allowance, amount);

        require(allowance >= amount, "Allowance was not updated by permit");

        emit PermitSuccess(owner, allowance);

        // Now safely contribute
        emit ContributeCalled(owner, amount);
        // contribute(amount);
                require(owner != manager, "You can't bid on your own auction");

        uint256 previous = approversMoney[owner];
        uint256 newTotal = previous + amount;

        // בביד הראשון נדרש לעמוד במינימום, בבידים הבאים לא
        if (previous == 0) {
            require(newTotal >= minimumContribution, "Below minimum bid");
        }

        require(newTotal > highestBid, "Bid must exceed current highest");


        require(IERC20(address(token)).transferFrom(owner, address(this), amount), "Transfer failed");


        // מעדכנים את המאזן המצטבר
        approversMoney[owner] = newTotal;
        highestBid = newTotal;
        highestBidder = owner;

        // שומרים רק את **סכום ההפרש** כהיסטוריה
        transactions.push(Bid(amount, block.timestamp, owner));

        // רישום כתובת חדשה (פעם אחת בלבד)
        if (!approvers[owner]) {
            approvers[owner] = true;
            approversCount++;
            addresses.push(owner);
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
                    require(IERC20(address(token)).transfer(contributor, refundAmount), "Refund failed");
                    emit RefundProcessed(contributor, refundAmount);
                }
            }
        }

        if (highestBid > 0) {
            require(IERC20(address(token)).transfer(manager, highestBid), "Payment to seller failed");
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
            IERC20(address(token)).balanceOf(address(this)),
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
        uint256 duration,
        address tokenAddress
    ) public {
        uint256 end = 60 * duration + block.timestamp;
        address newCampaign = address(
            new Campaign(minimum, dataSell, dataDesc, msg.sender, end, tokenAddress)
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
