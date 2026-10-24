// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {GnsPosts, IGnsPostsNameNFT} from "../src/GnsPosts.sol";

contract RejectsEther {
    receive() external payable {
        revert("no");
    }
}

/// Publishes and, when paid, tries to collect again from inside the payment.
contract ReentrantPublisher {
    GnsPosts internal immutable posts;
    bytes4 internal immutable attack;
    bool public reentered;

    constructor(GnsPosts posts_, bytes4 attack_) {
        posts = posts_;
        attack = attack_;
    }

    function run() external {
        posts.publish();
    }

    receive() external payable {
        if (reentered) return;
        reentered = true;
        (bool ok,) = address(posts).call(abi.encodeWithSelector(attack));
        require(ok, "reentry blocked");
    }
}

/// Pays a fee, then tries to refund twice by re-entering from the refund payment.
contract ReentrantPayer {
    GnsPosts internal immutable posts;
    bytes32 internal blobHash;
    address internal publisher;
    bool internal reentered;

    constructor(GnsPosts posts_) {
        posts = posts_;
    }

    function pay(uint256 tokenId, bytes32 postHash, bytes32 blobHash_, address publisher_) external payable {
        blobHash = blobHash_;
        publisher = publisher_;
        posts.authorize{value: msg.value}(tokenId, postHash, blobHash_, publisher_);
    }

    function claim() external {
        posts.refund(blobHash, publisher);
    }

    receive() external payable {
        if (reentered) return;
        reentered = true;
        posts.refund(blobHash, publisher);
    }
}

