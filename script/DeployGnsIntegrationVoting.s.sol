// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {GnsIntegrationVoting, IGnsVotingNameNFT} from "../src/GnsIntegrationVoting.sol";

/// @notice Deploys the ownerless, stateless GNS integration ballot emitter.
/// @dev NameNFT lives at the same address on Ethereum mainnet and Sepolia.
///
/// Usage:
///   forge script script/DeployGnsIntegrationVoting.s.sol --rpc-url sepolia --account <account> --broadcast --verify
///   forge script script/DeployGnsIntegrationVoting.s.sol --rpc-url main --account <account> --broadcast --verify
contract DeployGnsIntegrationVoting is Script {
    error UnsupportedChain(uint256 chainId);
    error UnexpectedNameNftCodehash(bytes32 actual, bytes32 expected);
    error UnexpectedFeeSchedule(uint256 labelLength, uint256 actual, uint256 expected);

    uint256 internal constant MAINNET = 1;
    uint256 internal constant SEPOLIA = 11_155_111;
    address public constant NAME_NFT = 0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6;
    bytes32 internal constant MAINNET_NAME_NFT_CODEHASH =
        0xb0e20c7e72a371b06d4456cc5056ea06ab2366da03f8cf49698a1f956e60b068;
    bytes32 internal constant SEPOLIA_NAME_NFT_CODEHASH =
        0x18f61fe57f2924de1a02d4524ce0ea638a227ffc394dc120b53ff0122d8e7fe0;

    /// @notice Fails closed if the selected network is not a known GNS deployment.
    function validateDeploymentTarget() public view {
        bytes32 expectedCodehash;
        if (block.chainid == MAINNET) {
            expectedCodehash = MAINNET_NAME_NFT_CODEHASH;
        } else if (block.chainid == SEPOLIA) {
            expectedCodehash = SEPOLIA_NAME_NFT_CODEHASH;
        } else {
            revert UnsupportedChain(block.chainid);
        }

        bytes32 actualCodehash = NAME_NFT.codehash;
        if (actualCodehash != expectedCodehash) {
            revert UnexpectedNameNftCodehash(actualCodehash, expectedCodehash);
        }

        IGnsVotingNameNFT nameNft = IGnsVotingNameNFT(NAME_NFT);
        _requireFee(nameNft, 1, 0.5 ether);
        _requireFee(nameNft, 2, 0.1 ether);
        _requireFee(nameNft, 3, 0.05 ether);
        _requireFee(nameNft, 4, 0.01 ether);
        _requireFee(nameNft, 5, 0.0005 ether);
        _requireFee(nameNft, 255, 0.0005 ether);
    }

    function run() external returns (GnsIntegrationVoting voting) {
        validateDeploymentTarget();

        vm.startBroadcast();
        voting = new GnsIntegrationVoting(IGnsVotingNameNFT(NAME_NFT));
        vm.stopBroadcast();

        console.log("GnsIntegrationVoting:", address(voting));
        console.log("ballots verified against NameNFT:", address(voting.gns()));
        console.log("annual fee represented by one vote:", voting.baseFee());
    }

    function _requireFee(IGnsVotingNameNFT nameNft, uint256 labelLength, uint256 expected)
        internal
        view
    {
        uint256 actual = nameNft.getFee(labelLength);
        if (actual != expected) revert UnexpectedFeeSchedule(labelLength, actual, expected);
    }
}
