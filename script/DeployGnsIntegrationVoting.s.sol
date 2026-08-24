// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {GnsIntegrationVoting, IGnsVotingNameNFT} from "../src/GnsIntegrationVoting.sol";

/// @notice Deploys the ownerless, stateless GNS integration ballot emitter.
/// @dev NameNFT lives at the same address on Ethereum mainnet and Sepolia.
///
/// Usage:
///   forge script script/DeployGnsIntegrationVoting.s.sol --rpc-url sepolia --broadcast --private-key $DEPLOYER_PK [--verify]
///   forge script script/DeployGnsIntegrationVoting.s.sol --rpc-url main --broadcast --private-key $DEPLOYER_PK [--verify]
contract DeployGnsIntegrationVoting is Script {
    address constant NAME_NFT = 0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6;

    function run() external returns (GnsIntegrationVoting voting) {
        vm.startBroadcast();
        voting = new GnsIntegrationVoting(IGnsVotingNameNFT(NAME_NFT));
        vm.stopBroadcast();

        console.log("GnsIntegrationVoting:", address(voting));
        console.log("ballots verified against NameNFT:", address(voting.gns()));
        console.log("annual fee represented by one vote:", voting.baseFee());
    }
}
