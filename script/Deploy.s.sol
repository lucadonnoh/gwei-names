// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {SubdomainRegistrar, INameNFT} from "../src/SubdomainRegistrar.sol";

/// @notice Deploys the Gwei Name Service.
/// @dev NameNFT takes no constructor args (it's ownerless); the registrar takes the NameNFT address.
///
/// Usage (Sepolia):
///   forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --private-key $DEPLOYER_PK [--verify]
contract Deploy is Script {
    function run() external returns (NameNFT nft, SubdomainRegistrar registrar) {
        vm.startBroadcast();
        nft = new NameNFT();
        registrar = new SubdomainRegistrar(INameNFT(address(nft)));
        vm.stopBroadcast();

        console.log("NameNFT            :", address(nft));
        console.log("SubdomainRegistrar :", address(registrar));
        console.log("name()             :", nft.name());
        console.log("getFee(6) (wei)    :", nft.getFee(6));
    }
}