abstract contract GnsPostsBase is Test {
    NameNFT internal nft;
    GnsPosts internal posts;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal publisher = makeAddr("publisher");
    address internal rival = makeAddr("rival");

    uint256 internal constant MIN_COMMITMENT_AGE = 60;

    bytes32 internal constant POST = keccak256("post");
    bytes32 internal constant OTHER_POST = keccak256("other post");
    bytes32 internal constant BLOB = bytes32(uint256(0x01) << 248 | 0xb10b);
    bytes32 internal constant BLOB2 = bytes32(uint256(0x01) << 248 | 0xb10b2);
    bytes32 internal constant BLOB3 = bytes32(uint256(0x01) << 248 | 0xb10b3);

    event PostAuthorized(
        uint256 indexed tokenId,
        bytes32 indexed postHash,
        address indexed author,
        bytes32 blobHash,
        address publisher,
        uint256 fee
    );
    event BlobPublished(bytes32 indexed blobHash, address indexed publisher, uint256 paid);
    event FeeRefunded(bytes32 indexed blobHash, address indexed publisher, address indexed payer, uint256 amount);
    event PostRemoved(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author);

    function setUp() public virtual {
        nft = new NameNFT();
        posts = new GnsPosts(IGnsPostsNameNFT(address(nft)));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _registerName(string memory label, address owner) internal returns (uint256 tokenId) {
        // vm.getBlockTimestamp, not block.timestamp: via-IR may reuse a timestamp read across warps.
        bytes32 secret = keccak256(abi.encode(label, owner, vm.getBlockTimestamp()));
        bytes32 commitment = nft.makeCommitment(label, owner, secret);
        vm.prank(owner);
        nft.commit(commitment);
        vm.warp(vm.getBlockTimestamp() + MIN_COMMITMENT_AGE + 1);
        uint256 fee = nft.getFee(bytes(label).length);
        vm.deal(owner, owner.balance + fee);
        vm.prank(owner);
        tokenId = nft.reveal{value: fee}(label, secret);
    }

    function _blobs(bytes32 a) internal pure returns (bytes32[] memory list) {
        list = new bytes32[](1);
        list[0] = a;
    }

    function _blobs(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory list) {
        list = new bytes32[](2);
        list[0] = a;
        list[1] = b;
    }

    function _key(bytes32 blobHash, address who) internal view returns (bytes32) {
        return posts.escrowKey(blobHash, who);
    }

    function _deposit(bytes32 blobHash, address who, address payer) internal view returns (uint128 amount, uint64 at) {
        (amount, at) = posts.deposits(_key(blobHash, who), payer);
    }
}

contract GnsPostsTest is GnsPostsBase {
    uint256 internal aliceName;

    function setUp() public override {
        super.setUp();
        aliceName = _registerName("alice", alice);
    }

    /*//////////////////////////////////////////////////////////////
                               DEPLOYMENT
    //////////////////////////////////////////////////////////////*/

    function test_DeploymentIsBoundAndOwnerless() public view {
        assertEq(address(posts.gns()), address(nft));
        assertEq(posts.REFUND_DELAY(), 1 days);
        assertEq(address(posts).balance, 0);
    }

    function test_RevertZeroGns() public {
        vm.expectRevert(GnsPosts.InvalidGns.selector);
        new GnsPosts(IGnsPostsNameNFT(address(0)));
    }

    function test_RejectsPlainTransfers() public {
        vm.prank(alice);
        (bool ok,) = address(posts).call{value: 1 ether}("");
        assertFalse(ok, "only authorize() can put ETH in escrow");
    }

    /*//////////////////////////////////////////////////////////////
                               AUTHORIZE
    //////////////////////////////////////////////////////////////*/

    function test_AuthorizeWithoutFeeEscrowsNothing() public {
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostAuthorized(aliceName, POST, alice, BLOB, address(0), 0);
        vm.prank(alice);
        posts.authorize(aliceName, POST, BLOB, address(0));
        assertEq(address(posts).balance, 0);
    }

    function test_AuthorizeEscrowsTheFee() public {
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostAuthorized(aliceName, POST, alice, BLOB, publisher, 0.01 ether);
        vm.prank(alice);
        posts.authorize{value: 0.01 ether}(aliceName, POST, BLOB, publisher);

        assertEq(address(posts).balance, 0.01 ether);
        assertEq(publisher.balance, 0, "nothing is paid before delivery");
        assertEq(posts.escrowed(_key(BLOB, publisher)), 0.01 ether);
        (uint128 amount, uint64 at) = _deposit(BLOB, publisher, alice);
        assertEq(amount, 0.01 ether);
        assertEq(at, block.timestamp + 1 days);
    }

    function test_SecondPaymentAddsUpAndRestartsOnlyThatPayersClock() public {
        uint256 bobName = _registerName("bobby", bob);
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, publisher);
        vm.prank(bob);
        posts.authorize{value: 2 ether}(bobName, POST, BLOB, publisher);
        (, uint64 bobAt) = _deposit(BLOB, publisher, bob);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(alice);
        posts.authorize{value: 3 ether}(aliceName, POST, BLOB, publisher);

        (uint128 aliceAmount, uint64 aliceAt) = _deposit(BLOB, publisher, alice);
        (, uint64 bobAtAfter) = _deposit(BLOB, publisher, bob);
        assertEq(aliceAmount, 4 ether);
        assertEq(aliceAt, block.timestamp + 1 days);
        assertEq(bobAtAfter, bobAt, "another payer can't push back someone else's refund");
        assertEq(posts.escrowed(_key(BLOB, publisher)), 6 ether);
    }

    function test_RevertMalformedBlobHash() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.InvalidBlobHash.selector, bytes32(0)));
        posts.authorize(aliceName, POST, bytes32(0), address(0));
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.InvalidBlobHash.selector, POST));
        posts.authorize{value: 1}(aliceName, POST, POST, publisher); // a post hash passed by mistake
        bytes32 version2 = bytes32(uint256(0x02) << 248 | 1);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.InvalidBlobHash.selector, version2));
        posts.authorize(aliceName, POST, version2, address(0));
        vm.stopPrank();
    }

    function test_RevertFeeWithoutPublisher() public {
        vm.prank(alice);
        vm.expectRevert(GnsPosts.NoPublisher.selector);
        posts.authorize{value: 1}(aliceName, POST, BLOB, address(0));
    }

    function test_RevertPayingForABlobAlreadyDelivered() public {
        vm.blobhashes(_blobs(BLOB));
        vm.prank(publisher);
        posts.publish();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.AlreadyDelivered.selector, BLOB, publisher));
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, publisher);
        // Authorizing without a fee is still fine: the post is already in that blob.
        vm.prank(alice);
        posts.authorize(aliceName, POST, BLOB, publisher);
    }

    function test_RevertAuthorizeByNonOwner() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NotNameOwner.selector, aliceName));
        posts.authorize{value: 1}(aliceName, POST, BLOB, publisher);
    }

    function test_RevertAuthorizeUnregisteredOrExpired() public {
        uint256 nobody = nft.computeId("nobody.gwei");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.InactiveName.selector, nobody));
        posts.authorize(nobody, POST, BLOB, address(0));

        vm.warp(nft.expiresAt(aliceName) + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.InactiveName.selector, aliceName));
        posts.authorize(aliceName, POST, BLOB, address(0));
    }

    function test_TransferMovesTheRightToPostButNotTheDeposit() public {
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, publisher);
        vm.prank(alice);
        nft.transferFrom(alice, bob, aliceName);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NotNameOwner.selector, aliceName));
        posts.authorize(aliceName, POST, BLOB2, address(0));

        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        vm.expectRevert(GnsPosts.NothingToRefund.selector);
        posts.refund(BLOB, publisher);
        uint256 before = alice.balance;
        vm.prank(alice);
        posts.refund(BLOB, publisher);
        assertEq(alice.balance, before + 1 ether, "the payer keeps the right to their refund");
    }

    function test_SubdomainOwnerCanPost() public {
        vm.prank(alice);
        uint256 subId = nft.registerSubdomainFor("blog", aliceName, bob);
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostAuthorized(subId, POST, bob, BLOB, address(0), 0);
        vm.prank(bob);
        posts.authorize(subId, POST, BLOB, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                PUBLISH
    //////////////////////////////////////////////////////////////*/

    function test_PublishingTheExactBlobPaysTheNamedPublisher() public {
        vm.prank(alice);
        posts.authorize{value: 0.01 ether}(aliceName, POST, BLOB, publisher);
        vm.blobhashes(_blobs(BLOB));

        vm.expectEmit(true, true, true, true, address(posts));
        emit BlobPublished(BLOB, publisher, 0.01 ether);
        vm.prank(publisher);
        posts.publish();

        assertEq(publisher.balance, 0.01 ether);
        assertEq(address(posts).balance, 0);
        assertTrue(posts.delivered(_key(BLOB, publisher)));
        assertEq(posts.escrowed(_key(BLOB, publisher)), 0);
    }

    function test_AnyOtherBlobPaysNothing() public {
        vm.prank(alice);
        posts.authorize{value: 0.01 ether}(aliceName, POST, BLOB, publisher);
        vm.blobhashes(_blobs(BLOB2)); // close, but not the blob alice named
        vm.prank(publisher);
        posts.publish();
        assertEq(publisher.balance, 0);
        assertEq(posts.escrowed(_key(BLOB, publisher)), 0.01 ether);
        assertFalse(posts.delivered(_key(BLOB, publisher)));
    }

    function test_SomeoneElseDeliveringTheBlobDoesntTouchTheEscrow() public {
        vm.prank(alice);
        posts.authorize{value: 0.01 ether}(aliceName, POST, BLOB, publisher);
        vm.blobhashes(_blobs(BLOB));
        vm.prank(rival);
        posts.publish();
        assertEq(rival.balance, 0, "only the named publisher can collect");
        assertEq(posts.escrowed(_key(BLOB, publisher)), 0.01 ether);

        vm.prank(publisher);
        posts.publish();
        assertEq(publisher.balance, 0.01 ether);
    }

    function test_OneTransactionCanDeliverSeveralBlobs() public {
        uint256 bobName = _registerName("bobby", bob);
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, publisher);
        vm.prank(bob);
        posts.authorize{value: 2 ether}(bobName, OTHER_POST, BLOB2, publisher);
        vm.prank(bob);
        posts.authorize{value: 4 ether}(bobName, OTHER_POST, BLOB3, rival); // another publisher's job

        bytes32[] memory blobs = new bytes32[](3);
        blobs[0] = BLOB;
        blobs[1] = BLOB3;
        blobs[2] = BLOB2;
        vm.blobhashes(blobs);
        vm.prank(publisher);
        posts.publish();

        assertEq(publisher.balance, 3 ether);
        assertEq(posts.escrowed(_key(BLOB3, rival)), 4 ether);
        assertEq(address(posts).balance, 4 ether);
    }

    function test_DeliveringTwicePaysOnce() public {
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, publisher);
        vm.blobhashes(_blobs(BLOB, BLOB)); // the same blob twice in one transaction
        vm.prank(publisher);
        posts.publish();
        assertEq(publisher.balance, 1 ether);
        vm.prank(publisher);
        posts.publish();
        assertEq(publisher.balance, 1 ether);
    }

    function test_RevertPublishWithoutBlob() public {
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NoBlob.selector, 0));
        posts.publish();
    }

    function test_RevertWhenThePublisherRejectsPayment() public {
        address rejects = address(new RejectsEther());
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, rejects);
        vm.blobhashes(_blobs(BLOB));
        vm.prank(rejects);
        vm.expectRevert(GnsPosts.TransferFailed.selector);
        posts.publish();
        assertFalse(posts.delivered(_key(BLOB, rejects)), "nothing changed");
        assertEq(posts.escrowed(_key(BLOB, rejects)), 1 ether);
    }

    function test_ReentrantPublisherCantCollectTwice() public {
        ReentrantPublisher attacker = new ReentrantPublisher(posts, GnsPosts.publish.selector);
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, address(attacker));
        vm.blobhashes(_blobs(BLOB));
        vm.expectRevert(GnsPosts.TransferFailed.selector); // its re-entry is refused, so its payment fails
        attacker.run();
        assertEq(address(posts).balance, 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                  POST
    //////////////////////////////////////////////////////////////*/

    function test_SelfPublishInOneTransaction() public {
        vm.blobhashes(_blobs(BLOB2, BLOB));
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostAuthorized(aliceName, POST, alice, BLOB, alice, 0);
        vm.expectEmit(true, true, true, true, address(posts));
        emit BlobPublished(BLOB, alice, 0);
        vm.prank(alice);
        posts.post(aliceName, POST, 1);
        assertTrue(posts.delivered(_key(BLOB, alice)));
    }

    function test_RevertSelfPublishWithoutBlobOrByNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NoBlob.selector, 0));
        posts.post(aliceName, POST, 0);

        vm.blobhashes(_blobs(BLOB));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NotNameOwner.selector, aliceName));
        posts.post(aliceName, POST, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                 REFUND
    //////////////////////////////////////////////////////////////*/

    function test_RefundAfterTheDelay() public {
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, publisher);

        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.RefundNotDue.selector, block.timestamp + 1));
        posts.refund(BLOB, publisher);

        vm.warp(block.timestamp + 1);
        uint256 before = alice.balance;
        vm.expectEmit(true, true, true, true, address(posts));
        emit FeeRefunded(BLOB, publisher, alice, 1 ether);
        vm.prank(alice);
        posts.refund(BLOB, publisher);
        assertEq(alice.balance, before + 1 ether);
        assertEq(posts.escrowed(_key(BLOB, publisher)), 0);

        vm.prank(alice);
        vm.expectRevert(GnsPosts.NothingToRefund.selector);
        posts.refund(BLOB, publisher);
    }

    function test_NoRefundOnceDelivered() public {
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, publisher);
        vm.warp(block.timestamp + 2 days);
        vm.blobhashes(_blobs(BLOB));
        vm.prank(publisher);
        posts.publish(); // late, but before any refund: still paid
        assertEq(publisher.balance, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.AlreadyDelivered.selector, BLOB, publisher));
        posts.refund(BLOB, publisher);
    }

    function test_ARefundOnlyTakesThePayersShare() public {
        uint256 bobName = _registerName("bobby", bob);
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, publisher);
        vm.prank(bob);
        posts.authorize{value: 2 ether}(bobName, POST, BLOB, publisher);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        posts.refund(BLOB, publisher);
        assertEq(posts.escrowed(_key(BLOB, publisher)), 2 ether);

        vm.blobhashes(_blobs(BLOB));
        vm.prank(publisher);
        posts.publish();
        assertEq(publisher.balance, 2 ether, "a delivery after one refund collects what's left");
        assertEq(address(posts).balance, 0);
    }

    function test_ReentrantPayerCantRefundTwice() public {
        ReentrantPayer payer = new ReentrantPayer(posts);
        vm.prank(alice);
        nft.transferFrom(alice, address(payer), aliceName);
        vm.deal(address(this), 1 ether);
        payer.pay{value: 1 ether}(aliceName, POST, BLOB, publisher);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(GnsPosts.TransferFailed.selector);
        payer.claim();
        assertEq(address(posts).balance, 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                 REMOVE
    //////////////////////////////////////////////////////////////*/

    function test_RemoveByOwnerEvenAfterExpiry() public {
        vm.warp(nft.expiresAt(aliceName) + 1);
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostRemoved(aliceName, POST, alice);
        vm.prank(alice);
        posts.remove(aliceName, POST);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NotNameOwner.selector, aliceName));
        posts.remove(aliceName, POST);
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_EscrowPaysExactlyWhatWasPaid(uint96 a, uint96 b, uint8 refundSeed) public {
        uint256 bobName = _registerName("bobby", bob);
        vm.deal(alice, uint256(a) + 1);
        vm.deal(bob, uint256(b) + 1);
        vm.prank(alice);
        posts.authorize{value: a}(aliceName, POST, BLOB, publisher);
        vm.prank(bob);
        posts.authorize{value: b}(bobName, POST, BLOB, publisher);
        assertEq(address(posts).balance, uint256(a) + b);

        uint256 expected = uint256(a) + b;
        if (refundSeed % 2 == 1 && a != 0) {
            vm.warp(block.timestamp + 1 days);
            vm.prank(alice);
            posts.refund(BLOB, publisher);
            expected -= a;
            assertEq(alice.balance, uint256(a) + 1);
        }
        vm.blobhashes(_blobs(BLOB));
        vm.prank(publisher);
        posts.publish();
        assertEq(publisher.balance, expected);
        assertEq(address(posts).balance, 0);
    }

    function testFuzz_RefundTiming(uint32 wait) public {
        vm.prank(alice);
        posts.authorize{value: 1 ether}(aliceName, POST, BLOB, publisher);
        vm.warp(block.timestamp + wait);
        vm.prank(alice);
        if (wait < 1 days) {
            vm.expectRevert();
            posts.refund(BLOB, publisher);
        } else {
            posts.refund(BLOB, publisher);
            assertEq(address(posts).balance, 0);
        }
    }

    function testFuzz_OnlyVersionOneBlobHashes(bytes32 blobHash) public {
        vm.prank(alice);
        if (bytes1(blobHash) != 0x01) vm.expectRevert(abi.encodeWithSelector(GnsPosts.InvalidBlobHash.selector, blobHash));
        posts.authorize(aliceName, POST, blobHash, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                  GAS
    //////////////////////////////////////////////////////////////*/

    /// The publisher's cost model (posts/poster) comes from the real transactions on anvil; this
    /// guards against the contract growing more expensive per blob.
    function test_GasPerDeliveredBlob() public {
        bytes32[] memory blobs = new bytes32[](6);
        for (uint256 i; i < 6; ++i) {
            blobs[i] = bytes32(uint256(0x01) << 248 | (0xb0 + i));
            vm.prank(alice);
            posts.authorize{value: 0.001 ether}(aliceName, POST, blobs[i], publisher);
        }
        vm.blobhashes(blobs);
        vm.prank(publisher);
        uint256 start = gasleft();
        posts.publish();
        uint256 used = start - gasleft();
        assertLt(used, 6 * 32_000 + 20_000, "about 30k gas per paid blob");
        assertEq(publisher.balance, 0.006 ether);
    }
}

/// Random sequences of payments, deliveries, refunds and time: escrow always adds up.
contract GnsPostsHandler is Test {
    GnsPosts internal immutable posts;
    uint256[] internal names;
    address[] internal payers;
    address[] internal publishers;
    bytes32[] internal blobs;

    uint256 public deposited;
    uint256 public paidOut;
    uint256 public refunded;
    mapping(address => uint256) public paidTo;
    mapping(address => uint256) public owedTo; // deposits naming each publisher

    constructor(GnsPosts posts_, uint256[] memory names_, address[] memory payers_, address[] memory publishers_) {
        posts = posts_;
        names = names_;
        payers = payers_;
        publishers = publishers_;
        for (uint256 i; i < 4; ++i) blobs.push(bytes32(uint256(0x01) << 248 | (0xc0 + i)));
    }

    function publisherCount() external view returns (uint256) {
        return publishers.length;
    }

    function publisherAt(uint256 i) external view returns (address) {
        return publishers[i];
    }

    function blobAt(uint256 i) external view returns (bytes32) {
        return blobs[i];
    }

    function authorize(uint256 who, uint256 blob, uint256 pub, uint96 fee) external {
        who = bound(who, 0, payers.length - 1);
        bytes32 blobHash = blobs[bound(blob, 0, blobs.length - 1)];
        address publisher = publishers[bound(pub, 0, publishers.length - 1)];
        fee = uint96(bound(fee, 1, 10 ether));
        if (posts.delivered(posts.escrowKey(blobHash, publisher))) return;
        vm.deal(payers[who], payers[who].balance + fee);
        vm.prank(payers[who]);
        posts.authorize{value: fee}(names[who], keccak256(abi.encode(blobHash)), blobHash, publisher);
        deposited += fee;
        owedTo[publisher] += fee;
    }

    function publish(uint256 pub, uint256 first, uint256 count) external {
        address publisher = publishers[bound(pub, 0, publishers.length - 1)];
        count = bound(count, 1, 3);
        bytes32[] memory attached = new bytes32[](count);
        for (uint256 i; i < count; ++i) attached[i] = blobs[(first + i) % blobs.length];
        vm.blobhashes(attached);
        uint256 before = publisher.balance;
        vm.prank(publisher);
        posts.publish();
        uint256 got = publisher.balance - before;
        paidOut += got;
        paidTo[publisher] += got;
    }

    function refund(uint256 who, uint256 blob, uint256 pub) external {
        who = bound(who, 0, payers.length - 1);
        bytes32 blobHash = blobs[bound(blob, 0, blobs.length - 1)];
        address publisher = publishers[bound(pub, 0, publishers.length - 1)];
        bytes32 key = posts.escrowKey(blobHash, publisher);
        (uint128 amount, uint64 at) = posts.deposits(key, payers[who]);
        if (amount == 0 || posts.delivered(key) || vm.getBlockTimestamp() < at) return;
        uint256 before = payers[who].balance;
        vm.prank(payers[who]);
        posts.refund(blobHash, publisher);
        assertEq(payers[who].balance - before, amount);
        refunded += amount;
        owedTo[publisher] -= amount;
    }

    function wait(uint32 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1, 2 days));
    }
}

