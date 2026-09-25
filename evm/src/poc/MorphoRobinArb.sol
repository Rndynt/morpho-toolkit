// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRToken {
    function balanceOf(address) external view returns(uint256);
    function approve(address,uint256) external returns(bool);
    function transfer(address,uint256) external returns(bool);
}
interface IRWeth is IRToken { function deposit() external payable; function withdraw(uint256) external; }
interface IRMorpho { function flashLoan(address,uint256,bytes calldata) external; }
interface IRCurve {
    function buy(address,uint256) external payable returns(uint256);
    function sell(address,uint256,uint256) external returns(uint256);
}
interface IRRouter { function execute(bytes calldata,bytes[] calldata,uint256) external payable; }
interface IRPermit2 { function approve(address,address,uint160,uint48) external; }

/// @notice Narrow flashloan POC for an immutable RobinFun / V4 route. No working capital, no force mode.
/// @dev Quote/discovery pattern: FlipZ3ro/RobinArb. This is not its deposited-capital executor.
contract MorphoRobinArb {
    struct PoolKey {address currency0;address currency1;uint24 fee;int24 tickSpacing;address hooks;}
    struct SwapParams {PoolKey poolKey;bool zeroForOne;uint128 amountIn;uint128 amountOutMinimum;bytes hookData;}
    struct Params {bool reverse;uint256 amount;uint256 minTokens;uint256 minEth;uint256 minProfit;uint256 deadline;}
    address public immutable owner;
    address public immutable morpho;
    address public immutable weth;
    address public immutable curve;
    address public immutable router;
    address public immutable permit2;
    address public immutable token;
    PoolKey public pool;
    bytes32 private active;
    bool private callbackDone;

    constructor(address m,address w,address c,address r,address p,PoolKey memory k) {
        require(m.code.length>0 && w.code.length>0 && c.code.length>0 && r.code.length>0 && p.code.length>0,"invalid infrastructure");
        require(k.currency0==address(0) && k.currency1.code.length>0 && k.currency1!=w && k.hooks==address(0) && k.tickSpacing>0,"invalid pool");
        owner=msg.sender;morpho=m;weth=w;curve=c;router=r;permit2=p;token=k.currency1;pool=k;
    }
    receive() external payable {}

    function execute(bool reverse,uint256 amount,uint256 minTokens,uint256 minEth,uint256 minProfit,uint256 deadline) external returns(uint256 gain) {
        require(msg.sender==owner && active==bytes32(0),"unauthorized or active");
        require(amount>0 && amount<=type(uint128).max && minTokens>0 && minTokens<=type(uint128).max && minEth<=type(uint128).max,"invalid amount");
        require(minProfit>0 && minEth>=amount+minProfit && deadline>=block.timestamp && deadline<=type(uint48).max,"invalid profit/deadline");
        uint256 beforeWeth=IRToken(weth).balanceOf(address(this));
        uint256 beforeEth=address(this).balance;
        bytes memory data=abi.encode(Params(reverse,amount,minTokens,minEth,minProfit,deadline));
        active=keccak256(data);callbackDone=false;
        IRMorpho(morpho).flashLoan(weth,amount,data);
        require(callbackDone,"missing callback");
        require(address(this).balance==beforeEth,"residual ETH");
        gain=IRToken(weth).balanceOf(address(this))-beforeWeth;
        require(gain>=minProfit,"insufficient profit");
        _approve(weth,morpho,0);
        active=bytes32(0);callbackDone=false;
        _call(weth,abi.encodeCall(IRToken.transfer,(owner,gain)));
    }
    function onMorphoFlashLoan(uint256 assets,bytes calldata data) external {
        require(msg.sender==morpho && active!=bytes32(0) && !callbackDone && keccak256(data)==active,"invalid callback");
        Params memory p=abi.decode(data,(Params));
        require(assets==p.amount && block.timestamp<=p.deadline,"invalid loan");
        callbackDone=true;
        uint256 beforeEth=address(this).balance;
        uint256 beforeToken=IRToken(token).balanceOf(address(this));
        IRWeth(weth).withdraw(assets);
        if(p.reverse) _v4(true,assets,p.minTokens,p.deadline);
        else IRCurve(curve).buy{value:assets}(token,p.minTokens);
        uint256 got=IRToken(token).balanceOf(address(this))-beforeToken;
        require(got>=p.minTokens && got<=type(uint128).max,"insufficient tokens");
        if(p.reverse) {
            _approve(token,curve,got);
            IRCurve(curve).sell(token,got,p.minEth);
            _approve(token,curve,0);
        } else {
            _approve(token,permit2,got);
            IRPermit2(permit2).approve(token,router,uint160(got),uint48(p.deadline));
            _v4(false,got,p.minEth,p.deadline);
            IRPermit2(permit2).approve(token,router,0,0);
            _approve(token,permit2,0);
        }
        require(IRToken(token).balanceOf(address(this))==beforeToken,"residual tokens");
        uint256 returned=address(this).balance-beforeEth;
        require(returned>=assets+p.minProfit && returned>=p.minEth,"insufficient return");
        IRWeth(weth).deposit{value:returned}();
        _approve(weth,morpho,assets);
    }
    function _v4(bool buy,uint256 amount,uint256 minimum,uint256 deadline) private {
        require(amount<=type(uint128).max && minimum<=type(uint128).max,"V4 overflow");
        bytes[] memory params=new bytes[](3);
        params[0]=abi.encode(SwapParams(pool,buy,uint128(amount),uint128(minimum),""));
        params[1]=abi.encode(buy?address(0):token,amount);
        params[2]=abi.encode(buy?token:address(0),minimum);
        bytes[] memory inputs=new bytes[](1);
        inputs[0]=abi.encode(hex"060c0f",params);
        IRRouter(router).execute{value:buy?amount:0}(hex"10",inputs,deadline);
    }
    function _approve(address asset,address spender,uint256 amount) private {
        _call(asset,abi.encodeCall(IRToken.approve,(spender,0)));
        if(amount>0)_call(asset,abi.encodeCall(IRToken.approve,(spender,amount)));
    }
    function _call(address asset,bytes memory data) private {
        (bool ok,bytes memory result)=asset.call(data);
        require(ok && (result.length==0 || (result.length==32 && abi.decode(result,(bool)))),"token call failed");
    }
}
