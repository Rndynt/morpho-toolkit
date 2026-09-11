// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IPOCAeroRouter,
    IPOCERC20,
    IPOCMorphoFlashLoanCallback,
    IPOCV2Router,
    MorphoAtomicArbPOCv2
} from "../src/poc/MorphoAtomicArbPOCv2.sol";

contract POCMockToken is IPOCERC20 {
    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "allowance");
        allowance[from][msg.sender] = approved - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract POCMockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        uint256 balanceBefore = IPOCERC20(token).balanceOf(address(this));
        require(IPOCERC20(token).transfer(msg.sender, assets), "send");
        IPOCMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);
        require(POCMockToken(token).transferFrom(msg.sender, address(this), assets), "repay");
        require(IPOCERC20(token).balanceOf(address(this)) == balanceBefore, "principal");
    }
}

contract POCMockV2Router is IPOCV2Router {
    uint256 public immutable numerator;
    uint256 public immutable denominator;

    constructor(uint256 numerator_, uint256 denominator_) {
        numerator = numerator_;
        denominator = denominator_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(path.length == 2 && path[0] != path[1], "path");
        require(block.timestamp <= deadline, "deadline");

        uint256 amountOut = amountIn * numerator / denominator;
        require(amountOut >= amountOutMin, "min-out");
        require(POCMockToken(path[0]).transferFrom(msg.sender, address(this), amountIn), "take-in");
        require(IPOCERC20(path[1]).transfer(to, amountOut), "send-out");

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}

/// @dev Mirrors POCMockV2Router's pricing model but through the Route[] ABI shape, and
/// additionally checks the factory/stable fields are exactly what the caller declared -
/// this is what would catch a contract bug that forgot to thread aeroFactory through.
contract POCMockAeroRouter is IPOCAeroRouter {
    uint256 public immutable numerator;
    uint256 public immutable denominator;
    address public immutable expectedFactory;

    constructor(uint256 numerator_, uint256 denominator_, address expectedFactory_) {
        numerator = numerator_;
        denominator = denominator_;
        expectedFactory = expectedFactory_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(routes.length == 1, "routes-length");
        require(routes[0].from != routes[0].to, "route");
        require(routes[0].factory == expectedFactory, "factory");
        require(block.timestamp <= deadline, "deadline");

        uint256 amountOut = amountIn * numerator / denominator;
        require(amountOut >= amountOutMin, "min-out");
        require(POCMockToken(routes[0].from).transferFrom(msg.sender, address(this), amountIn), "take-in");
        require(IPOCERC20(routes[0].to).transfer(to, amountOut), "send-out");

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}

contract MorphoAtomicArbPOCv2Test {
    uint256 private constant UNIT = 1e18;
    address private constant PROFIT_RECEIVER = address(0xBEEF);
    address private constant AERO_FACTORY = address(0xFACE);

    function testMixedV2AndAerodromeRoundTripRepaysAndPaysProfit() external {
        (
            POCMockToken loanToken,
            POCMockToken intermediateToken,
            POCMockMorpho morpho,
            POCMockV2Router firstLegRouter,
            POCMockAeroRouter secondLegRouter,
            MorphoAtomicArbPOCv2 poc
        ) = _deployProfitableRoute();

        uint256 morphoBalanceBefore = loanToken.balanceOf(address(morpho));
        uint256 profit = poc.executeArbitrage(
            _params(
                address(loanToken),
                address(intermediateToken),
                address(firstLegRouter),
                address(secondLegRouter),
                50 * UNIT
            )
        );

        require(profit == 100 * UNIT, "wrong profit");
        require(loanToken.balanceOf(PROFIT_RECEIVER) == 100 * UNIT, "profit not paid");
        require(loanToken.balanceOf(address(morpho)) == morphoBalanceBefore, "Morpho not repaid");
        require(loanToken.balanceOf(address(poc)) == 0, "loan-token dust");
        require(intermediateToken.balanceOf(address(poc)) == 0, "intermediate dust");
    }

    function testRevertsWhenMinimumProfitIsNotMet() external {
        (
            POCMockToken loanToken,
            POCMockToken intermediateToken,
            POCMockMorpho morpho,
            POCMockV2Router firstLegRouter,
            POCMockAeroRouter secondLegRouter,
            MorphoAtomicArbPOCv2 poc
        ) = _deployProfitableRoute();

        uint256 morphoBalanceBefore = loanToken.balanceOf(address(morpho));
        MorphoAtomicArbPOCv2.ArbitrageParams memory params = _params(
            address(loanToken), address(intermediateToken), address(firstLegRouter), address(secondLegRouter), 101 * UNIT
        );

        (bool ok,) = address(poc).call(abi.encodeCall(poc.executeArbitrage, (params)));
        require(!ok, "unprofitable route accepted");
        require(loanToken.balanceOf(address(morpho)) == morphoBalanceBefore, "state not reverted");
        require(loanToken.balanceOf(PROFIT_RECEIVER) == 0, "profit paid on revert");
    }

    function testRejectsRouterOutsideAllowlist() external {
        (
            POCMockToken loanToken,
            POCMockToken intermediateToken,,
            POCMockV2Router firstLegRouter,
            POCMockAeroRouter secondLegRouter,
            MorphoAtomicArbPOCv2 poc
        ) = _deployProfitableRoute();

        poc.setRouterAllowed(address(secondLegRouter), false);
        MorphoAtomicArbPOCv2.ArbitrageParams memory params =
            _params(address(loanToken), address(intermediateToken), address(firstLegRouter), address(secondLegRouter), 1);
        (bool ok,) = address(poc).call(abi.encodeCall(poc.executeArbitrage, (params)));
        require(!ok, "unallowed router accepted");
    }

    /// @dev The one guard that's new in v2: an Aerodrome leg pointed at a factory the
    /// owner never allowlisted must be rejected before any funds move, even if the
    /// router itself is allowlisted.
    function testRejectsUnallowedAerodromeFactory() external {
        (
            POCMockToken loanToken,
            POCMockToken intermediateToken,,
            POCMockV2Router firstLegRouter,
            POCMockAeroRouter secondLegRouter,
            MorphoAtomicArbPOCv2 poc
        ) = _deployProfitableRoute();

        poc.setAerodromeFactoryAllowed(AERO_FACTORY, false);
        MorphoAtomicArbPOCv2.ArbitrageParams memory params =
            _params(address(loanToken), address(intermediateToken), address(firstLegRouter), address(secondLegRouter), 1);
        (bool ok,) = address(poc).call(abi.encodeCall(poc.executeArbitrage, (params)));
        require(!ok, "unallowed aerodrome factory accepted");
    }

    function testRejectsFakeCallback() external {
        (,,,,, MorphoAtomicArbPOCv2 poc) = _deployProfitableRoute();
        (bool ok,) =
            address(poc).call(abi.encodeWithSelector(poc.onMorphoFlashLoan.selector, 1_000 * UNIT, bytes("fake")));
        require(!ok, "fake callback accepted");
    }

    function _deployProfitableRoute()
        private
        returns (
            POCMockToken loanToken,
            POCMockToken intermediateToken,
            POCMockMorpho morpho,
            POCMockV2Router firstLegRouter,
            POCMockAeroRouter secondLegRouter,
            MorphoAtomicArbPOCv2 poc
        )
    {
        loanToken = new POCMockToken();
        intermediateToken = new POCMockToken();
        morpho = new POCMockMorpho();

        // 1,000 loan tokens -(V2)-> 2,000 intermediate -(Aerodrome)-> 1,100 loan tokens.
        firstLegRouter = new POCMockV2Router(2, 1);
        secondLegRouter = new POCMockAeroRouter(55, 100, AERO_FACTORY);

        loanToken.mint(address(morpho), 10_000 * UNIT);
        intermediateToken.mint(address(firstLegRouter), 20_000 * UNIT);
        loanToken.mint(address(secondLegRouter), 20_000 * UNIT);

        address[] memory tokens = new address[](2);
        tokens[0] = address(loanToken);
        tokens[1] = address(intermediateToken);
        address[] memory routers = new address[](2);
        routers[0] = address(firstLegRouter);
        routers[1] = address(secondLegRouter);
        address[] memory factories = new address[](1);
        factories[0] = AERO_FACTORY;
        poc = new MorphoAtomicArbPOCv2(address(morpho), tokens, routers, factories);
    }

    function _params(
        address loanToken,
        address intermediateToken,
        address firstLegRouter,
        address secondLegRouter,
        uint256 minProfit
    ) private pure returns (MorphoAtomicArbPOCv2.ArbitrageParams memory params) {
        params = MorphoAtomicArbPOCv2.ArbitrageParams({
            loanToken: loanToken,
            intermediateToken: intermediateToken,
            firstLeg: MorphoAtomicArbPOCv2.SwapLeg({
                router: firstLegRouter,
                kind: MorphoAtomicArbPOCv2.RouterKind.V2,
                aeroStable: false,
                aeroFactory: address(0)
            }),
            secondLeg: MorphoAtomicArbPOCv2.SwapLeg({
                router: secondLegRouter,
                kind: MorphoAtomicArbPOCv2.RouterKind.AERODROME,
                aeroStable: false,
                aeroFactory: AERO_FACTORY
            }),
            loanAmount: 1_000 * UNIT,
            minIntermediateAmount: 1_900 * UNIT,
            minFinalAmount: 1_050 * UNIT,
            minProfit: minProfit,
            deadline: type(uint256).max,
            profitReceiver: PROFIT_RECEIVER
        });
    }
}
