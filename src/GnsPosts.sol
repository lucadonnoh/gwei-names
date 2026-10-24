// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "soledge/utils/ReentrancyGuard.sol";

interface IGnsPostsNameNFT {
    function ownerOf(uint256 tokenId) external view returns (address);

    function resolve(uint256 tokenId) external view returns (address);
}

/// @title GNS Posts
/// @notice An event log of posts for `.gwei` names (posts/SPEC.md), where a post's fee is only paid
///         for delivering the exact blob its author built.
///
///         A blob's versioned hash depends only on its bytes, and the bytes of a post's blob are
///         fixed by the post. So the author computes the versioned hash before anyone publishes
///         and authorizes the post against it. A fee sits in escrow until the publisher it names
///         sends a blob transaction carrying a blob with exactly that versioned hash (read with
///         BLOBHASH) and calls `publish`, which pays it out in the same transaction. No other blob
///         matches, so delivery needs no trust, challenge or proof. If nothing is delivered within
///         REFUND_DELAY, the payer takes the fee back.
///
///         The contract has no owner, admin, allowlist, treasury or upgrades. Its only balance is
///         fees in escrow.
contract GnsPosts is ReentrancyGuard {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidGns();
    error NotNameOwner(uint256 tokenId);
    error InactiveName(uint256 tokenId);
    error InvalidBlobHash(bytes32 blobHash);
    error NoBlob(uint256 blobIndex);
    error NoPublisher();
    error AlreadyDelivered(bytes32 blobHash, address publisher);
    error NothingToRefund();
    error RefundNotDue(uint256 refundableAt);
    error TransferFailed();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice The owner of `tokenId` vouches for the post with hash `postHash`, carried by the blob
    ///         with versioned hash `blobHash`, and put `fee` in escrow for `publisher` to deliver it.
    event PostAuthorized(
        uint256 indexed tokenId,
        bytes32 indexed postHash,
        address indexed author,
        bytes32 blobHash,
        address publisher,
        uint256 fee
    );

    /// @notice `publisher` sent the blob `blobHash` in this transaction and was paid `paid` from escrow.
    event BlobPublished(bytes32 indexed blobHash, address indexed publisher, uint256 paid);

    /// @notice `payer` took back an undelivered fee.
    event FeeRefunded(bytes32 indexed blobHash, address indexed publisher, address indexed payer, uint256 amount);

    /// @notice The owner of `tokenId` withdraws the post. The bytes stay in the blob, but clients
    ///         stop showing the post for this author unless they authorize it again.
    event PostRemoved(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author);

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice How long a fee stays locked for its publisher before the payer can take it back.
    uint256 public constant REFUND_DELAY = 1 days;

    IGnsPostsNameNFT public immutable gns;

    struct Deposit {
        uint128 amount;
        uint64 refundableAt;
    }

    /// @notice Undelivered fees for a (blob, publisher) pair, by `escrowKey`.
    mapping(bytes32 key => uint256) public escrowed;
    /// @notice Each payer's share of `escrowed`, and when they may take it back. Meaningful only
    ///         while the pair is undelivered.
    mapping(bytes32 key => mapping(address payer => Deposit)) public deposits;
    /// @notice Whether the publisher has delivered the blob (and been paid what was in escrow).
    mapping(bytes32 key => bool) public delivered;

    constructor(IGnsPostsNameNFT gns_) {
        if (address(gns_) == address(0)) revert InvalidGns();
        gns = gns_;
    }

    function escrowKey(bytes32 blobHash, address publisher) public pure returns (bytes32) {
        return keccak256(abi.encode(blobHash, publisher));
    }

    /*//////////////////////////////////////////////////////////////
                                POSTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a post for a name you own, carried by the blob `blobHash`, optionally
    ///         paying `publisher` to deliver that blob. Works from any account, including contract
    ///         wallets that can't send blobs. Paying for a blob the publisher already delivered
    ///         reverts, so a fee is never paid for work already done.
    function authorize(uint256 tokenId, bytes32 postHash, bytes32 blobHash, address publisher) external payable {
        _requireActiveOwner(tokenId);
        // Every KZG versioned hash starts with 0x01; this also catches a post hash passed by mistake.
        if (bytes1(blobHash) != 0x01) revert InvalidBlobHash(blobHash);
        if (msg.value != 0) {
            if (publisher == address(0)) revert NoPublisher();
            bytes32 key = escrowKey(blobHash, publisher);
            if (delivered[key]) revert AlreadyDelivered(blobHash, publisher);
            Deposit storage deposit = deposits[key][msg.sender];
            // ETH's total supply is far below 2^128, so the sum can't overflow.
            deposit.amount += uint128(msg.value);
            deposit.refundableAt = uint64(block.timestamp + REFUND_DELAY);
            escrowed[key] += msg.value;
        }
        emit PostAuthorized(tokenId, postHash, msg.sender, blobHash, publisher, msg.value);
    }

    /// @notice Deliver every blob attached to this transaction: record it and collect whatever was
    ///         in escrow for the caller to deliver it. Open to anyone; a publisher can only ever
    ///         collect fees authors put up for it, for the exact blobs they named.
    function publish() external nonReentrant {
        if (blobhash(0) == bytes32(0)) revert NoBlob(0);
        uint256 total = 0;
        for (uint256 i; blobhash(i) != bytes32(0); ++i) {
            total += _deliver(blobhash(i));
        }
        if (total != 0) _payCaller(total);
    }

    /// @notice Authorize and publish one post in a single blob transaction sent by the owner.
    function post(uint256 tokenId, bytes32 postHash, uint256 blobIndex) external nonReentrant {
        _requireActiveOwner(tokenId);
        bytes32 blobHash = blobhash(blobIndex);
        if (blobHash == bytes32(0)) revert NoBlob(blobIndex);
        emit PostAuthorized(tokenId, postHash, msg.sender, blobHash, msg.sender, 0);
        uint256 paid = _deliver(blobHash);
        if (paid != 0) _payCaller(paid);
    }

    /// @notice Take back a fee you paid for a blob that wasn't delivered within REFUND_DELAY.
    function refund(bytes32 blobHash, address publisher) external nonReentrant {
        bytes32 key = escrowKey(blobHash, publisher);
        Deposit memory deposit = deposits[key][msg.sender];
        if (deposit.amount == 0) revert NothingToRefund();
        if (delivered[key]) revert AlreadyDelivered(blobHash, publisher);
        if (block.timestamp < deposit.refundableAt) revert RefundNotDue(deposit.refundableAt);
        delete deposits[key][msg.sender];
        escrowed[key] -= deposit.amount;
        emit FeeRefunded(blobHash, publisher, msg.sender, deposit.amount);
        _payCaller(deposit.amount);
    }

    /// @notice Withdraw a post you authorized for a name you own.
    function remove(uint256 tokenId, bytes32 postHash) external {
        if (gns.ownerOf(tokenId) != msg.sender) revert NotNameOwner(tokenId);
        emit PostRemoved(tokenId, postHash, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Marks the blob delivered by the caller and returns what was in escrow for it (once).
    function _deliver(bytes32 blobHash) internal returns (uint256 paid) {
        bytes32 key = escrowKey(blobHash, msg.sender);
        if (!delivered[key]) {
            delivered[key] = true;
            paid = escrowed[key];
            escrowed[key] = 0;
        }
        emit BlobPublished(blobHash, msg.sender, paid);
    }

    /// @dev ETH only ever leaves to the caller: a publisher collecting its own fees, or a payer
    ///      taking back their own deposit. Every state change happens before this call.
    function _payCaller(uint256 amount) internal {
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev NameNFT's resolve() is zero exactly when a name (or a parent) is unregistered or expired.
    function _requireActiveOwner(uint256 tokenId) internal view {
        if (gns.resolve(tokenId) == address(0)) revert InactiveName(tokenId);
        if (gns.ownerOf(tokenId) != msg.sender) revert NotNameOwner(tokenId);
    }
}