contract GnsPostsInvariantTest is StdInvariant, GnsPostsBase {
    GnsPostsHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[] memory payers = new address[](3);
        uint256[] memory names = new uint256[](3);
        string[3] memory labels = ["alice", "bobby", "carol"];
        payers[0] = alice;
        payers[1] = bob;
        payers[2] = makeAddr("carol");
        for (uint256 i; i < 3; ++i) names[i] = _registerName(labels[i], payers[i]);
        address[] memory publishers = new address[](2);
        publishers[0] = publisher;
        publishers[1] = rival;
        handler = new GnsPostsHandler(posts, names, payers, publishers);
        targetContract(address(handler));
    }

    function invariant_EveryWeiIsInEscrowPaidOrRefunded() public view {
        assertEq(address(posts).balance + handler.paidOut() + handler.refunded(), handler.deposited());
    }

    function invariant_EscrowMatchesTheBalance() public view {
        uint256 sum;
        for (uint256 p; p < handler.publisherCount(); ++p) {
            for (uint256 b; b < 4; ++b) {
                bytes32 key = posts.escrowKey(handler.blobAt(b), handler.publisherAt(p));
                uint256 held = posts.escrowed(key);
                if (posts.delivered(key)) assertEq(held, 0, "a delivered blob holds nothing");
                sum += held;
            }
        }
        assertEq(sum, address(posts).balance);
    }

    function invariant_APublisherIsPaidOnlyWhatWasPutUpForIt() public view {
        for (uint256 p; p < handler.publisherCount(); ++p) {
            address who = handler.publisherAt(p);
            assertLe(handler.paidTo(who), handler.owedTo(who));
        }
    }
}

/// Against the real NameNFT and a real name on mainnet. Run with FORK_TESTS=true.
contract GnsPostsForkTest is Test {
    address internal constant NAME_NFT = 0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6;

    function test_Fork_AuthorizeAndDeliverForARealName() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("main3");
        GnsPosts posts = new GnsPosts(IGnsPostsNameNFT(NAME_NFT));
        uint256 tokenId = NameNFT(NAME_NFT).computeId("donnoh.gwei");
        address owner = NameNFT(NAME_NFT).ownerOf(tokenId);
        address publisher = makeAddr("publisher");
        bytes32 blob = bytes32(uint256(0x01) << 248 | 0xf0);
        vm.deal(owner, 1 ether);

        vm.prank(owner);
        posts.authorize{value: 0.001 ether}(tokenId, keccak256("real post"), blob, publisher);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NotNameOwner.selector, tokenId));
        posts.authorize(tokenId, keccak256("not yours"), blob, address(0));

        bytes32[] memory blobs = new bytes32[](1);
        blobs[0] = blob;
        vm.blobhashes(blobs);
        vm.prank(publisher);
        posts.publish();
        assertEq(publisher.balance, 0.001 ether);
    }
}
