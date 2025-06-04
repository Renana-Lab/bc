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
pragma experimental ABIEncoderV2;

contract CampaignFactory {
    address payable[] public deployedCampaigns;

    function createCampaign(
        // create a campaign and add it to deployed existings campaigns
        uint256 minimum,
        string memory dataSell,
        string memory dataDesc,
        uint256 duration
    ) public {
        uint256 dur = 60 * duration + block.timestamp; // convert duration to real end time
        address newCampaign = address(
            new Campaign(minimum, dataSell, dataDesc, msg.sender, dur)
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

    function checkEndedAuctions() public payable {
        uint256 campaignsLength = deployedCampaigns.length;
        for (uint256 i = 0; i < campaignsLength; i++) {
            Campaign campaign = Campaign(deployedCampaigns[i]);
            campaign.EndedAuctions();
        }
    }
}

contract Campaign {
    event LogMyVariable(address[] indexed myVariable);
    event LogMyVariable1(address indexed myVariable);

    // approvers mean people who contributed to the auction
    struct Bid {
        uint256 value;
        uint256 time;
        address sellerAddress;
    }
    Bid[] public transactions;
    address public manager;
    uint256 public minimumContribution;
    string public dataForSell;
    string public dataDescription;
    mapping(address => bool) public approvers;
    mapping(address => uint256) public approversMonney;
    uint256 public approversCount;
    address[] public addresses;
    address public highestBidder;
    uint256 public highestBid;
    uint256 public endTime;
    bool public closed;
    // uint256 public startTime;
    modifier restricted() {
        require(msg.sender == manager);
        _;
    }

    constructor(
        uint256 minimum,
        string memory dataSell,
        string memory dataDesc,
        address creator,
        uint256 endtime // uint256 starttime
    ) {
        manager = creator;
        minimumContribution = minimum;
        dataForSell = dataSell;
        dataDescription = dataDesc;
        endTime = endtime;
        closed = false;
        // startTime = starttime;
    }

    function compareAddresses(address a, address b) public pure returns (bool) {
        return toLower(a) == toLower(b);
    }

    function toLower(address _address) public pure returns (address) {
        uint160 intAddress = uint160(_address);
        for (uint i = 0; i < 20; i++) {
            uint8 b = uint8(bytes20(_address)[i]);
            if (b >= 65 && b <= 90) {
                b += 32;
            }
            intAddress |= uint160(b) << uint160(8 * (19 - i));
        }
        return address(intAddress);
    }

    function EndedAuctions() public payable {
        //step 1 check if the auction is ended
        if (endTime < block.timestamp) {
            // step 2 go over the approvers
            uint256 index = 0;
            address[] memory nonWinningAddresses = new address[](
                addresses.length - 1
            );

            for (uint i = 0; i < addresses.length; i++) {
                emit LogMyVariable1(toLower(addresses[i]));
                emit LogMyVariable1(highestBidder);
                if (
                    !compareAddresses(
                        toLower(addresses[i]),
                        toLower(highestBidder)
                    )
                ) {
                    nonWinningAddresses[index] = addresses[i];
                    index++;
                }

                // step 3 give monney back if not the winner
                // if (addresses[i] != highestBidder){
                //     withdrawBid(payable(msg.sender));
                // }
            }

            emit LogMyVariable(nonWinningAddresses);
            emit LogMyVariable(addresses);
            for (uint256 i = 0; i < nonWinningAddresses.length; i++) {
                withdrawBid(payable(nonWinningAddresses[i]));
            }
        }
    }

    function getTransactions() public view returns (Bid[] memory) {
        return transactions;
    }

    function getBid(address add) public view returns (uint256) {
        uint256 monney = 0;

        if (approversMonney[add] != 0) {
            monney = approversMonney[add];
        }

        return monney;
    }
    function getStatus() public view returns (bool) {
        return closed;
    }

    function getAddresses() public view returns (address[] memory) {
        return addresses;
    }

    function contribute() public payable {
        require(msg.sender != manager, "you can't buy your own data");
        require(
            endTime > block.timestamp,
            "you can't contribute to an ended auction"
        );

        uint256 currentBid = approversMonney[msg.sender];
        uint256 newTotalBid = currentBid + msg.value;

        require(newTotalBid >= minimumContribution, "Bid below minimum");
        require(
            newTotalBid > highestBid,
            "There already is a higher or equal bid"
        );

        // Update highest bid state
        highestBidder = msg.sender;
        highestBid = newTotalBid;
        approversMonney[msg.sender] = newTotalBid;

        transactions.push(Bid(msg.value, block.timestamp, msg.sender));

        if (!approvers[msg.sender]) {
            approvers[msg.sender] = true;
            approversCount++;
            addresses.push(msg.sender);
        }
    }

function paySeller() public {
    require(!closed, "Auction already closed");
    require(address(this).balance >= highestBid, "Insufficient balance");
    payable(manager).transfer(highestBid);
    closed = true;
}



 function withdrawBid(address payable _address) public {
    require(approversMonney[_address] > 0, "No bid to refund");
    uint256 refund = approversMonney[_address];
    approversMonney[_address] = 0;
    _address.transfer(refund);
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
            approversCount,
            manager,
            highestBid,
            dataForSell,
            dataDescription,
            endTime,
            highestBidder,
            addresses
        );
    }
}
