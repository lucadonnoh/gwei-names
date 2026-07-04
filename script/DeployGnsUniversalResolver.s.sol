// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {GnsUniversalResolver, INameNFT} from "../src/GnsUniversalResolver.sol";

/// @notice Deploys the GNS universal resolver, the router contract that lets viem-based apps
///         and wallets resolve `.gwei` names via `universalResolverAddress`.
/// @dev    NameNFT lives at the same address on Ethereum mainnet and Sepolia, so one script
///         serves both. To keep the resolver's address identical on both chains too (nice for
///         integrators, same as NameNFT itself), deploy from the same fresh deployer at the
///         same nonce on each chain.
///
/// Usage (Sepolia first, then mainnet):
///   forge script script/DeployGnsUniversalResolver.s.sol --rpc-url sepolia --broadcast --private-key $DEPLOYER_PK [--verify]
///   forge script script/DeployGnsUniversalResolver.s.sol --rpc-url main --broadcast --private-key $DEPLOYER_PK [--verify]
contract DeployGnsUniversalResolver is Script {
    // Gwei Name Service (same address on Ethereum mainnet and Sepolia).
    address constant NAME_NFT = 0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6;

    function run() external returns (GnsUniversalResolver resolver) {
        vm.startBroadcast();
        resolver = new GnsUniversalResolver(INameNFT(NAME_NFT));
        vm.stopBroadcast();

        console.log("GnsUniversalResolver:", address(resolver));
        console.log("answers from NameNFT:", address(resolver.gns()));
    }
}
