// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "soledge/utils/ReentrancyGuard.sol";

// ── Minimal zkPassport verifier interface (docs.zkpassport.id → "Onchain Verification").
//    The verifier is deployed at the same deterministic address on mainnet, Sepolia and Base. ──
struct ProofVerificationData {
    bytes32 vkeyHash;
    bytes proof;
    bytes32[] publicInputs;
}

struct ServiceConfig {
    uint256 validityPeriodInSeconds;
    string domain;
    string scope;
    bool devMode;
}

struct ProofVerificationParams {
    bytes32 version;
    ProofVerificationData proofVerificationData;
    bytes committedInputs;
    ServiceConfig serviceConfig;
}

struct BoundData {
    address senderAddress;
    uint256 chainId;
    string customData;
}

interface IZKPassportHelper {
    function verifyScopes(bytes32[] calldata publicInputs, string calldata domain, string calldata scope)
        external
        pure
        returns (bool);
    function getBoundData(bytes calldata committedInputs) external pure returns (BoundData memory);
}

interface IZKPassportVerifier {
    function verify(ProofVerificationParams calldata params)
        external
        returns (bool verified, bytes32 uniqueIdentifier, IZKPassportHelper helper);
}

/// @dev The one SubdomainRegistrar entry point we need: mint `label` under `parentId` to `to`,
///      gated on msg.sender's `balanceOf`.
interface ISubdomainRegistrar {
    function registerFor(uint256 parentId, string calldata label, address to)
        external
        payable
        returns (uint256 subId);
}

/// @title  HumanRegistrar
/// @notice Lets each verified human claim exactly one `*.human.gwei` subdomain — one per passport, forever.
/// @dev    A passive `balanceOf` gate can't enforce a per-human *count*: the SubdomainRegistrar's gate
///         (`balanceOf(gateToken, msg.sender) >= minGateBalance`) is a stateless threshold, so an address
///         whose balance is 1 mints unlimited names. This contract fixes that by being the *sole*
///         gate-passer — its `balanceOf` returns 1 only for itself — and minting through the registrar
///         inside `claim`, which records each passport's `uniqueIdentifier` so a document claims once.
contract HumanRegistrar is ReentrancyGuard {
    /// @dev zkPassport verifier (0x1D00…0D8 on mainnet/Sepolia/Base). Immutable so it can be mocked in tests.
    IZKPassportVerifier public immutable verifier;
    /// @dev The gwei SubdomainRegistrar this contract mints through.
    ISubdomainRegistrar public immutable registrar;
    /// @dev tokenId of `human.gwei` (the parent). Its owner points the registrar's gate at this contract.
    uint256 public immutable parentId;

    /// @dev Must match the (domain, scope) the frontend requests the zkPassport proof for.
    string public constant DOMAIN = "gwei.domains";
    string public constant SCOPE = "human.gwei";

    /// @notice The address that claimed a given passport (0 = unclaimed). One document, one name, forever.
    mapping(bytes32 uniqueIdentifier => address human) public claimedBy;
    /// @notice The `*.human.gwei` tokenId a human minted (0 = none).
    mapping(address human => uint256 subId) public claimedName;

    event HumanNameClaimed(
        bytes32 indexed uniqueIdentifier, address indexed human, uint256 indexed subId, string label
    );

    error NotVerified();
    error WrongScope();
    error WrongSender();
    error WrongChain();
    error AlreadyClaimed();

    constructor(IZKPassportVerifier _verifier, ISubdomainRegistrar _registrar, uint256 _parentId) {
        verifier = _verifier;
        registrar = _registrar;
        parentId = _parentId;
    }

    /// @notice Prove humanity with a zkPassport proof bound to `msg.sender`, and mint them `label.human.gwei`.
    /// @dev    Reverts `AlreadyClaimed` if this passport already claimed a name (one per document, forever).
    /// @param  params zkPassport SDK proof (compressed-evm mode), bound to msg.sender + this chain.
    /// @param  label  The subdomain label to mint (`<label>.human.gwei`).
    function claim(ProofVerificationParams calldata params, string calldata label)
        external
        payable
        nonReentrant
        returns (uint256 subId)
    {
        (bool verified, bytes32 uniqueIdentifier, IZKPassportHelper helper) = verifier.verify(params);
        if (!verified) revert NotVerified();

        // The proof must be for this app's (domain, scope) …
        if (!helper.verifyScopes(params.proofVerificationData.publicInputs, DOMAIN, SCOPE)) revert WrongScope();
        // … and bound to the caller, on this chain (no replay by anyone else).
        BoundData memory bound = helper.getBoundData(params.committedInputs);
        if (bound.senderAddress != msg.sender) revert WrongSender();
        if (bound.chainId != block.chainid) revert WrongChain();

        // One passport = one name, forever. Record the claim before the external mint (checks-effects-interactions).
        if (claimedBy[uniqueIdentifier] != address(0)) revert AlreadyClaimed();
        claimedBy[uniqueIdentifier] = msg.sender;

        // Mint through the registrar. registerFor gates on msg.sender (this contract, balanceOf == 1) and
        // mints to `to` (the human). human.gwei is free + flash-mode, so any msg.value just passes through.
        subId = registrar.registerFor{value: msg.value}(parentId, label, msg.sender);
        claimedName[msg.sender] = subId;

        emit HumanNameClaimed(uniqueIdentifier, msg.sender, subId, label);
    }

    /// @notice The balance the SubdomainRegistrar's gate reads. Returns 1 only for this contract, so
    ///         `*.human.gwei` can only be minted via `claim` — never by calling the registrar directly.
    ///         That's what makes the one-per-passport rule enforceable against an immutable registrar.
    function balanceOf(address account) external view returns (uint256) {
        return account == address(this) ? 1 : 0;
    }
}
