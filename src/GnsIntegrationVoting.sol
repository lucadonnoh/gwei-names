// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IGnsVotingNameNFT {
    function ownerOf(uint256 tokenId) external view returns (address);

    function records(uint256 tokenId)
        external
        view
        returns (
            string memory label,
            uint256 parent,
            uint64 expiresAt,
            uint64 epoch,
            uint64 parentEpoch
        );

    function getFee(uint256 length) external view returns (uint256);
}

/// @title GNS Integration Voting
/// @notice Emits price-weighted integration ballots for active top-level `.gwei` names.
///
///         A ballot is a complete replacement for one name's previous ballot. Clients reconstruct
///         the current result from the latest `BallotCast` event for each `(tokenId, epoch)`, then
///         ignore names that are no longer active. Empty arrays clear a ballot.
///
///         Voting power mirrors NameNFT's immutable annual fee schedule. One 5+-byte name is the
///         base unit; a name whose annual fee is 20 times higher receives 20 votes. Expiry premiums
///         and transaction gas are deliberately excluded.
///
///         The contract has no owner, admin, allowlist, treasury, fees, upgrades, or mutable state.
///         `gns` and `baseFee` are immutable deployment parameters.
contract GnsIntegrationVoting {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Ballot {
        uint256 tokenId;
        bytes32[] integrationIds;
        uint16[] votes;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidGns();
    error EmptyBallots();
    error BallotsNotSorted();
    error NameDoesNotExist(uint256 tokenId);
    error NotNameOwner(uint256 tokenId);
    error InactiveName(uint256 tokenId);
    error SubdomainNotEligible(uint256 tokenId);
    error AllocationLengthMismatch(uint256 tokenId);
    error InvalidIntegrationId(uint256 tokenId);
    error ZeroVotes(uint256 tokenId, bytes32 integrationId);
    error AllocationsNotSorted(uint256 tokenId);
    error TooManyAllocations(uint256 tokenId, uint256 allocationCount, uint256 votingPower);
    error TooManyVotes(uint256 tokenId, uint256 allocated, uint256 votingPower);
    error InvalidFeeSchedule();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice A complete replacement ballot for one name and registration epoch.
    /// @dev `integrationIds` are strictly increasing and correspond one-for-one with `votes`.
    event BallotCast(
        address indexed voter,
        uint256 indexed tokenId,
        uint64 indexed epoch,
        bytes32[] integrationIds,
        uint16[] votes
    );

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    IGnsVotingNameNFT public immutable gns;
    uint256 public immutable baseFee;

    uint256 internal constant MAX_LABEL_LENGTH = 255;

    constructor(IGnsVotingNameNFT gns_) {
        if (address(gns_) == address(0)) revert InvalidGns();
        uint256 baseFee_ = gns_.getFee(5);
        if (baseFee_ == 0) revert InvalidFeeSchedule();
        gns = gns_;
        baseFee = baseFee_;
    }

    /*//////////////////////////////////////////////////////////////
                                VOTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Cast complete replacement ballots for any number of names in one transaction.
    /// @dev Ballots must be sorted by tokenId and allocations by integrationId. Canonical ordering
    ///      prevents duplicate names or integrations and makes independent event indexing simple.
    function cast(Ballot[] calldata ballots) external {
        uint256 ballotCount = ballots.length;
        if (ballotCount == 0) revert EmptyBallots();

        uint256 previousTokenId;
        for (uint256 i; i < ballotCount; ++i) {
            Ballot calldata ballot = ballots[i];
            if (i != 0 && ballot.tokenId <= previousTokenId) revert BallotsNotSorted();
            previousTokenId = ballot.tokenId;

            (string memory label, uint256 parent, uint64 expiresAt, uint64 epoch,) =
                gns.records(ballot.tokenId);

            uint256 labelLength = bytes(label).length;
            if (labelLength == 0) revert NameDoesNotExist(ballot.tokenId);
            if (parent != 0) revert SubdomainNotEligible(ballot.tokenId);
            if (block.timestamp > expiresAt) revert InactiveName(ballot.tokenId);
            if (gns.ownerOf(ballot.tokenId) != msg.sender) {
                revert NotNameOwner(ballot.tokenId);
            }

            uint256 allocationCount = ballot.integrationIds.length;
            if (allocationCount != ballot.votes.length) {
                revert AllocationLengthMismatch(ballot.tokenId);
            }

            uint256 power = _votingPowerForLength(labelLength);
            if (allocationCount > power) {
                revert TooManyAllocations(ballot.tokenId, allocationCount, power);
            }

            uint256 allocated;
            bytes32 previousIntegrationId;
            for (uint256 j; j < allocationCount; ++j) {
                bytes32 integrationId = ballot.integrationIds[j];
                if (integrationId == bytes32(0)) revert InvalidIntegrationId(ballot.tokenId);
                if (j != 0 && integrationId <= previousIntegrationId) {
                    revert AllocationsNotSorted(ballot.tokenId);
                }
                previousIntegrationId = integrationId;

                uint16 amount = ballot.votes[j];
                if (amount == 0) revert ZeroVotes(ballot.tokenId, integrationId);
                allocated += amount;
                if (allocated > power) {
                    revert TooManyVotes(ballot.tokenId, allocated, power);
                }
            }

            emit BallotCast(msg.sender, ballot.tokenId, epoch, ballot.integrationIds, ballot.votes);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                READS
    //////////////////////////////////////////////////////////////*/

    /// @notice Current voting power for an active top-level name, or zero when ineligible.
    function votingPower(uint256 tokenId) external view returns (uint256) {
        (string memory label, uint256 parent, uint64 expiresAt,,) = gns.records(tokenId);
        uint256 labelLength = bytes(label).length;
        if (labelLength == 0 || parent != 0 || block.timestamp > expiresAt) return 0;
        return _votingPowerForLength(labelLength);
    }

    /// @notice Voting power for a label byte length under NameNFT's immutable price schedule.
    function votingPowerForLength(uint256 labelLength) external view returns (uint256) {
        if (labelLength == 0 || labelLength > MAX_LABEL_LENGTH) return 0;
        return _votingPowerForLength(labelLength);
    }

    function _votingPowerForLength(uint256 labelLength) internal view returns (uint256 power) {
        uint256 fee = gns.getFee(labelLength);
        if (fee == 0 || fee % baseFee != 0) revert InvalidFeeSchedule();
        power = fee / baseFee;
        if (power == 0 || power > type(uint16).max) revert InvalidFeeSchedule();
    }
}
