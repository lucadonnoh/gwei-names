// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {GnsUniversalResolver, INameNFT} from "../src/GnsUniversalResolver.sol";

/// @dev Read surface of the live mainnet NameNFT used by the fork tests.
interface INameNFTView {
    function computeId(string calldata fullName) external pure returns (uint256);
    function addr(bytes32 node) external view returns (address);
    function reverseResolve(address addr) external view returns (string memory);
}

/// @title GnsUniversalResolver Unit Tests
/// @notice Exercises the universal resolver adapter against a fresh NameNFT with the exact
///         call shapes viem's `getEnsAddress` / `getEnsName` / `getEnsAvatar` /
///         `getEnsResolver` produce: `resolveWithGateways(dnsName, profileCall, gateways)`,
///         `reverseWithGateways(addressBytes, coinType, gateways)`, and `findResolver(dnsName)`.
contract GnsUniversalResolverTest is Test {
    NameNFT nft;
    GnsUniversalResolver ur;

    address alice;
    address bob;

    uint256 aliceId;
    bytes32 aliceNode;

    // viem always passes its local batch gateway; the resolver must ignore it.
    string[] gateways;

    function setUp() public {
        nft = new NameNFT();
        ur = new GnsUniversalResolver(INameNFT(address(nft)));

        alice = makeAddr("alice");
        bob = makeAddr("bob");

        gateways.push("x-batch-gateway:true");

        aliceId = _register("alice", alice);
        aliceNode = bytes32(aliceId);
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Registers `label`.gwei for `to` via commit-reveal and returns the token id.
    ///      `reveal` binds the commitment to msg.sender, so both steps run as `to`.
    function _register(string memory label, address to) internal returns (uint256 tokenId) {
        bytes32 secret = keccak256(abi.encodePacked("secret", label));
        vm.prank(to);
        nft.commit(nft.makeCommitment(label, to, secret));
        vm.warp(block.timestamp + 61);
        uint256 fee = nft.getFee(bytes(label).length);
        vm.deal(to, to.balance + fee);
        vm.prank(to);
        tokenId = nft.reveal{value: fee}(label, secret);
    }

    /// @dev DNS-encodes `label`.gwei the way viem's packetToBytes does.
    function _dns(string memory label) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes1(uint8(bytes(label).length)), label, bytes1(0x04), "gwei", bytes1(0)
        );
    }

    /*//////////////////////////////////////////////////////////////
                            FORWARD RESOLUTION
    //////////////////////////////////////////////////////////////*/

    function test_Resolve_Addr_FallsBackToOwner() public view {
        // viem getEnsAddress (no coinType): addr(bytes32)
        bytes memory data = abi.encodeWithSignature("addr(bytes32)", aliceNode);
        (bytes memory result, address resolver) = ur.resolveWithGateways(_dns("alice"), data, gateways);

        assertEq(abi.decode(result, (address)), alice, "fresh name resolves to owner");
        assertEq(resolver, address(nft), "resolver is NameNFT");
    }

    function test_Resolve_Addr_ExplicitAddress() public {
        vm.prank(alice);
        nft.setAddr(aliceId, bob);

        bytes memory data = abi.encodeWithSignature("addr(bytes32)", aliceNode);
        (bytes memory result,) = ur.resolveWithGateways(_dns("alice"), data, gateways);

        assertEq(abi.decode(result, (address)), bob, "explicit address wins over owner");
    }

    function test_Resolve_Addr_Multicoin() public view {
        // viem getEnsAddress with coinType: addr(bytes32,uint256)
        bytes memory data = abi.encodeWithSignature("addr(bytes32,uint256)", aliceNode, uint256(60));
        (bytes memory result,) = ur.resolveWithGateways(_dns("alice"), data, gateways);

        assertEq(abi.decode(result, (bytes)), abi.encodePacked(alice), "ETH coin type falls back to resolve()");
    }

    function test_Resolve_Text_AvatarRecord() public {
        // viem getEnsAvatar: text(bytes32,"avatar") through the universal resolver
        vm.prank(alice);
        nft.setText(aliceId, "avatar", "ipfs://QmAvatar");

        bytes memory data = abi.encodeWithSignature("text(bytes32,string)", aliceNode, "avatar");
        (bytes memory result,) = ur.resolveWithGateways(_dns("alice"), data, gateways);

        assertEq(abi.decode(result, (string)), "ipfs://QmAvatar");
    }

    function test_Resolve_Contenthash() public {
        bytes memory hash = hex"e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f";
        vm.prank(alice);
        nft.setContenthash(aliceId, hash);

        bytes memory data = abi.encodeWithSignature("contenthash(bytes32)", aliceNode);
        (bytes memory result,) = ur.resolveWithGateways(_dns("alice"), data, gateways);

        assertEq(abi.decode(result, (bytes)), hash);
    }

    function test_Resolve_Subdomain() public {
        vm.prank(alice);
        uint256 subId = nft.registerSubdomainFor("pay", aliceId, bob);

        bytes memory data = abi.encodeWithSignature("addr(bytes32)", bytes32(subId));
        bytes memory dnsName = abi.encodePacked(
            bytes1(0x03), "pay", bytes1(0x05), "alice", bytes1(0x04), "gwei", bytes1(0)
        );
        (bytes memory result,) = ur.resolveWithGateways(dnsName, data, gateways);

        assertEq(abi.decode(result, (address)), bob);
    }

    function test_Resolve_UnregisteredName_ReturnsZero() public view {
        bytes32 ghostNode = bytes32(nft.computeId("ghost.gwei"));
        bytes memory data = abi.encodeWithSignature("addr(bytes32)", ghostNode);
        (bytes memory result,) = ur.resolveWithGateways(_dns("ghost"), data, gateways);

        assertEq(abi.decode(result, (address)), address(0), "unregistered name yields zero, not a revert");
    }

    function test_Resolve_ExpiredName_ReturnsZero() public {
        vm.warp(block.timestamp + 366 days);

        bytes memory data = abi.encodeWithSignature("addr(bytes32)", aliceNode);
        (bytes memory result,) = ur.resolveWithGateways(_dns("alice"), data, gateways);

        assertEq(abi.decode(result, (address)), address(0), "expired name yields zero, not a revert");
    }

    function test_Resolve_PlainResolveAlias() public view {
        // ENSIP-10 resolve(bytes,bytes), the non-gateway entry point
        bytes memory data = abi.encodeWithSignature("addr(bytes32)", aliceNode);
        (bytes memory result, address resolver) = ur.resolve(_dns("alice"), data);

        assertEq(abi.decode(result, (address)), alice);
        assertEq(resolver, address(nft));
    }

    function test_Resolve_UnknownProfile_RevertsResolverError() public {
        // A profile NameNFT doesn't implement, e.g. name(bytes32)
        bytes memory data = abi.encodeWithSignature("name(bytes32)", aliceNode);

        vm.expectRevert(abi.encodeWithSelector(GnsUniversalResolver.ResolverError.selector, bytes("")));
        ur.resolveWithGateways(_dns("alice"), data, gateways);
    }

    function test_Resolve_WriteCall_RevertsResolverError() public {
        // State-changing calldata cannot slip through the staticcall (and NameNFT's own
        // auth check fires first: the caller would be the resolver, not the owner).
        bytes memory data =
            abi.encodeWithSignature("setText(uint256,string,string)", aliceId, "avatar", "x");

        vm.expectRevert(
            abi.encodeWithSelector(
                GnsUniversalResolver.ResolverError.selector,
                abi.encodeWithSelector(NameNFT.Unauthorized.selector)
            )
        );
        ur.resolveWithGateways(_dns("alice"), data, gateways);
    }

    /*//////////////////////////////////////////////////////////////
                            REVERSE RESOLUTION
    //////////////////////////////////////////////////////////////*/

    function test_Reverse_PrimaryName() public {
        vm.prank(alice);
        nft.setPrimaryName(aliceId);

        (string memory name, address resolver, address reverseResolver) =
            ur.reverseWithGateways(abi.encodePacked(alice), 60, gateways);

        assertEq(name, "alice.gwei");
        assertEq(resolver, address(nft));
        assertEq(reverseResolver, address(nft));
    }

    function test_Reverse_SubdomainPrimaryName() public {
        vm.prank(alice);
        uint256 subId = nft.registerSubdomainFor("pay", aliceId, bob);
        vm.prank(bob);
        nft.setPrimaryName(subId);

        (string memory name,,) = ur.reverseWithGateways(abi.encodePacked(bob), 60, gateways);

        assertEq(name, "pay.alice.gwei");
    }

    function test_Reverse_NoPrimaryName_ReturnsEmpty() public view {
        (string memory name, address resolver, address reverseResolver) =
            ur.reverseWithGateways(abi.encodePacked(bob), 60, gateways);

        assertEq(name, "");
        assertEq(resolver, address(0));
        assertEq(reverseResolver, address(0));
    }

    function test_Reverse_ExpiredName_ReturnsEmpty() public {
        vm.prank(alice);
        nft.setPrimaryName(aliceId);
        vm.warp(block.timestamp + 366 days);

        (string memory name,,) = ur.reverseWithGateways(abi.encodePacked(alice), 60, gateways);

        assertEq(name, "", "expired primary name is not returned");
    }

    function test_Reverse_ForwardMismatch_ReturnsEmpty() public {
        // alice sets her primary name, then the token moves to bob: the name now resolves
        // to bob (owner fallback), so it must no longer be reported as alice's identity.
        vm.prank(alice);
        nft.setPrimaryName(aliceId);
        vm.prank(alice);
        nft.transferFrom(alice, bob, aliceId);

        (string memory name,,) = ur.reverseWithGateways(abi.encodePacked(alice), 60, gateways);

        assertEq(name, "", "forward-check strips stale reverse records");
    }

    function test_Reverse_WrongCoinType_ReturnsEmpty() public {
        vm.prank(alice);
        nft.setPrimaryName(aliceId);

        (string memory name,,) = ur.reverseWithGateways(abi.encodePacked(alice), 0, gateways);

        assertEq(name, "", "only ETH (60) is supported");
    }

    function test_Reverse_BadAddressLength_ReturnsEmpty() public view {
        (string memory name,,) = ur.reverseWithGateways(hex"0102", 60, gateways);
        assertEq(name, "");

        (name,,) = ur.reverseWithGateways(abi.encodePacked(alice, alice), 60, gateways);
        assertEq(name, "");
    }

    function test_Reverse_PlainReverseAlias() public {
        vm.prank(alice);
        nft.setPrimaryName(aliceId);

        (string memory name,,) = ur.reverse(abi.encodePacked(alice), 60);

        assertEq(name, "alice.gwei");
    }

    /*//////////////////////////////////////////////////////////////
                                 DISCOVERY
    //////////////////////////////////////////////////////////////*/

    function test_FindResolver() public view {
        (address resolver, bytes32 node, uint256 offset) = ur.findResolver(_dns("alice"));

        assertEq(resolver, address(nft));
        assertEq(node, bytes32(nft.computeId("alice.gwei")), "namehash from DNS wire format");
        assertEq(offset, 0);
    }

    function test_FindResolver_Subdomain() public view {
        bytes memory dnsName = abi.encodePacked(
            bytes1(0x03), "pay", bytes1(0x05), "alice", bytes1(0x04), "gwei", bytes1(0)
        );
        (, bytes32 node,) = ur.findResolver(dnsName);

        assertEq(node, bytes32(nft.computeId("pay.alice.gwei")));
    }

    function test_FindResolver_RootName() public view {
        (, bytes32 node,) = ur.findResolver(hex"00");
        assertEq(node, bytes32(0), "lone terminator is the root node");
    }

    function test_FindResolver_MalformedDns_Reverts() public {
        // Empty
        vm.expectRevert(abi.encodeWithSelector(GnsUniversalResolver.DNSDecodingFailed.selector, bytes("")));
        ur.findResolver("");

        // Missing terminator
        bytes memory noTerminator = abi.encodePacked(bytes1(0x04), "gwei");
        vm.expectRevert(abi.encodeWithSelector(GnsUniversalResolver.DNSDecodingFailed.selector, noTerminator));
        ur.findResolver(noTerminator);

        // Label length pointing past the end
        bytes memory truncated = abi.encodePacked(bytes1(0xFF), "alice", bytes1(0));
        vm.expectRevert(abi.encodeWithSelector(GnsUniversalResolver.DNSDecodingFailed.selector, truncated));
        ur.findResolver(truncated);

        // Garbage after the terminator
        bytes memory trailing = abi.encodePacked(bytes1(0x04), "gwei", bytes1(0), bytes1(0x01));
        vm.expectRevert(abi.encodeWithSelector(GnsUniversalResolver.DNSDecodingFailed.selector, trailing));
        ur.findResolver(trailing);
    }
}

