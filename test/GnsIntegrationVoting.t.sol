// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {GnsIntegrationVoting, IGnsVotingNameNFT} from "../src/GnsIntegrationVoting.sol";
import {DeployGnsIntegrationVoting} from "../script/DeployGnsIntegrationVoting.s.sol";

contract VotingFeeScheduleMock is IGnsVotingNameNFT {
    mapping(uint256 labelLength => uint256 fee) internal fees;

    function setFee(uint256 labelLength, uint256 fee) external {
        fees[labelLength] = fee;
    }

    function getFee(uint256 labelLength) external view returns (uint256) {
        return fees[labelLength];
    }

    function ownerOf(uint256) external pure returns (address) {
        return address(1);
    }

    function records(uint256)
        external
        pure
        returns (string memory, uint256, uint64, uint64, uint64)
    {
        return ("mock", 0, type(uint64).max, 1, 0);
    }
}

contract GnsIntegrationVotingTest is Test {
    NameNFT internal nft;
    GnsIntegrationVoting internal voting;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint256 internal constant MIN_COMMITMENT_AGE = 60;
    uint256 internal constant GRACE_PERIOD = 90 days;
    uint256 internal constant PREMIUM_DECAY_PERIOD = 21 days;
    uint256 internal constant MAX_TX_GAS = 1 << 24;
    uint256 internal constant MAX_CALLDATA_GAS_PER_BYTE = 40;

    bytes32 internal constant AMBIRE = keccak256("ambire");
    bytes32 internal constant SNAPSHOT = keccak256("snapshot");
    bytes32 internal constant ZSWAP = keccak256("zswap");

    event BallotCast(
        address indexed voter,
        uint256 indexed tokenId,
        uint64 indexed epoch,
        bytes32[] integrationIds,
        uint16[] votes
    );

    function setUp() public {
        nft = new NameNFT();
        voting = new GnsIntegrationVoting(IGnsVotingNameNFT(address(nft)));
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function test_DeploymentIsBoundAndOwnerless() public view {
        assertEq(address(voting.gns()), address(nft));
        assertEq(voting.baseFee(), 0.0005 ether);
        assertEq(address(voting).balance, 0);
    }

    function test_RevertZeroGns() public {
        vm.expectRevert(GnsIntegrationVoting.InvalidGns.selector);
        new GnsIntegrationVoting(IGnsVotingNameNFT(address(0)));
    }

    function test_PriceWeightedSchedule() public view {
        assertEq(voting.votingPowerForLength(0), 0);
        assertEq(voting.votingPowerForLength(1), 1000);
        assertEq(voting.votingPowerForLength(2), 200);
        assertEq(voting.votingPowerForLength(3), 100);
        assertEq(voting.votingPowerForLength(4), 20);
        assertEq(voting.votingPowerForLength(5), 1);
        assertEq(voting.votingPowerForLength(255), 1);
        assertEq(voting.votingPowerForLength(256), 0);
        assertEq(voting.votingPowerForLength(type(uint256).max), 0);
    }

    function testFuzz_PriceWeightedSchedule(uint256 labelLength) public view {
        labelLength = bound(labelLength, 1, 255);
        uint256 fee = nft.getFee(labelLength);
        uint256 power = voting.votingPowerForLength(labelLength);
        assertEq(power, fee / voting.baseFee());
        assertEq(power * voting.baseFee(), fee);
    }

    function test_RevertZeroBaseFee() public {
        VotingFeeScheduleMock fees = new VotingFeeScheduleMock();
        vm.expectRevert(GnsIntegrationVoting.InvalidFeeSchedule.selector);
        new GnsIntegrationVoting(IGnsVotingNameNFT(address(fees)));
    }

    function test_RevertInvalidFeeScheduleAfterDeployment() public {
        VotingFeeScheduleMock fees = new VotingFeeScheduleMock();
        fees.setFee(5, 2);
        GnsIntegrationVoting candidate = new GnsIntegrationVoting(IGnsVotingNameNFT(address(fees)));

        vm.expectRevert(GnsIntegrationVoting.InvalidFeeSchedule.selector);
        candidate.votingPowerForLength(1);

        fees.setFee(1, 3);
        vm.expectRevert(GnsIntegrationVoting.InvalidFeeSchedule.selector);
        candidate.votingPowerForLength(1);

        fees.setFee(1, 131_072);
        vm.expectRevert(GnsIntegrationVoting.InvalidFeeSchedule.selector);
        candidate.votingPowerForLength(1);
    }

    function test_UnicodeUsesUtf8ByteLength() public {
        uint256 tokenId = _registerName(unicode"🦄", alice);
        assertEq(bytes(unicode"🦄").length, 4);
        assertEq(voting.votingPower(tokenId), 20);
    }

    function test_CastSplitBallot() public {
        uint256 tokenId = _registerName("a", alice);
        bytes32[] memory ids = _sortedIds(AMBIRE, SNAPSHOT);
        uint16[] memory amounts = new uint16[](2);
        amounts[0] = 400;
        amounts[1] = 600;
        GnsIntegrationVoting.Ballot[] memory ballots = _oneBallot(tokenId, ids, amounts);

        vm.expectEmit(true, true, true, true);
        emit BallotCast(alice, tokenId, 1, ids, amounts);
        vm.prank(alice);
        voting.cast(ballots);
    }

    function test_CastMultipleNamesAtomically() public {
        uint256 oneByte = _registerName("a", alice);
        uint256 longName = _registerName("alice", alice);

        GnsIntegrationVoting.Ballot[] memory ballots = new GnsIntegrationVoting.Ballot[](2);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = AMBIRE;
        uint16[] memory premiumVotes = new uint16[](1);
        premiumVotes[0] = 1000;
        uint16[] memory regularVotes = new uint16[](1);
        regularVotes[0] = 1;

        if (oneByte < longName) {
            ballots[0] = GnsIntegrationVoting.Ballot(oneByte, ids, premiumVotes);
            ballots[1] = GnsIntegrationVoting.Ballot(longName, ids, regularVotes);
        } else {
            ballots[0] = GnsIntegrationVoting.Ballot(longName, ids, regularVotes);
            ballots[1] = GnsIntegrationVoting.Ballot(oneByte, ids, premiumVotes);
        }

        vm.prank(alice);
        voting.cast(ballots);
    }

    function test_EmptyAllocationClearsBallot() public {
        uint256 tokenId = _registerName("alice", alice);
        bytes32[] memory noIds = new bytes32[](0);
        uint16[] memory noVotes = new uint16[](0);

        vm.expectEmit(true, true, true, true);
        emit BallotCast(alice, tokenId, 1, noIds, noVotes);
        vm.prank(alice);
        voting.cast(_oneBallot(tokenId, noIds, noVotes));
    }

    function test_VotingPowerIsZeroForExpiredNameAndSubdomain() public {
        uint256 parent = _registerName("alice", alice);
        vm.prank(alice);
        uint256 subdomain = nft.registerSubdomain("sub", parent);
        assertEq(voting.votingPower(subdomain), 0);

        uint256 expiry = nft.expiresAt(parent);
        vm.warp(expiry + 1);
        assertEq(voting.votingPower(parent), 0);
    }

    function test_ExactExpiryStillVotesButGraceDoesNot() public {
        uint256 tokenId = _registerName("alice", alice);
        uint256 expiry = nft.expiresAt(tokenId);

        vm.warp(expiry);
        vm.prank(alice);
        voting.cast(_singleChoice(tokenId, AMBIRE, 1));

        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsIntegrationVoting.InactiveName.selector, tokenId));
        voting.cast(_singleChoice(tokenId, AMBIRE, 1));
    }

    function test_PermissionlessRenewalKeepsOwnerEpochAndBallotIdentity() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.prank(alice);
        voting.cast(_singleChoice(tokenId, AMBIRE, 1));

        uint256 oldExpiry = nft.expiresAt(tokenId);
        (,,, uint64 oldEpoch,) = nft.records(tokenId);
        vm.warp(oldExpiry + 1);
        assertEq(voting.votingPower(tokenId), 0);

        vm.prank(bob);
        nft.renew{value: nft.getFee(5)}(tokenId);

        (,, uint64 newExpiry, uint64 newEpoch,) = nft.records(tokenId);
        assertEq(nft.ownerOf(tokenId), alice);
        assertEq(newEpoch, oldEpoch);
        assertGt(newExpiry, block.timestamp);
        assertEq(voting.votingPower(tokenId), 1);
    }

    function test_RevertEmptyBallots() public {
        vm.expectRevert(GnsIntegrationVoting.EmptyBallots.selector);
        voting.cast(new GnsIntegrationVoting.Ballot[](0));
    }

    function test_RevertBallotsNotSortedOrDuplicated() public {
        uint256 first = _registerName("alice", alice);
        uint256 second = _registerName("bobbb", alice);
        GnsIntegrationVoting.Ballot[] memory ballots = new GnsIntegrationVoting.Ballot[](2);
        GnsIntegrationVoting.Ballot[] memory firstBallot = _singleChoice(first, AMBIRE, 1);
        GnsIntegrationVoting.Ballot[] memory secondBallot = _singleChoice(second, AMBIRE, 1);

        ballots[0] = first > second ? firstBallot[0] : secondBallot[0];
        ballots[1] = first > second ? secondBallot[0] : firstBallot[0];
        vm.prank(alice);
        vm.expectRevert(GnsIntegrationVoting.BallotsNotSorted.selector);
        voting.cast(ballots);

        ballots[0] = firstBallot[0];
        ballots[1] = firstBallot[0];
        vm.prank(alice);
        vm.expectRevert(GnsIntegrationVoting.BallotsNotSorted.selector);
        voting.cast(ballots);
    }

    function test_RevertNameDoesNotExist() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsIntegrationVoting.NameDoesNotExist.selector, 123));
        voting.cast(_singleChoice(123, AMBIRE, 1));
    }

    function test_RevertNotOwner() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GnsIntegrationVoting.NotNameOwner.selector, tokenId));
        voting.cast(_singleChoice(tokenId, AMBIRE, 1));
    }

    function test_RevertSubdomain() public {
        uint256 parent = _registerName("alice", alice);
        vm.prank(alice);
        uint256 subdomain = nft.registerSubdomain("sub", parent);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(GnsIntegrationVoting.SubdomainNotEligible.selector, subdomain)
        );
        voting.cast(_singleChoice(subdomain, AMBIRE, 1));
    }

    function test_RevertMismatchedAllocations() public {
        uint256 tokenId = _registerName("alice", alice);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = AMBIRE;
        uint16[] memory amounts = new uint16[](0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(GnsIntegrationVoting.AllocationLengthMismatch.selector, tokenId)
        );
        voting.cast(_oneBallot(tokenId, ids, amounts));
    }

    function test_RevertZeroIdOrVotes() public {
        uint256 tokenId = _registerName("alice", alice);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(GnsIntegrationVoting.InvalidIntegrationId.selector, tokenId)
        );
        voting.cast(_singleChoice(tokenId, bytes32(0), 1));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(GnsIntegrationVoting.ZeroVotes.selector, tokenId, AMBIRE)
        );
        voting.cast(_singleChoice(tokenId, AMBIRE, 0));
    }

    function test_RevertAllocationsNotSortedOrDuplicated() public {
        uint256 tokenId = _registerName("a", alice);
        bytes32[] memory sorted = _sortedIds(AMBIRE, SNAPSHOT);
        bytes32[] memory reversed = new bytes32[](2);
        reversed[0] = sorted[1];
        reversed[1] = sorted[0];
        uint16[] memory amounts = new uint16[](2);
        amounts[0] = 1;
        amounts[1] = 1;

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(GnsIntegrationVoting.AllocationsNotSorted.selector, tokenId)
        );
        voting.cast(_oneBallot(tokenId, reversed, amounts));

        reversed[0] = AMBIRE;
        reversed[1] = AMBIRE;
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(GnsIntegrationVoting.AllocationsNotSorted.selector, tokenId)
        );
        voting.cast(_oneBallot(tokenId, reversed, amounts));
    }

    function test_RevertOverAllocationInBatch() public {
        uint256 first = _registerName("alice", alice);
        uint256 second = _registerName("bobbb", alice);
        uint256 lower = first < second ? first : second;
        uint256 higher = first < second ? second : first;
        GnsIntegrationVoting.Ballot[] memory ballots = new GnsIntegrationVoting.Ballot[](2);
        ballots[0] = _singleChoice(lower, AMBIRE, 1)[0];
        ballots[1] = _singleChoice(higher, AMBIRE, 2)[0];

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(GnsIntegrationVoting.TooManyVotes.selector, higher, 2, 1)
        );
        voting.cast(ballots);
    }

    function test_RevertTooManyAllocationsBeforeWalkingTheArray() public {
        uint256 tokenId = _registerName("alice", alice);
        bytes32[] memory ids = _sortedIds(AMBIRE, SNAPSHOT);
        uint16[] memory amounts = new uint16[](2);
        amounts[0] = 1;
        amounts[1] = 1;

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(GnsIntegrationVoting.TooManyAllocations.selector, tokenId, 2, 1)
        );
        voting.cast(_oneBallot(tokenId, ids, amounts));
    }

    function testFuzz_CastHonorsExactVotingPower(uint16 leftSeed, uint16 rightSeed) public {
        uint16 left = uint16(bound(uint256(leftSeed), 1, 1000));
        uint16 right = uint16(bound(uint256(rightSeed), 1, 1000));
        uint256 tokenId = _registerName("a", alice);
        bytes32[] memory ids = _sortedIds(AMBIRE, SNAPSHOT);
        uint16[] memory amounts = new uint16[](2);
        amounts[0] = left;
        amounts[1] = right;
        uint256 allocated = uint256(left) + uint256(right);

        vm.prank(alice);
        if (allocated > 1000) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    GnsIntegrationVoting.TooManyVotes.selector, tokenId, allocated, 1000
                )
            );
        }
        voting.cast(_oneBallot(tokenId, ids, amounts));
    }

    function testGas_OneTransactionForOneHundredNames() public {
        uint256 count = 100;
        uint256[] memory tokenIds = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            tokenIds[i] = _registerName(string.concat("name", vm.toString(i)), alice);
        }
        _sort(tokenIds);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = AMBIRE;
        uint16[] memory amounts = new uint16[](1);
        amounts[0] = 1;
        GnsIntegrationVoting.Ballot[] memory ballots = new GnsIntegrationVoting.Ballot[](count);
        for (uint256 i; i < count; ++i) {
            ballots[i] = GnsIntegrationVoting.Ballot(tokenIds[i], ids, amounts);
        }

        _assertTransactionFitsGasLimit(ballots, "100 names / one allocation execution gas");
    }

    function testGas_OneTransactionForOneHundredNamesAndTwentyFourAllocations() public {
        uint256 count = 100;
        uint256 allocationCount = 24;
        uint256[] memory tokenIds = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            tokenIds[i] = _registerName(_threeByteLabel(i), alice);
        }
        _sort(tokenIds);

        bytes32[] memory ids = new bytes32[](allocationCount);
        uint16[] memory amounts = new uint16[](allocationCount);
        for (uint256 i; i < allocationCount; ++i) {
            ids[i] = bytes32(i + 1);
            amounts[i] = 1;
        }
        GnsIntegrationVoting.Ballot[] memory ballots = new GnsIntegrationVoting.Ballot[](count);
        for (uint256 i; i < count; ++i) {
            ballots[i] = GnsIntegrationVoting.Ballot(tokenIds[i], ids, amounts);
        }

        _assertTransactionFitsGasLimit(ballots, "100 names / 24 allocations execution gas");
    }

    function test_TransferLetsNewOwnerReplaceBallot() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsIntegrationVoting.NotNameOwner.selector, tokenId));
        voting.cast(_singleChoice(tokenId, AMBIRE, 1));

        vm.prank(bob);
        voting.cast(_singleChoice(tokenId, SNAPSHOT, 1));
    }

    function test_ReRegistrationUsesNewEpoch() public {
        uint256 oldTokenId = _registerName("alice", alice);
        uint256 expiry = nft.expiresAt(oldTokenId);
        vm.warp(expiry + GRACE_PERIOD + PREMIUM_DECAY_PERIOD + 1);
        uint256 newTokenId = _registerName("alice", bob);
        assertEq(newTokenId, oldTokenId);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = ZSWAP;
        uint16[] memory amounts = new uint16[](1);
        amounts[0] = 1;
        vm.expectEmit(true, true, true, true);
        emit BallotCast(bob, newTokenId, 2, ids, amounts);
        vm.prank(bob);
        voting.cast(_oneBallot(newTokenId, ids, amounts));
    }

    function _registerName(string memory label, address owner) internal returns (uint256 tokenId) {
        bytes32 secret = keccak256(abi.encode(label, owner, block.timestamp));
        bytes32 commitment = nft.makeCommitment(label, owner, secret);
        vm.prank(owner);
        nft.commit(commitment);
        vm.warp(block.timestamp + MIN_COMMITMENT_AGE + 1);
        uint256 fee = nft.getFee(bytes(label).length);
        vm.prank(owner);
        tokenId = nft.reveal{value: fee}(label, secret);
    }

    function _singleChoice(uint256 tokenId, bytes32 integrationId, uint16 amount)
        internal
        pure
        returns (GnsIntegrationVoting.Ballot[] memory ballots)
    {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = integrationId;
        uint16[] memory amounts = new uint16[](1);
        amounts[0] = amount;
        return _oneBallot(tokenId, ids, amounts);
    }

    function _oneBallot(uint256 tokenId, bytes32[] memory ids, uint16[] memory amounts)
        internal
        pure
        returns (GnsIntegrationVoting.Ballot[] memory ballots)
    {
        ballots = new GnsIntegrationVoting.Ballot[](1);
        ballots[0] = GnsIntegrationVoting.Ballot(tokenId, ids, amounts);
    }

    function _sortedIds(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](2);
        if (a < b) {
            ids[0] = a;
            ids[1] = b;
        } else {
            ids[0] = b;
            ids[1] = a;
        }
    }

    function _assertTransactionFitsGasLimit(
        GnsIntegrationVoting.Ballot[] memory ballots,
        string memory gasLabel
    ) internal {
        bytes memory callData = abi.encodeCall(GnsIntegrationVoting.cast, (ballots));
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        voting.cast(ballots);
        uint256 executionGas = gasBefore - gasleft();
        uint256 conservativeTransactionGas =
            21_000 + executionGas + callData.length * MAX_CALLDATA_GAS_PER_BYTE;

        emit log_named_uint(gasLabel, executionGas);
        emit log_named_uint("conservative transaction gas", conservativeTransactionGas);
        emit log_named_uint("calldata bytes", callData.length);
        assertLt(conservativeTransactionGas, MAX_TX_GAS);
    }

    function _threeByteLabel(uint256 value) internal pure returns (string memory) {
        bytes memory label = new bytes(3);
        label[0] = bytes1(uint8(97 + (value / 676) % 26));
        label[1] = bytes1(uint8(97 + (value / 26) % 26));
        label[2] = bytes1(uint8(97 + value % 26));
        return string(label);
    }

    function _sort(uint256[] memory values) internal pure {
        for (uint256 i = 1; i < values.length; ++i) {
            uint256 value = values[i];
            uint256 j = i;
            while (j != 0 && values[j - 1] > value) {
                values[j] = values[j - 1];
                --j;
            }
            values[j] = value;
        }
    }
}

