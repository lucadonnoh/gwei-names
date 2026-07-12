// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "@forge/Test.sol";
import {BlobSpaceSegments, IERC_BSS} from "./fixtures/BlobSpaceSegments.sol";

contract BlobSpaceSegmentsTest is Test {
    bytes32 internal constant CONTENT_TAG = keccak256("gwei.chat.envelopes.v0");
    bytes32 internal constant VERSIONED_HASH = bytes32(uint256(0x010203));

    BlobSpaceSegments internal segments;

    function setUp() public {
        segments = new BlobSpaceSegments();
    }

    function testDeclaresFullChatBlobAndReturnsVersionedHash() public {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = VERSIONED_HASH;
        vm.blobhashes(hashes);

        vm.expectEmit(true, true, true, true, address(segments));
        emit IERC_BSS.BlobSegmentDeclared(VERSIONED_HASH, address(this), 0, 4096, CONTENT_TAG);

        bytes32 result = segments.declareBlobSegment(0, 0, 4096, CONTENT_TAG);
        assertEq(result, VERSIONED_HASH);
    }

    function testDeclarationWritesNoStorage() public {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = VERSIONED_HASH;
        vm.blobhashes(hashes);
        vm.record();

        segments.declareBlobSegment(0, 0, 4096, CONTENT_TAG);

        (, bytes32[] memory writes) = vm.accesses(address(segments));
        assertEq(writes.length, 0);
    }

    function testRevertsWhenBlobIsMissing() public {
        vm.blobhashes(new bytes32[](0));
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.NoBlobAtIndex.selector, 0));
        segments.declareBlobSegment(0, 0, 4096, CONTENT_TAG);
    }

    function testFuzzRejectsInvalidRanges(uint16 startFE, uint16 endFE) public {
        vm.assume(startFE >= endFE || endFE > 4096);
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, startFE, endFE));
        segments.declareBlobSegment(0, startFE, endFE, CONTENT_TAG);
    }

    function testFuzzAcceptsValidRanges(uint16 rawStart, uint16 rawLength) public {
        uint16 startFE = uint16(bound(rawStart, 0, 4095));
        uint16 length = uint16(bound(rawLength, 1, 4096 - startFE));
        uint16 endFE = startFE + length;
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = VERSIONED_HASH;
        vm.blobhashes(hashes);

        assertEq(segments.declareBlobSegment(0, startFE, endFE, CONTENT_TAG), VERSIONED_HASH);
    }
}
