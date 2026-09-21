// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MorphoAtomicArbPOCv2} from "../src/poc/MorphoAtomicArbPOCv2.sol";

interface VmArbDeploy {
    function envAddress(string calldata) external returns (address);
    function envAddress(string calldata, string calldata) external returns (address[] memory);
    function envOr(string calldata, address) external returns (address);
    function envExists(string calldata) external returns (bool);
    function envUint(string calldata) external returns (uint256);
    function startBroadcast(uint256) external;
    function stopBroadcast() external;
}

/// @notice Dedicated, fail-closed deployment for the arbitrage executor.
/// @dev Lists can be supplied per chain through ARB_TOKEN_ADDRESSES,
/// ARB_ROUTER_ADDRESSES and ARB_AERODROME_FACTORIES. Base has audited defaults for
/// Morpho and Aerodrome; every other chain must provide every value explicitly.
contract DeployMorphoAtomicArbPOCv2 {
    VmArbDeploy private constant vm = VmArbDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BASE_MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address private constant BASE_AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address private constant BASE_AERODROME_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    function run() external returns (MorphoAtomicArbPOCv2 executor) {
        address morpho = vm.envOr("ARB_MORPHO_ADDRESS", block.chainid == 8453 ? BASE_MORPHO : address(0));
        require(morpho != address(0), "missing chain Morpho config");
        address[] memory tokens = vm.envAddress("ARB_TOKEN_ADDRESSES", ",");
        address[] memory routers;
        if (vm.envExists("ARB_ROUTER_ADDRESSES")) {
            routers = vm.envAddress("ARB_ROUTER_ADDRESSES", ",");
        } else {
            routers = new address[](0);
        }
        address[] memory factories;
        if (vm.envExists("ARB_AERODROME_FACTORIES")) {
            factories = vm.envAddress("ARB_AERODROME_FACTORIES", ",");
        } else if (block.chainid == 8453) {
            factories = new address[](1);
            factories[0] = BASE_AERODROME_FACTORY;
        } else {
            factories = new address[](0);
        }
        require(tokens.length >= 2, "need loan and intermediate tokens");
        if (block.chainid == 8453 && routers.length == 0) {
            routers = new address[](1);
            routers[0] = BASE_AERODROME_ROUTER;
        }
        require(routers.length >= 2, "need two routers");
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        executor = new MorphoAtomicArbPOCv2(morpho, tokens, routers, factories);
        vm.stopBroadcast();
    }
}
