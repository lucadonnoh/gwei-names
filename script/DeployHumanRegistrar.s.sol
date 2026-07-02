// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {HumanRegistrar, IZKPassportVerifier, ISubdomainRegistrar} from "../src/HumanRegistrar.sol";

interface INameOps {
    function computeId(string calldata fullName) external pure returns (uint256);
    function setApprovalForAll(address operator, bool approved) external;
}

interface IRegistrarConfig {
    function configure(
        uint256 parentId,
        address payout,
        address feeToken,
        uint256 price,
        bool enabled,
        address gateToken,
        uint256 minGateBalance
    ) external;
}

/// @notice Deploys HumanRegistrar and points zkpassport.gwei's SubdomainRegistrar gate at it, so that
///         `*.zkpassport.gwei` can be minted only via `HumanRegistrar.claim` (one name per passport, forever).
/// @dev    Prerequisite: the deployer must already own `zkpassport.gwei` (register it via commit-reveal on
///         the existing NameNFT first). Then run this AS that owner. Sepolia:
///           forge script script/DeployHumanRegistrar.s.sol --rpc-url sepolia --account <keystore> --password-file <file> --broadcast --verify
///         Simulate first (no key, no broadcast):
///           forge script script/DeployHumanRegistrar.s.sol --rpc-url sepolia --sender <deployer>
contract DeployHumanRegistrar is Script {
    // zkPassport verifier — same deterministic address on Ethereum mainnet, Sepolia and Base.
    address constant VERIFIER = 0x1D000001000EFD9a6371f4d90bB8920D5431c0D8;
    // Gwei Name Service on Sepolia (NameNFT shares its mainnet address).
    address constant NAME_NFT = 0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6;
    address constant REGISTRAR = 0xc1D5245bfd98dDB7E73B33209B346b4FC0E03f3c;

    function run() external returns (HumanRegistrar hr, uint256 humanId) {
        humanId = INameOps(NAME_NFT).computeId("zkpassport.gwei");
        // Domain the proof binds to. "gwei.domains" for prod; set HR_DOMAIN=localhost for local testing.
        string memory hrDomain = vm.envOr("HR_DOMAIN", string("gwei.domains"));
        // allowDevMode MUST be false on mainnet. Set HR_ALLOW_DEVMODE=true only for a Sepolia mock test.
        bool allowDevMode = vm.envOr("HR_ALLOW_DEVMODE", false);

        vm.startBroadcast();

        hr = new HumanRegistrar(
            IZKPassportVerifier(VERIFIER), ISubdomainRegistrar(REGISTRAR), humanId, hrDomain, allowDevMode
        );

        // Re-point zkpassport.gwei's gate at the new registrar: free, flash mode, gate balance 1.
        // payout = address(0) → the registrar defaults it to the caller (the owner).
        IRegistrarConfig(REGISTRAR).configure(humanId, address(0), address(0), 0, true, address(hr), 1);

        // Flash mode pulls the parent from the owner at mint time, so the owner must approve the
        // registrar. Idempotent — a no-op if already approved from the earlier deployment.
        INameOps(NAME_NFT).setApprovalForAll(REGISTRAR, true);

        vm.stopBroadcast();

        console.log("HumanRegistrar    :", address(hr));
        console.log("domain            :", hrDomain);
        console.log("allowDevMode      :", allowDevMode);
        console.log("zkpassport.gwei id     :", humanId);
        console.log("gate reconfigured : gateToken = HumanRegistrar, minGateBalance = 1, free, flash");
    }
}