/// @title GnsUniversalResolver Mainnet Fork Tests
/// @notice Points a freshly deployed adapter at the live NameNFT on Ethereum mainnet and
///         checks that answers through the adapter match direct NameNFT reads.
contract GnsUniversalResolverMainnetForkTest is Test {
    address constant NAME_NFT = 0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6;

    INameNFTView nft = INameNFTView(NAME_NFT);
    GnsUniversalResolver ur;

    string[] gateways;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("main3"));
        ur = new GnsUniversalResolver(INameNFT(NAME_NFT));
        gateways.push("x-batch-gateway:true");
    }

    function test_Fork_ForwardMatchesDirectRead() public view {
        bytes32 node = bytes32(nft.computeId("gns.gwei"));
        bytes memory data = abi.encodeWithSignature("addr(bytes32)", node);

        bytes memory dnsName = abi.encodePacked(bytes1(0x03), "gns", bytes1(0x04), "gwei", bytes1(0));
        (bytes memory result, address resolver) = ur.resolveWithGateways(dnsName, data, gateways);

        address viaResolver = abi.decode(result, (address));
        assertEq(viaResolver, nft.addr(node), "adapter answer matches direct read");
        assertTrue(viaResolver != address(0), "gns.gwei is registered and active");
        assertEq(resolver, NAME_NFT);
    }

    function test_Fork_ReverseMatchesDirectRead() public view {
        address holder = nft.addr(bytes32(nft.computeId("gns.gwei")));

        (string memory name,,) = ur.reverseWithGateways(abi.encodePacked(holder), 60, gateways);

        assertEq(name, nft.reverseResolve(holder), "adapter answer matches direct read");
    }
}
