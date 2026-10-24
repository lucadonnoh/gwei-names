// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {GnsPosts, IGnsPostsNameNFT} from "../src/GnsPosts.sol";

contract RejectsEther {
    receive() external payable {
        revert("no");
    }
}

contract GnsPostsTest is Test {
    NameNFT internal nft;
    GnsPosts internal posts;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal publisher = address(0x9B11);

    uint256 internal constant MIN_COMMITMENT_AGE = 60;

    bytes32 internal constant POST = keccak256("post");
    bytes32 internal constant OTHER = keccak256("other");
    bytes32 internal constant BLOB0 = bytes32(uint256(0x01) << 248 | 0xb10b0);
    bytes32 internal constant BLOB1 = bytes32(uint256(0x01) << 248 | 0xb10b1);

    event PostAuthorized(
        uint256 indexed tokenId,
        bytes32 indexed postHash,
        address indexed author,
        address publisher,
        uint256 fee
    );
    event PostPublished(bytes32 indexed postHash, bytes32 indexed blobHash, address indexed publisher);
    event PostRemoved(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author);

    function setUp() public {
        nft = new NameNFT();
        posts = new GnsPosts(IGnsPostsNameNFT(address(nft)));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function test_DeploymentIsBoundAndOwnerless() public view {
        assertEq(address(posts.gns()), address(nft));
        assertEq(address(posts).balance, 0);
    }

    function test_RevertZeroGns() public {
        vm.expectRevert(GnsPosts.InvalidGns.selector);
        new GnsPosts(IGnsPostsNameNFT(address(0)));
    }

    /*//////////////////////////////////////////////////////////////
                               AUTHORIZE
    //////////////////////////////////////////////////////////////*/

    function test_AuthorizeWithoutFee() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostAuthorized(tokenId, POST, alice, address(0), 0);
        vm.prank(alice);
        posts.authorize(tokenId, POST, address(0));
    }

    function test_AuthorizePaysThePublisher() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostAuthorized(tokenId, POST, alice, publisher, 0.001 ether);
        vm.prank(alice);
        posts.authorize{value: 0.001 ether}(tokenId, POST, publisher);
        assertEq(publisher.balance, 0.001 ether);
        assertEq(address(posts).balance, 0);
    }

    function test_RevertFeeWithoutPublisher() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.prank(alice);
        vm.expectRevert(GnsPosts.NoPublisher.selector);
        posts.authorize{value: 1}(tokenId, POST, address(0));
    }

    function test_RevertWhenPublisherRejectsFee() public {
        uint256 tokenId = _registerName("alice", alice);
        address rejects = address(new RejectsEther());
        vm.prank(alice);
        vm.expectRevert(GnsPosts.FeeTransferFailed.selector);
        posts.authorize{value: 1}(tokenId, POST, rejects);
    }

    function test_RevertAuthorizeByNonOwner() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NotNameOwner.selector, tokenId));
        posts.authorize(tokenId, POST, address(0));
    }

    function test_RevertAuthorizeUnregistered() public {
        uint256 tokenId = nft.computeId("nobody.gwei");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.InactiveName.selector, tokenId));
        posts.authorize(tokenId, POST, address(0));
    }

    function test_RevertAuthorizeExpired() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.warp(nft.expiresAt(tokenId) + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.InactiveName.selector, tokenId));
        posts.authorize(tokenId, POST, address(0));
    }

    function test_TransferMovesTheRightToPost() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NotNameOwner.selector, tokenId));
        posts.authorize(tokenId, POST, address(0));

        vm.expectEmit(true, true, true, true, address(posts));
        emit PostAuthorized(tokenId, POST, bob, address(0), 0);
        vm.prank(bob);
        posts.authorize(tokenId, POST, address(0));
    }

    function test_SubdomainOwnerCanPost() public {
        uint256 parentId = _registerName("alice", alice);
        vm.prank(alice);
        uint256 subId = nft.registerSubdomainFor("blog", parentId, bob);

        vm.expectEmit(true, true, true, true, address(posts));
        emit PostAuthorized(subId, POST, bob, address(0), 0);
        vm.prank(bob);
        posts.authorize(subId, POST, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                                PUBLISH
    //////////////////////////////////////////////////////////////*/

    function test_PublishIsOpenToAnyone() public {
        bytes32[] memory blobs = new bytes32[](2);
        blobs[0] = BLOB0;
        blobs[1] = BLOB1;
        vm.blobhashes(blobs);

        bytes32[][] memory hashes = new bytes32[][](2);
        hashes[0] = new bytes32[](2);
        hashes[0][0] = POST;
        hashes[0][1] = OTHER;
        hashes[1] = new bytes32[](1);
        hashes[1][0] = keccak256("third");

        vm.expectEmit(true, true, true, true, address(posts));
        emit PostPublished(POST, BLOB0, publisher);
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostPublished(OTHER, BLOB0, publisher);
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostPublished(keccak256("third"), BLOB1, publisher);
        vm.prank(publisher);
        posts.publish(hashes);
    }

    function test_RevertPublishWithoutBlob() public {
        bytes32[][] memory hashes = new bytes32[][](1);
        hashes[0] = new bytes32[](1);
        hashes[0][0] = POST;
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NoBlob.selector, 0));
        posts.publish(hashes);
    }

    function test_RevertPublishMoreListsThanBlobs() public {
        bytes32[] memory blobs = new bytes32[](1);
        blobs[0] = BLOB0;
        vm.blobhashes(blobs);
        bytes32[][] memory hashes = new bytes32[][](2);
        hashes[0] = new bytes32[](1);
        hashes[0][0] = POST;
        hashes[1] = new bytes32[](1);
        hashes[1][0] = OTHER;
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NoBlob.selector, 1));
        posts.publish(hashes);
    }

    function test_RevertPublishNothing() public {
        bytes32[] memory blobs = new bytes32[](1);
        blobs[0] = BLOB0;
        vm.blobhashes(blobs);

        vm.expectRevert(GnsPosts.NoPosts.selector);
        posts.publish(new bytes32[][](0));

        bytes32[][] memory hashes = new bytes32[][](1);
        hashes[0] = new bytes32[](0);
        vm.expectRevert(GnsPosts.NoPosts.selector);
        posts.publish(hashes);
    }

    /*//////////////////////////////////////////////////////////////
                                 POST
    //////////////////////////////////////////////////////////////*/

    function test_SelfPublishInOneTransaction() public {
        uint256 tokenId = _registerName("alice", alice);
        bytes32[] memory blobs = new bytes32[](2);
        blobs[0] = BLOB0;
        blobs[1] = BLOB1;
        vm.blobhashes(blobs);

        vm.expectEmit(true, true, true, true, address(posts));
        emit PostAuthorized(tokenId, POST, alice, alice, 0);
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostPublished(POST, BLOB1, alice);
        vm.prank(alice);
        posts.post(tokenId, POST, 1);
    }

    function test_RevertSelfPublishWithoutBlob() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NoBlob.selector, 0));
        posts.post(tokenId, POST, 0);
    }

    function test_RevertSelfPublishByNonOwner() public {
        uint256 tokenId = _registerName("alice", alice);
        bytes32[] memory blobs = new bytes32[](1);
        blobs[0] = BLOB0;
        vm.blobhashes(blobs);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NotNameOwner.selector, tokenId));
        posts.post(tokenId, POST, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                REMOVE
    //////////////////////////////////////////////////////////////*/

    function test_RemoveByOwner() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostRemoved(tokenId, POST, alice);
        vm.prank(alice);
        posts.remove(tokenId, POST);
    }

    function test_RemoveStillWorksAfterExpiry() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.warp(nft.expiresAt(tokenId) + 1);
        vm.expectEmit(true, true, true, true, address(posts));
        emit PostRemoved(tokenId, POST, alice);
        vm.prank(alice);
        posts.remove(tokenId, POST);
    }

    function test_RevertRemoveByNonOwner() public {
        uint256 tokenId = _registerName("alice", alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GnsPosts.NotNameOwner.selector, tokenId));
        posts.remove(tokenId, POST);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

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
}
