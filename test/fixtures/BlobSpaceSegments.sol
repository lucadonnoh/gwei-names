// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

/// @notice Test-only copy of the draft ERC-8179 core interface.
interface IERC_BSS {
    event BlobSegmentDeclared(
        bytes32 indexed versionedHash,
        address indexed declarer,
        uint16 startFE,
        uint16 endFE,
        bytes32 indexed contentTag
    );

    error InvalidSegment(uint16 startFE, uint16 endFE);
    error NoBlobAtIndex(uint256 blobIndex);

    function declareBlobSegment(uint256 blobIndex, uint16 startFE, uint16 endFE, bytes32 contentTag)
        external
        returns (bytes32 versionedHash);
}

/// @notice Test-only copy of the draft ERC-8179 reference implementation.
/// @dev This fixture has zero storage and is not intended for deployment.
contract BlobSpaceSegments is IERC_BSS {
    uint16 internal constant MAX_FIELD_ELEMENTS = 4096;

    function declareBlobSegment(uint256 blobIndex, uint16 startFE, uint16 endFE, bytes32 contentTag)
        external
        returns (bytes32 versionedHash)
    {
        if (startFE >= endFE || endFE > MAX_FIELD_ELEMENTS) {
            revert InvalidSegment(startFE, endFE);
        }

        assembly {
            versionedHash := blobhash(blobIndex)
        }
        if (versionedHash == bytes32(0)) revert NoBlobAtIndex(blobIndex);

        emit BlobSegmentDeclared(versionedHash, msg.sender, startFE, endFE, contentTag);
    }
}