contract GnsIntegrationVotingMainnetForkTest is Test {
    address internal constant NAME_NFT = 0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6;
    uint256 internal constant FORK_BLOCK = 25_826_228;
    bytes32 internal constant NAME_NFT_CODEHASH =
        0xb0e20c7e72a371b06d4456cc5056ea06ab2366da03f8cf49698a1f956e60b068;

    event BallotCast(
        address indexed voter,
        uint256 indexed tokenId,
        uint64 indexed epoch,
        bytes32[] integrationIds,
        uint16[] votes
    );

    function testFork_CastsAgainstPinnedMainnetNameNft() public {
        vm.createSelectFork(vm.rpcUrl("main3"), FORK_BLOCK);
        assertEq(NAME_NFT.codehash, NAME_NFT_CODEHASH);

        DeployGnsIntegrationVoting deployment = new DeployGnsIntegrationVoting();
        deployment.validateDeploymentTarget();

        NameNFT live = NameNFT(NAME_NFT);
        GnsIntegrationVoting voting = new GnsIntegrationVoting(IGnsVotingNameNFT(NAME_NFT));
        assertEq(voting.baseFee(), 0.0005 ether);
        assertEq(voting.votingPowerForLength(1), 1000);
        assertEq(voting.votingPowerForLength(5), 1);

        uint256 tokenId = live.computeId("donnoh.gwei");
        (string memory label, uint256 parent, uint64 expiresAt, uint64 epoch,) =
            live.records(tokenId);
        address owner = live.ownerOf(tokenId);
        assertEq(label, "donnoh");
        assertEq(parent, 0);
        assertGe(expiresAt, block.timestamp);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256("ambire");
        uint16[] memory amounts = new uint16[](1);
        amounts[0] = 1;
        GnsIntegrationVoting.Ballot[] memory ballots = new GnsIntegrationVoting.Ballot[](1);
        ballots[0] = GnsIntegrationVoting.Ballot(tokenId, ids, amounts);

        vm.expectEmit(true, true, true, true);
        emit BallotCast(owner, tokenId, epoch, ids, amounts);
        vm.prank(owner);
        voting.cast(ballots);
    }
}
