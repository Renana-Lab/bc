// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import {SiweAuth} from "@oasisprotocol/sapphire-contracts/contracts/auth/SiweAuth.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract Campaign {
    // Storage is packed for cheap clone initialization (each fresh slot costs ~22k gas):
    // slot 0 = factory + closed + cancelled; slot 1 = manager + endTime + minimum.
    // An uninitialized clone has factory == address(0), which doubles as the "initialized" guard.
    CampaignFactory public factory;
    bool public closed;
    bool public cancelled;

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
    event SellerPaymentDeferred(address indexed seller, uint256 amount);
    event RefundFailed(address indexed contributor, uint256 amount);

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
    uint64 private _endTime;
    uint32 private _minimum; // 1..MAX_MINIMUM (1e9) fits uint32
    // Confidential: no public getter. Readable only through getData() by the winner.
    // Only meaningful on Oasis Sapphire, where storage and calldata are encrypted and
    // view calls are authenticated (msg.sender is the signer). Never emit or return it elsewhere.
    string private dataForSell;
    string public dataDescription;

    mapping(address => bool) public approvers;
    mapping(address => uint256) public approversMoney;
    uint256 public approversCount;

    address[] public addresses;
    Bid[] public transactions;
    BidLedgerEntry[] public bidLedger;

    address public highestBidder;
    uint256 public highestBid;
    uint256 public nextRefundIndex;
    // Seller proceeds whose push payment failed; pulled with withdrawSellerPayment().
    uint256 public sellerOwed;

    uint256 public constant MAX_MINIMUM = 1_000_000_000;
    // Gas forwarded to each recipient in processRefunds so one hostile receiver cannot burn the batch.
    uint256 private constant REFUND_CALL_GAS = 100_000;

    modifier onlyBeforeEnd() {
        require(block.timestamp < _endTime, "Auction ended");
        _;
    }

    modifier onlyAfterEnd() {
        require(block.timestamp >= _endTime, "Auction not ended yet");
        _;
    }

    modifier onlyFactory() {
        require(msg.sender == address(factory), "Only factory");
        _;
    }

    // The implementation contract is locked; auctions are EIP-1167 clones initialized once.
    constructor() {
        factory = CampaignFactory(address(1)); // locks the implementation (clones start with factory == 0)
    }

    function endTime() public view returns (uint256) {
        return _endTime;
    }

    function minimumContribution() public view returns (uint256) {
        return _minimum;
    }

    function initialize(
        uint256 minimum,
        string memory dataSell,
        string memory dataDesc,
        address creator,
        uint256 endTimestamp,
        address factoryAddress
    ) external {
        require(address(factory) == address(0), "Already initialized");
        require(msg.sender == factoryAddress, "Only factory");
        require(minimum >= 1 && minimum <= MAX_MINIMUM, "Minimum out of range");
        require(endTimestamp <= type(uint64).max, "End time out of range");
        factory = CampaignFactory(factoryAddress);
        manager = creator;
        _minimum = uint32(minimum);
        _endTime = uint64(endTimestamp);
        dataForSell = dataSell;
        dataDescription = dataDesc;
    }

    function contribute() public payable onlyBeforeEnd {
        require(!closed, "Auction closed");
        require(msg.sender != manager, "You can't bid on your own auction");
        require(msg.value > 0, "Must send some ether");

        uint256 previous = approversMoney[msg.sender];
        uint256 newTotal = previous + msg.value;
        uint256 previousHighestBid = highestBid;
        address previousHighestBidder = highestBidder;
        uint256 budgetBefore;
        uint256 budgetAfter;

        if (highestBidder == address(0)) {
            require(newTotal >= _minimum, "Below minimum bid");
            (budgetBefore, budgetAfter) = factory.holdBid(msg.sender, msg.value);
        } else {
            require(newTotal > highestBid, "Bid must exceed current highest");

            if (msg.sender != highestBidder) {
                factory.releaseBid(highestBidder, highestBid);
                (budgetBefore, budgetAfter) = factory.holdBid(msg.sender, newTotal);
            } else {
                (budgetBefore, budgetAfter) = factory.holdBid(msg.sender, msg.value);
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
            uint256 amount = highestBid;
            require(address(this).balance >= amount, "Insufficient balance");
            approversMoney[highestBidder] = 0;

            factory.settleBid(highestBidder, manager, amount);

            // A seller that cannot receive must not block finalization or the refunds.
            (bool sent, ) = payable(manager).call{value: amount}("");
            if (sent) {
                emit SellerPaid(manager, amount);
            } else {
                sellerOwed += amount;
                emit SellerPaymentDeferred(manager, amount);
            }
        }
    }

    function withdrawSellerPayment() public {
        require(msg.sender == manager, "Only seller");
        uint256 amount = sellerOwed;
        require(amount > 0, "Nothing owed");
        sellerOwed = 0;
        (bool sent, ) = payable(manager).call{value: amount}("");
        require(sent, "Payment failed");
        emit SellerPaid(manager, amount);
    }

    function withdrawRefund() public {
        require(closed, "Auction not finalized");
        // The leader is refunded too when the auction was cancelled (no sale happened).
        require(cancelled || msg.sender != highestBidder, "Winner has no refund");

        uint256 refundAmount = approversMoney[msg.sender];
        require(refundAmount > 0, "No refund available");

        approversMoney[msg.sender] = 0;

        (bool sent, ) = payable(msg.sender).call{value: refundAmount}("");
        require(sent, "Refund failed");

        emit RefundProcessed(msg.sender, refundAmount);
    }

    // Pays up to maxRefunds entries (paid, skipped or failed all count). A recipient that
    // rejects the transfer is skipped and keeps its pull refund via withdrawRefund().
    function processRefunds(uint256 maxRefunds) public {
        require(closed, "Auction not finalized");
        require(maxRefunds > 0, "Batch size required");

        uint256 processed = 0;

        while (nextRefundIndex < addresses.length && processed < maxRefunds) {
            address contributor = addresses[nextRefundIndex];
            nextRefundIndex++;
            processed++;

            if (contributor == highestBidder && !cancelled) {
                continue;
            }

            uint256 refundAmount = approversMoney[contributor];
            if (refundAmount == 0) {
                continue;
            }

            approversMoney[contributor] = 0;

            (bool sent, ) = payable(contributor).call{
                value: refundAmount,
                gas: REFUND_CALL_GAS
            }("");
            if (sent) {
                emit RefundProcessed(contributor, refundAmount);
            } else {
                approversMoney[contributor] = refundAmount;
                emit RefundFailed(contributor, refundAmount);
            }
        }
    }

    // ---- minimum edits (admin via factory, seller when allowed) ----
    function adminSetMinimum(uint256 newMin) external onlyFactory returns (uint256 oldMin) {
        oldMin = _setMinimum(newMin);
    }

    function sellerSetMinimum(uint256 newMin) external {
        require(msg.sender == manager, "Only seller");
        require(factory.allowSellerEdit(), "Seller edits disabled");
        uint256 oldMin = _setMinimum(newMin);
        factory.announceMinimum(oldMin, newMin, msg.sender);
    }

    function _setMinimum(uint256 newMin) private returns (uint256 oldMin) {
        require(!closed, "Auction closed");
        require(block.timestamp < _endTime, "Auction ended");
        require(highestBidder == address(0), "Bids already placed");
        require(newMin >= 1 && newMin <= MAX_MINIMUM, "Minimum out of range");
        oldMin = _minimum;
        _minimum = uint32(newMin);
    }

    // ---- admin controls, reachable only through the factory ----
    function adminCloseNow() external onlyFactory {
        require(!closed, "Auction closed");
        if (_endTime > block.timestamp) {
            _endTime = uint64(block.timestamp);
        }
    }

    // Returns true when money was moved (auction was live), false when it was already finalized
    // and nothing changed besides the caller hiding it.
    function adminCancel() external onlyFactory returns (bool released) {
        require(!cancelled, "Already cancelled");
        if (closed) {
            return false;
        }
        if (highestBidder != address(0)) {
            factory.releaseBid(highestBidder, highestBid);
        }
        closed = true;
        cancelled = true;
        return true;
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

    // Winner-only read of the confidential payload.
    //
    // getData(): authenticates by msg.sender. On Sapphire an unauthenticated
    // eth_call has msg.sender == address(0), so it can never match a real winner;
    // only a transaction or an authenticated call is accepted.
    // getDataWithToken(): authenticates with a SIWE bearer token issued by the
    // factory's login(), so a wallet signs once per session instead of per read.
    function getData() public view returns (string memory) {
        return _readData(msg.sender);
    }

    function getDataWithToken(bytes calldata token)
        public
        view
        returns (string memory)
    {
        return _readData(factory.authenticate(token));
    }

    function _readData(address reader) private view returns (string memory) {
        require(!cancelled, "Auction cancelled");
        require(closed, "Auction not finalized");
        require(highestBidder != address(0), "No winner");
        require(reader == highestBidder, "Only winner can access the data");
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
            address,
            address[] memory,
            uint256
        )
    {
        return (
            _minimum,
            address(this).balance,
            approversCount,
            manager,
            highestBid,
            dataDescription,
            highestBidder,
            addresses,
            _endTime
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
            _minimum,
            address(this).balance,
            approversCount,
            manager,
            highestBid,
            dataDescription,
            highestBidder,
            _endTime,
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

contract CampaignFactory is SiweAuth {
    // ---- limits (bytes for strings; the UI limits description to 300 characters) ----
    uint256 public constant MAX_DESCRIPTION_BYTES = 1200;
    // The 15M block gas limit makes large payloads impossible; see the PR for measured gas.
    uint256 public constant MAX_PAYLOAD_BYTES = 2000;
    uint256 public constant MAX_MINIMUM = 1_000_000_000;
    uint256 public constant MAX_NOTE_BYTES = 500;

    event AuctionCreated(address campaignAddress);
    event AuctionCreatedDetailed(
        address indexed campaignAddress,
        address indexed seller,
        uint256 minimum,
        uint256 endTime,
        string dataDescription
    );
    event BudgetUpdated(address indexed user, uint256 newBudget);
    // campaignAddress == address(0) for admin edits and lazily applied global resets.
    event BudgetChanged(
        address indexed campaignAddress,
        address indexed user,
        uint256 amount,
        bool increase,
        uint256 budgetBefore,
        uint256 budgetAfter
    );
    event GlobalBudgetReset(uint256 indexed epoch, uint256 newBudget, address indexed by);
    event UserBudgetSet(address indexed user, uint256 total, uint256 available, address indexed by);
    event AuctionFinalizationFailed(address indexed campaignAddress, bytes reason);

    event AdminAdded(address indexed admin, address indexed by);
    event AdminRemoved(address indexed admin, address indexed by);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MinimumChanged(
        address indexed campaign,
        uint256 oldMinimum,
        uint256 newMinimum,
        address indexed by
    );
    event AuctionClosedEarly(address indexed campaign, address indexed by);
    // Carries the admin's note only, never the auction payload.
    event AuctionCancelled(
        address indexed campaign,
        address indexed by,
        string note,
        bool fundsReleased
    );
    event AuctionHiddenChanged(address indexed campaign, bool hidden, address indexed by);
    event UserDisabledChanged(address indexed user, bool disabled, address indexed by);
    event SellerEditAllowedChanged(bool allowed, address indexed by);

    // `inDomain` is the web origin host the SIWE login message must name
    // (for example "localhost:3000"); see docs/SAPPHIRE_CONFIDENTIAL_MARKETPLACE.md.
    constructor(string memory inDomain, address initialOwner) SiweAuth(inDomain) {
        require(initialOwner != address(0), "Owner required");
        owner = initialOwner;
        isAdmin[initialOwner] = true;
        implementation = address(new Campaign());
        emit OwnershipTransferred(address(0), initialOwner);
        emit AdminAdded(initialOwner, msg.sender);
    }

    // Used by Campaign.getDataWithToken. Returns address(0) for an empty token.
    function authenticate(bytes calldata token) external view returns (address) {
        return authMsgSender(token);
    }

    // ---- roles ----
    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isAdmin;
    address public immutable implementation;

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyAdmin() {
        require(isAdmin[msg.sender], "Only admin");
        _;
    }

    function addAdmin(address admin) external onlyOwner {
        require(admin != address(0), "Zero address");
        require(!isAdmin[admin], "Already admin");
        isAdmin[admin] = true;
        emit AdminAdded(admin, msg.sender);
    }

    function removeAdmin(address admin) external onlyOwner {
        require(admin != owner, "Owner cannot be removed");
        require(isAdmin[admin], "Not admin");
        isAdmin[admin] = false;
        emit AdminRemoved(admin, msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not pending owner");
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        if (!isAdmin[msg.sender]) {
            isAdmin[msg.sender] = true;
            emit AdminAdded(msg.sender, msg.sender);
        }
        emit OwnershipTransferred(previous, msg.sender);
    }

    // ---- budgets (lazy global epoch) ----
    uint256 public defaultBudget = 2000;
    uint256 public budgetEpoch;
    address payable[] public deployedCampaigns;
    mapping(address => bool) public isCampaign;
    // Raw stored budget (available = total - held). Stale when userEpoch != budgetEpoch; use getBudget().
    mapping(address => uint256) public usersBudget;
    mapping(address => uint256) public userEpoch;
    // Amount reserved by currently leading bids on unfinalized auctions.
    mapping(address => uint256) public heldBy;
    mapping(address => bool) public isRegistered;
    address[] public allUsers;

    // ---- admin state ----
    mapping(address => bool) public hidden; // UI-only: no contract logic depends on it
    // Partial control: a user can bypass it with a new wallet.
    mapping(address => bool) public disabled;
    bool public allowSellerEdit = true;

    modifier onlyCampaigns() {
        require(isCampaign[msg.sender], "Only campaigns can modify budgets");
        _;
    }

    function allUsersCount() external view returns (uint256) {
        return allUsers.length;
    }

    function _effective(address user) internal view returns (uint256) {
        if (!isRegistered[user]) return defaultBudget;
        if (userEpoch[user] == budgetEpoch) return usersBudget[user];
        uint256 held = heldBy[user];
        return defaultBudget > held ? defaultBudget - held : 0;
    }

    function getBudget(address user) public view returns (uint256) {
        return _effective(user);
    }

    // Registers a new user or lazily applies a pending global reset.
    function _sync(address user) internal {
        if (!isRegistered[user]) {
            isRegistered[user] = true;
            usersBudget[user] = defaultBudget;
            userEpoch[user] = budgetEpoch;
            allUsers.push(user);
            return;
        }
        if (userEpoch[user] != budgetEpoch) {
            uint256 before = usersBudget[user];
            uint256 effective = _effective(user);
            usersBudget[user] = effective;
            userEpoch[user] = budgetEpoch;
            emit BudgetUpdated(user, effective);
            emit BudgetChanged(
                address(0),
                user,
                effective >= before ? effective - before : before - effective,
                effective >= before,
                before,
                effective
            );
        }
    }

    function _emitCampaignBudget(
        address user,
        uint256 amount,
        bool increase,
        uint256 before,
        uint256 afterBudget
    ) private {
        emit BudgetUpdated(user, afterBudget);
        emit BudgetChanged(msg.sender, user, amount, increase, before, afterBudget);
    }

    // A user's bid takes the lead: reserve `amount` from the available budget.
    function holdBid(address user, uint256 amount)
        external
        onlyCampaigns
        returns (uint256 budgetBefore, uint256 budgetAfter)
    {
        require(!disabled[user], "User disabled");
        _sync(user);
        budgetBefore = usersBudget[user];
        require(budgetBefore >= amount, "Insufficient budget");
        usersBudget[user] = budgetBefore - amount;
        heldBy[user] += amount;
        budgetAfter = usersBudget[user];
        _emitCampaignBudget(user, amount, false, budgetBefore, budgetAfter);
    }

    // A leading bid is outbid or its auction cancelled: the reservation returns to available.
    function releaseBid(address user, uint256 amount) external onlyCampaigns {
        _sync(user);
        require(heldBy[user] >= amount, "Release exceeds held");
        uint256 budgetBefore = usersBudget[user];
        heldBy[user] -= amount;
        usersBudget[user] = budgetBefore + amount;
        _emitCampaignBudget(user, amount, true, budgetBefore, usersBudget[user]);
    }

    // Auction finalized: the winner's reservation is spent and the seller is credited.
    function settleBid(address winner, address seller, uint256 amount) external onlyCampaigns {
        _sync(winner);
        require(heldBy[winner] >= amount, "Settle exceeds held");
        heldBy[winner] -= amount;

        _sync(seller);
        uint256 budgetBefore = usersBudget[seller];
        usersBudget[seller] = budgetBefore + amount;
        _emitCampaignBudget(seller, amount, true, budgetBefore, usersBudget[seller]);
    }

    function announceMinimum(uint256 oldMin, uint256 newMin, address by) external onlyCampaigns {
        emit MinimumChanged(msg.sender, oldMin, newMin, by);
    }

    // No loop: bumps the epoch; each user is brought to the new default lazily (minus what they hold).
    function resetAllBudgets(uint256 newBudget) public onlyAdmin {
        require(newBudget >= 1, "Budget must be positive");
        defaultBudget = newBudget;
        budgetEpoch += 1;
        emit GlobalBudgetReset(budgetEpoch, newBudget, msg.sender);
    }

    // Sets the user's TOTAL budget; available = total - held (mirrors the marketplace setBudget).
    function setUserBudget(address user, uint256 total) external onlyAdmin {
        require(user != address(0), "Zero address");
        uint256 held = heldBy[user];
        require(total >= held, "Total below held funds");
        uint256 before = _effective(user);
        if (!isRegistered[user]) {
            isRegistered[user] = true;
            allUsers.push(user);
        }
        uint256 available = total - held;
        usersBudget[user] = available;
        userEpoch[user] = budgetEpoch;
        emit BudgetUpdated(user, available);
        emit BudgetChanged(
            address(0),
            user,
            available >= before ? available - before : before - available,
            available >= before,
            before,
            available
        );
        emit UserBudgetSet(user, total, available, msg.sender);
    }

    function setDisabled(address user, bool value) external onlyAdmin {
        require(user != address(0), "Zero address");
        require(user != owner, "Cannot disable owner");
        disabled[user] = value;
        emit UserDisabledChanged(user, value, msg.sender);
    }

    function setAllowSellerEdit(bool allowed) external onlyAdmin {
        allowSellerEdit = allowed;
        emit SellerEditAllowedChanged(allowed, msg.sender);
    }

    // ---- per-auction admin controls ----
    modifier knownCampaign(address campaign) {
        require(isCampaign[campaign], "Unknown campaign");
        _;
    }

    function setMinimum(address campaign, uint256 newMin)
        external
        onlyAdmin
        knownCampaign(campaign)
    {
        uint256 oldMin = Campaign(campaign).adminSetMinimum(newMin);
        emit MinimumChanged(campaign, oldMin, newMin, msg.sender);
    }

    function closeNow(address campaign) external onlyAdmin knownCampaign(campaign) {
        Campaign(campaign).adminCloseNow();
        emit AuctionClosedEarly(campaign, msg.sender);
    }

    function cancelAuction(address campaign, string calldata note)
        external
        onlyAdmin
        knownCampaign(campaign)
    {
        require(bytes(note).length <= MAX_NOTE_BYTES, "Note too long");
        bool released = Campaign(campaign).adminCancel();
        if (!released && !hidden[campaign]) {
            // Already finalized: hide only, no money moves.
            hidden[campaign] = true;
            emit AuctionHiddenChanged(campaign, true, msg.sender);
        }
        emit AuctionCancelled(campaign, msg.sender, note, released);
    }

    function setHidden(address campaign, bool value) external onlyAdmin knownCampaign(campaign) {
        hidden[campaign] = value;
        emit AuctionHiddenChanged(campaign, value, msg.sender);
    }

    function getHiddenFlags(address[] calldata campaigns) external view returns (bool[] memory flags) {
        flags = new bool[](campaigns.length);
        for (uint256 i = 0; i < campaigns.length; i++) {
            flags[i] = hidden[campaigns[i]];
        }
    }

    function createCampaign(
        uint256 minimum,
        string memory dataSell,
        string memory dataDesc,
        uint256 duration
    ) public {
        require(!disabled[msg.sender], "User disabled");
        require(minimum >= 1 && minimum <= MAX_MINIMUM, "Minimum out of range");
        uint256 payloadLen = bytes(dataSell).length;
        require(payloadLen > 0, "Data for sale is required");
        require(payloadLen <= MAX_PAYLOAD_BYTES, "Data too large");
        uint256 descLen = bytes(dataDesc).length;
        require(descLen > 0, "Description is required");
        require(descLen <= MAX_DESCRIPTION_BYTES, "Description too long");
        require(duration >= 1 && duration <= 30, "Duration must be 1-30 minutes");
        uint256 end = 60 * duration + block.timestamp;
        address newCampaign = Clones.clone(implementation);
        isCampaign[newCampaign] = true;
        Campaign(newCampaign).initialize(minimum, dataSell, dataDesc, msg.sender, end, address(this));
        deployedCampaigns.push(payable(newCampaign));
        emit AuctionCreated(newCampaign);
        emit AuctionCreatedDetailed(newCampaign, msg.sender, minimum, end, dataDesc);
    }

    function getDeployedCampaigns()
        public
        view
        returns (address payable[] memory)
    {
        return deployedCampaigns;
    }

    function checkEndedAuctionsRange(uint256 start, uint256 maxAuctions)
        public
        returns (uint256 nextIndex, uint256 finalized)
    {
        require(maxAuctions > 0, "Batch size required");
        require(start <= deployedCampaigns.length, "Start index out of range");
        uint256 end = start + maxAuctions;
        if (end > deployedCampaigns.length) {
            end = deployedCampaigns.length;
        }

        for (uint256 i = start; i < end; i++) {
            Campaign campaign = Campaign(deployedCampaigns[i]);
            if (!campaign.getStatus() && block.timestamp >= campaign.endTime()) {
                try campaign.finalizeAuctionIfNeeded() {
                    finalized++;
                } catch (bytes memory reason) {
                    emit AuctionFinalizationFailed(address(campaign), reason);
                }
            }
        }

        return (end, finalized);
    }
}
