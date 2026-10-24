// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IGnsPostsNameNFT {
    function ownerOf(uint256 tokenId) external view returns (address);

    function resolve(uint256 tokenId) external view returns (address);
}

/// @title GNS Posts
/// @notice An event log of posts for `.gwei` names. A post is a byte string (see posts/SPEC.md)
///         named by its keccak256 hash. The bytes travel in EIP-4844 blobs; this contract only
///         records who authorized which post and which blob carries it.
///
///         A post is valid for a name when its owner authorized the hash while the name was
///         active, and some blob recorded by `PostPublished` contains bytes with that hash.
///         Anyone can publish: an owner can send their own blob (`post`), or authorize a post and
///         pay any publisher to carry it (`authorize`), and every publisher's blobs count the
///         same. Clients rebuild the state from events alone, without archive state.
///
///         The contract has no owner, admin, allowlist, treasury, upgrades, or storage. Fees go
///         straight from the author to the publisher they name.
contract GnsPosts {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidGns();
    error NotNameOwner(uint256 tokenId);
    error InactiveName(uint256 tokenId);
    error NoBlob(uint256 blobIndex);
    error NoPosts();
    error NoPublisher();
    error FeeTransferFailed();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice The owner of `tokenId` vouches for the post with hash `postHash`, and paid `fee`
    ///         to `publisher` for carrying it. A self-published post names its author as publisher.
    event PostAuthorized(
        uint256 indexed tokenId,
        bytes32 indexed postHash,
        address indexed author,
        address publisher,
        uint256 fee
    );

    /// @notice `publisher` states that the blob with versioned hash `blobHash`, attached to this
    ///         transaction, contains the post with hash `postHash`. Clients check that it does.
    event PostPublished(bytes32 indexed postHash, bytes32 indexed blobHash, address indexed publisher);

    /// @notice The owner of `tokenId` withdraws the post. The bytes stay in the blob, but clients
    ///         stop showing the post for this author unless they authorize it again.
    event PostRemoved(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author);

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    IGnsPostsNameNFT public immutable gns;

    constructor(IGnsPostsNameNFT gns_) {
        if (address(gns_) == address(0)) revert InvalidGns();
        gns = gns_;
    }

    /*//////////////////////////////////////////////////////////////
                                POSTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize a post for a name you own, optionally paying `publisher` to put it in a
    ///         blob. Works from any account, including contract wallets that can't send blobs.
    function authorize(uint256 tokenId, bytes32 postHash, address publisher) external payable {
        _requireActiveOwner(tokenId);
        if (msg.value != 0 && publisher == address(0)) revert NoPublisher();
        emit PostAuthorized(tokenId, postHash, msg.sender, publisher, msg.value);
        if (msg.value != 0) {
            (bool ok,) = publisher.call{value: msg.value}("");
            if (!ok) revert FeeTransferFailed();
        }
    }

    /// @notice Record which posts this transaction's blobs carry: `postHashes[i]` lists the posts
    ///         in blob `i`. Open to anyone; a post only counts once its owner authorizes it.
    function publish(bytes32[][] calldata postHashes) external {
        uint256 blobCount = postHashes.length;
        if (blobCount == 0) revert NoPosts();
        for (uint256 i; i < blobCount; ++i) {
            bytes32 blobHash = blobhash(i);
            if (blobHash == bytes32(0)) revert NoBlob(i);
            bytes32[] calldata hashes = postHashes[i];
            if (hashes.length == 0) revert NoPosts();
            for (uint256 j; j < hashes.length; ++j) {
                emit PostPublished(hashes[j], blobHash, msg.sender);
            }
        }
    }

    /// @notice Authorize and publish one post in a single blob transaction sent by the owner.
    function post(uint256 tokenId, bytes32 postHash, uint256 blobIndex) external {
        _requireActiveOwner(tokenId);
        bytes32 blobHash = blobhash(blobIndex);
        if (blobHash == bytes32(0)) revert NoBlob(blobIndex);
        emit PostAuthorized(tokenId, postHash, msg.sender, msg.sender, 0);
        emit PostPublished(postHash, blobHash, msg.sender);
    }

    /// @notice Withdraw a post you authorized for a name you own.
    function remove(uint256 tokenId, bytes32 postHash) external {
        if (gns.ownerOf(tokenId) != msg.sender) revert NotNameOwner(tokenId);
        emit PostRemoved(tokenId, postHash, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev NameNFT's resolve() is zero exactly when a name (or a parent) is unregistered or expired.
    function _requireActiveOwner(uint256 tokenId) internal view {
        if (gns.resolve(tokenId) == address(0)) revert InactiveName(tokenId);
        if (gns.ownerOf(tokenId) != msg.sender) revert NotNameOwner(tokenId);
    }
}
