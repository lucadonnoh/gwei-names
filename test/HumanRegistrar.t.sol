// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/HumanRegistrar.sol";
import "../src/SubdomainRegistrar.sol";
import {NameNFT} from "../src/NameNFT.sol";

// The NameNFT surface these tests touch (commit-reveal + ids + approvals).
interface INameOps {
    function makeCommitment(string calldata label, address owner, bytes32 secret) external pure returns (bytes32);
    function commit(bytes32 commitment) external;
    function reveal(string calldata label, bytes32 secret) external payable returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getFee(uint256 length) external view returns (uint256);
    function getPremium(uint256 tokenId) external view returns (uint256);
    function computeId(string calldata fullName) external pure returns (uint256);
    function setApprovalForAll(address operator, bool approved) external;
}

/// @dev A configurable stand-in for the zkPassport verifier *and* its helper (one contract plays both).
///      It deliberately does NOT inherit the interfaces: its impls are `view` (they read config), while
///      the interfaces declare `verify` nonpayable and the helper fns `pure`. Selectors still match, so
///      HumanRegistrar calls it fine — a `view` fn answers a nonpayable CALL and a `pure` STATICCALL alike.
contract MockZKPassport {
    bool public verifiedRet = true;
    bytes32 public uidRet;
    bool public scopeRet = true;
    address public senderRet;
    uint256 public chainIdRet;

    function set(bool _verified, bytes32 _uid, bool _scope, address _sender, uint256 _chainId) external {
        verifiedRet = _verified;
        uidRet = _uid;
        scopeRet = _scope;
        senderRet = _sender;
        chainIdRet = _chainId;
    }

    function verify(ProofVerificationParams calldata) external view returns (bool, bytes32, address) {
        return (verifiedRet, uidRet, address(this));
    }

    function verifyScopes(bytes32[] calldata, string calldata, string calldata) external view returns (bool) {
        return scopeRet;
    }

    function getBoundData(bytes calldata) external view returns (BoundData memory) {
        return BoundData({senderAddress: senderRet, chainId: chainIdRet, customData: ""});
    }
}

