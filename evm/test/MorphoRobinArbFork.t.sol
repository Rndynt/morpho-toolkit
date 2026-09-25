// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test,console2} from "forge-std/Test.sol";
import {MorphoRobinArb,IRToken} from "../src/poc/MorphoRobinArb.sol";

/// Reads an actual scanner candidate. No deal(), no reserve edits, no manufactured imbalance.
contract MorphoRobinArbForkTest is Test {
    function testScannerCandidateFlashloan() public {
        string memory rpc=vm.envOr("ROBIN_FORK_RPC",string(""));
        if(bytes(rpc).length==0){vm.skip(true);return;}
        vm.createSelectFork(rpc,vm.envUint("ROBIN_BLOCK"));
        assertEq(block.chainid,4663);
        address morpho=vm.envAddress("ROBIN_MORPHO");
        address weth=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
        address token=vm.envAddress("ROBIN_TOKEN");
        MorphoRobinArb.PoolKey memory key=MorphoRobinArb.PoolKey(address(0),token,uint24(vm.envUint("ROBIN_FEE")),int24(int256(vm.envUint("ROBIN_SPACING"))),address(0));
        MorphoRobinArb arb=new MorphoRobinArb(morpho,weth,vm.envAddress("ROBIN_CURVE"),0x8876789976dEcBfCbBbe364623C63652db8C0904,0x000000000022D473030F116dDEE9F6B43aC78BA3,key);
        uint256 beforeLender=IRToken(weth).balanceOf(morpho);
        uint256 beforeOwner=IRToken(weth).balanceOf(address(this));
        uint256 amount=vm.envUint("ROBIN_AMOUNT");
        uint256 start=gasleft();
        uint256 realized=arb.execute(vm.envBool("ROBIN_REVERSE"),amount,1,amount+1,1,block.timestamp+120);
        uint256 used=start-gasleft();
        console2.log("FLASHLOAN_PRINCIPAL_WEI",amount);
        console2.log("REALIZED_GROSS_WEI",realized);
        console2.log("CALL_GAS_USED",used);
        assertGt(realized,0);
        assertEq(IRToken(weth).balanceOf(morpho),beforeLender,"Morpho not repaid exactly");
        assertEq(IRToken(weth).balanceOf(address(this))-beforeOwner,realized);
        assertEq(IRToken(token).balanceOf(address(arb)),0,"residual intermediate");
        assertEq(address(arb).balance,0,"residual native");
    }
}
