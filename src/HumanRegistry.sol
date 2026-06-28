// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// ── Minimal zkPassport verifier interface (see docs.zkpassport.id → "Onchain Verification") ──
// The verifier is deployed at the same deterministic address on Ethereum mainnet, Sepolia and Base.
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

/// @title  HumanRegistry
/// @notice A proof-of-humanity registry backed by zkPassport. A user submits a passport/ID proof
///         bound to their address; on success they're marked human and `balanceOf` returns 1 — so
///         this contract can be used directly as the SubdomainRegistrar's `gateToken`, restricting
///         subdomain minting (e.g. `*.human.gwei`) to verified humans.
/// @dev    The unique identifier zkPassport returns is one per document, scoped to this app's
///         (domain, scope). Recording it means a single passport can make exactly one address human.
contract HumanRegistry {
    /// @dev zkPassport verifier — same address on Ethereum mainnet, Sepolia, and Base.
    IZKPassportVerifier public constant VERIFIER =
        IZKPassportVerifier(0x1D000001000EFD9a6371f4d90bB8920D5431c0D8);

    /// @dev Must match the domain (`name`'s host) and `scope` the frontend uses in its zkPassport request.
    string public constant DOMAIN = "gwei.domains";
    string public constant SCOPE = "human.gwei";

    /// @notice Whether an address has proven humanity.
    mapping(address => bool) public isHuman;
    /// @notice First address to claim a given passport's unique identifier (one passport = one address).
    mapping(bytes32 => address) public claimedBy;

    event HumanRegistered(address indexed account, bytes32 indexed uniqueIdentifier);

    error NotVerified();
    error WrongScope();
    error WrongSender();
    error WrongChain();
    error PassportAlreadyClaimed();

    /// @notice Verify a zkPassport proof bound to msg.sender and mark them as human.
    /// @param  params Proof verification parameters from the zkPassport SDK (compressed-evm mode).
    /// @return uniqueIdentifier The document's app-scoped unique identifier.
    function register(ProofVerificationParams calldata params) external returns (bytes32 uniqueIdentifier) {
        bool verified;
        IZKPassportHelper helper;
        (verified, uniqueIdentifier, helper) = VERIFIER.verify(params);
        if (!verified) revert NotVerified();

        // The proof must have been generated for this app's (domain, scope).
        if (!helper.verifyScopes(params.proofVerificationData.publicInputs, DOMAIN, SCOPE)) {
            revert WrongScope();
        }

        // The proof must be bound to the caller, on this chain — prevents anyone replaying it.
        BoundData memory bound = helper.getBoundData(params.committedInputs);
        if (bound.senderAddress != msg.sender) revert WrongSender();
        if (bound.chainId != block.chainid) revert WrongChain();

        // A passport can make exactly one address human (sybil resistance at the identity level).
        address prior = claimedBy[uniqueIdentifier];
        if (prior != address(0) && prior != msg.sender) revert PassportAlreadyClaimed();
        claimedBy[uniqueIdentifier] = msg.sender;

        isHuman[msg.sender] = true;
        emit HumanRegistered(msg.sender, uniqueIdentifier);

        // For stronger personhood, also require a live face match, e.g.:
        //   require(helper.isFaceMatchVerified(FaceMatchMode.STRICT, OS.ANY, params.committedInputs));
    }

    /// @notice ERC-20/721-style balance: 1 for verified humans, 0 otherwise.
    /// @dev    Lets the SubdomainRegistrar gate (`balanceOf(gateToken, minter) >= minGateBalance`) work.
    function balanceOf(address account) external view returns (uint256) {
        return isHuman[account] ? 1 : 0;
    }
}