/// @title HumanRegistrar tests — the one-name-per-passport gate for `*.human.gwei`.
/// @notice Self-contained: deploys a fresh NameNFT + SubdomainRegistrar, registers `human.gwei`,
///         points the registrar's gate at the HumanRegistrar, and mocks the zkPassport verifier.
contract HumanRegistrarTest is Test {
    NameNFT nft;
    INameOps name;
    SubdomainRegistrar registrar;
    MockZKPassport mock;
    HumanRegistrar hr;

    address owner; // human.gwei owner + registrar controller
    address alice;
    address bob;

    uint256 humanId; // computeId("human.gwei")

    bytes32 constant UID_A = keccak256("passport-A");
    bytes32 constant UID_B = keccak256("passport-B");

    function setUp() public {
        owner = makeAddr("owner");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        nft = new NameNFT();
        name = INameOps(address(nft));
        registrar = new SubdomainRegistrar(INameNFT(address(nft)));
        mock = new MockZKPassport();

        humanId = name.computeId("human.gwei");
        _registerName("human", owner);

        hr = new HumanRegistrar(
            IZKPassportVerifier(address(mock)), ISubdomainRegistrar(address(registrar)), humanId
        );

        // Owner gates the registrar on the HumanRegistrar: free, flash-mode, minGateBalance 1.
        vm.startPrank(owner);
        name.setApprovalForAll(address(registrar), true);
        registrar.configure(humanId, owner, address(0), 0, true, address(hr), 1);
        vm.stopPrank();
    }

    /* ─────────────────────────── helpers ─────────────────────────── */

    function _registerName(string memory label, address to) internal returns (uint256 id) {
        bytes32 secret = keccak256(abi.encode(label, to));
        vm.prank(to);
        name.commit(name.makeCommitment(label, to, secret));
        vm.warp(block.timestamp + 61);
        id = name.computeId(string.concat(label, ".gwei"));
        uint256 fee = name.getFee(bytes(label).length) + name.getPremium(id);
        vm.deal(to, fee);
        vm.prank(to);
        name.reveal{value: fee}(label, secret);
        assertEq(name.ownerOf(id), to, "parent registration failed");
    }

    // Well-formed but empty proof params; MockZKPassport ignores their contents.
    function _params() internal pure returns (ProofVerificationParams memory p) {}

    function _sub(string memory label) internal view returns (uint256) {
        return name.computeId(string.concat(label, ".human.gwei"));
    }

    /* ───────────────── the fix: one name per passport, forever ───────────────── */

    function test_claim_mints_one_name() public {
        mock.set(true, UID_A, true, alice, block.chainid);
        vm.prank(alice);
        uint256 subId = hr.claim(_params(), "alice");

        assertEq(subId, _sub("alice"), "returns the subId");
        assertEq(name.ownerOf(_sub("alice")), alice, "alice owns alice.human.gwei");
        assertEq(hr.claimedBy(UID_A), alice, "passport recorded to alice");
        assertEq(hr.claimedName(alice), subId, "name recorded for alice");
    }

    function test_same_passport_cannot_claim_twice() public {
        mock.set(true, UID_A, true, alice, block.chainid);
        vm.prank(alice);
        hr.claim(_params(), "alice");

        // Same passport (UID_A) — even a different label is rejected, forever.
        mock.set(true, UID_A, true, alice, block.chainid);
        vm.prank(alice);
        vm.expectRevert(HumanRegistrar.AlreadyClaimed.selector);
        hr.claim(_params(), "alice-two");
    }

    function test_different_passports_each_claim_once() public {
        mock.set(true, UID_A, true, alice, block.chainid);
        vm.prank(alice);
        hr.claim(_params(), "alice");

        mock.set(true, UID_B, true, bob, block.chainid);
        vm.prank(bob);
        hr.claim(_params(), "bob");

        assertEq(name.ownerOf(_sub("alice")), alice);
        assertEq(name.ownerOf(_sub("bob")), bob);
    }

    /* ───────────────── the gate: only the HumanRegistrar can mint ───────────────── */

    function test_balanceOf_is_one_only_for_self() public view {
        assertEq(hr.balanceOf(address(hr)), 1, "the registrar contract passes the gate");
        assertEq(hr.balanceOf(alice), 0, "a human does not");
        assertEq(hr.balanceOf(owner), 0);
    }

    function test_direct_registrar_mint_is_blocked() public {
        // A verified human who already holds their name still can't mint a second one directly.
        mock.set(true, UID_A, true, alice, block.chainid);
        vm.prank(alice);
        hr.claim(_params(), "alice");

        vm.prank(alice);
        vm.expectRevert(SubdomainRegistrar.GateFailed.selector);
        registrar.register(humanId, "alice-two");
    }

    function test_stranger_cannot_mint_directly() public {
        vm.prank(alice);
        vm.expectRevert(SubdomainRegistrar.GateFailed.selector);
        registrar.register(humanId, "eve");
    }

    /* ───────────────── proof binding: verified / scope / sender / chain ───────────────── */

    function test_reverts_when_not_verified() public {
        mock.set(false, UID_A, true, alice, block.chainid);
        vm.prank(alice);
        vm.expectRevert(HumanRegistrar.NotVerified.selector);
        hr.claim(_params(), "alice");
    }

    function test_reverts_on_wrong_scope() public {
        mock.set(true, UID_A, false, alice, block.chainid);
        vm.prank(alice);
        vm.expectRevert(HumanRegistrar.WrongScope.selector);
        hr.claim(_params(), "alice");
    }

    function test_reverts_when_not_bound_to_caller() public {
        mock.set(true, UID_A, true, bob, block.chainid); // proof bound to bob …
        vm.prank(alice); // … but alice submits it
        vm.expectRevert(HumanRegistrar.WrongSender.selector);
        hr.claim(_params(), "alice");
    }

    function test_reverts_on_wrong_chain() public {
        mock.set(true, UID_A, true, alice, block.chainid + 1);
        vm.prank(alice);
        vm.expectRevert(HumanRegistrar.WrongChain.selector);
        hr.claim(_params(), "alice");
    }

    // A reverted claim leaves no residue: the passport (and label) can still be claimed afterward.
    function test_failed_claim_does_not_burn_the_passport() public {
        mock.set(true, UID_A, false, alice, block.chainid); // wrong scope → revert
        vm.prank(alice);
        vm.expectRevert(HumanRegistrar.WrongScope.selector);
        hr.claim(_params(), "alice");

        mock.set(true, UID_A, true, alice, block.chainid); // fix the proof
        vm.prank(alice);
        hr.claim(_params(), "alice");
        assertEq(name.ownerOf(_sub("alice")), alice);
        assertEq(hr.claimedBy(UID_A), alice);
    }
}
