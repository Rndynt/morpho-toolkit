// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {MorphoRobinArb} from "../src/poc/MorphoRobinArb.sol";

contract RobinTokenMock {
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    function mint(address who,uint256 n) external {balanceOf[who]+=n;}
    function approve(address who,uint256 n) external returns(bool){allowance[msg.sender][who]=n;return true;}
    function transfer(address who,uint256 n) external returns(bool){balanceOf[msg.sender]-=n;balanceOf[who]+=n;return true;}
    function transferFrom(address from,address to,uint256 n) external returns(bool){allowance[from][msg.sender]-=n;balanceOf[from]-=n;balanceOf[to]+=n;return true;}
    function deposit() external payable {balanceOf[msg.sender]+=msg.value;}
    function withdraw(uint256 n) external {balanceOf[msg.sender]-=n;(bool ok,)=msg.sender.call{value:n}("");require(ok);}
    receive() external payable {}
}
contract RobinLoanMock {
    function flashLoan(address token,uint256 amount,bytes calldata data) external {
        RobinTokenMock(payable(token)).transfer(msg.sender,amount);
        MorphoRobinArb(payable(msg.sender)).onMorphoFlashLoan(amount,data);
        RobinTokenMock(payable(token)).transferFrom(msg.sender,address(this),amount);
    }
}
contract RobinCurveMock {
    function buy(address token,uint256) external payable returns(uint256){RobinTokenMock(payable(token)).mint(msg.sender,msg.value*2);return msg.value*2;}
    function sell(address token,uint256 amount,uint256) external returns(uint256){RobinTokenMock(payable(token)).transferFrom(msg.sender,address(this),amount);uint256 out=amount*3/5;(bool ok,)=msg.sender.call{value:out}("");require(ok);return out;}
    receive() external payable {}
}
contract RobinPermitMock {
    function approve(address,address,uint160,uint48) external {}
}
contract RobinRouterMock {
    address immutable token;
    uint256 public numerator=3;
    constructor(address token_){token=token_;}
    function setNumerator(uint256 n) external {numerator=n;}
    function approve(address,address,uint160,uint48) external {}
    function execute(bytes calldata,bytes[] calldata inputs,uint256) external payable {
        if(msg.value>0){RobinTokenMock(payable(token)).mint(msg.sender,msg.value*2);return;}
        (,bytes[] memory params)=abi.decode(inputs[0],(bytes,bytes[]));
        (,uint256 amount)=abi.decode(params[1],(address,uint256));
        // Mock consumes tokens directly; real Permit2 still needs a forward-route fork candidate.
        RobinTokenMock(payable(token)).transferFrom(msg.sender,address(this),amount);
        (bool ok,)=msg.sender.call{value:amount*numerator/5}("");require(ok);
    }
    receive() external payable {}
}
contract MorphoRobinArbTest is Test {
    RobinTokenMock weth;RobinTokenMock token;RobinLoanMock morpho;RobinCurveMock curve;RobinRouterMock router;MorphoRobinArb arb;
    MorphoRobinArb.PoolKey key;
    function setUp() public {
        weth=new RobinTokenMock();token=new RobinTokenMock();morpho=new RobinLoanMock();curve=new RobinCurveMock();router=new RobinRouterMock(address(token));
        vm.deal(address(weth),100 ether);vm.deal(address(curve),100 ether);vm.deal(address(router),100 ether);weth.mint(address(morpho),10 ether);
        key=MorphoRobinArb.PoolKey(address(0),address(token),3000,60,address(0));
        // Router also provides the Permit2 approve stub in this unit test.
        arb=new MorphoRobinArb(address(morpho),address(weth),address(curve),address(router),address(router),key);
    }
    function testRejectsUnsolicitedCallback() public {vm.expectRevert();arb.onMorphoFlashLoan(1,"");}
    function testOwnerOnly() public {vm.prank(address(123));vm.expectRevert();arb.execute(true,1 ether,1,1 ether+1,1,block.timestamp+60);}
    function testFlashloanReverseUsesNoWorkingCapital() public {
        uint256 before=weth.balanceOf(address(morpho));
        uint256 gained=arb.execute(true,1 ether,1,1.1 ether,0.1 ether,block.timestamp+60);
        assertEq(gained,0.2 ether);assertEq(weth.balanceOf(address(morpho)),before);assertEq(weth.balanceOf(address(this)),gained);
        assertEq(weth.balanceOf(address(arb)),0);assertEq(address(arb).balance,0);
    }
    function testImpossibleProfitRollsBackLoan() public {
        uint256 before=weth.balanceOf(address(morpho));vm.expectRevert();arb.execute(true,1 ether,1,2 ether,1 ether,block.timestamp+60);
        assertEq(weth.balanceOf(address(morpho)),before);assertEq(weth.balanceOf(address(this)),0);
    }
    function testFlashloanForwardUsesNoWorkingCapital() public {
        uint256 before=weth.balanceOf(address(morpho));
        uint256 gained=arb.execute(false,1 ether,1,1.1 ether,0.1 ether,block.timestamp+60);
        assertEq(gained,0.2 ether);assertEq(weth.balanceOf(address(morpho)),before);
        assertEq(token.balanceOf(address(arb)),0);
    }
}
