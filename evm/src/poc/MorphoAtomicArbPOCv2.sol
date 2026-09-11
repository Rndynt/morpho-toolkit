// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Extends MorphoAtomicArbPOC.sol (kept unmodified as the validated V2-only baseline -
// see evm/test/MorphoAtomicArbPOCBaseFork.t.sol for its real Base mainnet fork proof)
// with a second swap adapter: Solidly/Aerodrome/Velodrome-style routers, which take a
// Route[] (from/to/stable/factory) instead of Uniswap V2's address[] path.
//
// Each leg (firstLeg/secondLeg) now independently declares its own RouterKind, so an
// arbitrage can buy on a V2 router and sell on Aerodrome, or vice versa, or use either
// kind for both legs. Same security posture as the original: no arbitrary-call path,
// explicit allowlists (now also for Aerodrome factories, since the factory determines
// which pool set a swap can reach), balance-delta accounting, single-loan reentrancy
// guard bound to a hash of the exact calldata.

interface IPOCERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IPOCMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IPOCMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

interface IPOCV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Solidly-fork router ABI (Aerodrome, Velodrome, ...). Single-hop Route[] here
/// since every arbitrage leg in this POC is a direct tokenIn->tokenOut swap.
interface IPOCAeroRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Proof of concept v2: Morpho flashloan followed by two swaps, each leg
/// independently either a Uniswap-V2-style router or a Solidly/Aerodrome-style router.
/// @dev Intentionally narrow, same as the v1 POC: no arbitrary-call path, must be
///      configured with explicit token/router/factory allowlists before use.
contract MorphoAtomicArbPOCv2 is IPOCMorphoFlashLoanCallback {
    enum RouterKind {
        V2,
        AERODROME
    }

    struct SwapLeg {
        address router;
        RouterKind kind;
        // Only read when kind == AERODROME. Leave false/address(0) for V2 legs.
        bool aeroStable;
        address aeroFactory;
    }

    struct ArbitrageParams {
        address loanToken;
        address intermediateToken;
        SwapLeg firstLeg;
        SwapLeg secondLeg;
        uint256 loanAmount;
        uint256 minIntermediateAmount;
        uint256 minFinalAmount;
        uint256 minProfit;
        uint256 deadline;
        address profitReceiver;
    }

    error Unauthorized();
    error Paused();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidRoute();
    error DeadlineExpired();
    error TokenNotAllowed();
    error RouterNotAllowed();
    error FactoryNotAllowed();
    error CallbackNotAllowed();
    error LoanStateMismatch();
    error InsufficientOutput();
    error InsufficientProfit();
    error ResidualIntermediateToken();
    error TokenCallFailed();

    address public immutable owner;
    address public immutable morpho;
    bool public paused;

    mapping(address token => bool allowed) public allowedToken;
    mapping(address router => bool allowed) public allowedRouter;
    mapping(address factory => bool allowed) public allowedAerodromeFactory;

    bool private loanActive;
    address private activeLoanToken;
    uint256 private activeLoanAmount;
    uint256 private activeBalanceBefore;
    bytes32 private activeRouteHash;

    event TokenAllowanceUpdated(address indexed token, bool allowed);
    event RouterAllowanceUpdated(address indexed router, bool allowed);
    event AerodromeFactoryAllowanceUpdated(address indexed factory, bool allowed);
    event PauseUpdated(bool paused);
    event ArbitrageExecuted(
        address indexed loanToken,
        address indexed intermediateToken,
        uint256 loanAmount,
        uint256 profit,
        address indexed profitReceiver
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(
        address morpho_,
        address[] memory initialTokens,
        address[] memory initialRouters,
        address[] memory initialAerodromeFactories
    ) {
        if (morpho_ == address(0)) revert InvalidAddress();
        owner = msg.sender;
        morpho = morpho_;

        for (uint256 i; i < initialTokens.length; ++i) {
            _setTokenAllowed(initialTokens[i], true);
        }
        for (uint256 i; i < initialRouters.length; ++i) {
            _setRouterAllowed(initialRouters[i], true);
        }
        for (uint256 i; i < initialAerodromeFactories.length; ++i) {
            _setAerodromeFactoryAllowed(initialAerodromeFactories[i], true);
        }
    }

    /// @notice Borrow, execute both swaps, repay Morpho, then transfer realized profit.
    function executeArbitrage(ArbitrageParams calldata params) external onlyOwner returns (uint256 profit) {
        if (paused) revert Paused();
        _validateParams(params);
        if (loanActive) revert LoanStateMismatch();

        uint256 balanceBefore = IPOCERC20(params.loanToken).balanceOf(address(this));
        bytes memory callbackData = abi.encode(params);

        loanActive = true;
        activeLoanToken = params.loanToken;
        activeLoanAmount = params.loanAmount;
        activeBalanceBefore = balanceBefore;
        activeRouteHash = keccak256(callbackData);

        IPOCMorpho(morpho).flashLoan(params.loanToken, params.loanAmount, callbackData);

        if (loanActive) revert LoanStateMismatch();
        uint256 balanceAfter = IPOCERC20(params.loanToken).balanceOf(address(this));
        if (balanceAfter < balanceBefore) revert InsufficientProfit();

        profit = balanceAfter - balanceBefore;
        if (profit < params.minProfit) revert InsufficientProfit();
        if (profit != 0) _safeTransfer(params.loanToken, params.profitReceiver, profit);

        emit ArbitrageExecuted(
            params.loanToken, params.intermediateToken, params.loanAmount, profit, params.profitReceiver
        );
    }

    /// @inheritdoc IPOCMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != morpho) revert CallbackNotAllowed();
        if (!loanActive || assets != activeLoanAmount || keccak256(data) != activeRouteHash) {
            revert LoanStateMismatch();
        }

        ArbitrageParams memory params = abi.decode(data, (ArbitrageParams));
        if (params.loanToken != activeLoanToken || params.loanAmount != assets) revert LoanStateMismatch();
        if (block.timestamp > params.deadline) revert DeadlineExpired();

        uint256 requiredBorrowedBalance = activeBalanceBefore + assets;
        if (IPOCERC20(params.loanToken).balanceOf(address(this)) < requiredBorrowedBalance) {
            revert LoanStateMismatch();
        }

        uint256 intermediateBefore = IPOCERC20(params.intermediateToken).balanceOf(address(this));
        _swap(
            params.firstLeg,
            params.loanToken,
            params.intermediateToken,
            assets,
            params.minIntermediateAmount,
            params.deadline
        );

        uint256 intermediateAfter = IPOCERC20(params.intermediateToken).balanceOf(address(this));
        if (intermediateAfter < intermediateBefore) revert InsufficientOutput();
        uint256 intermediateAmount = intermediateAfter - intermediateBefore;
        if (intermediateAmount < params.minIntermediateAmount) revert InsufficientOutput();

        _swap(
            params.secondLeg,
            params.intermediateToken,
            params.loanToken,
            intermediateAmount,
            params.minFinalAmount,
            params.deadline
        );

        if (IPOCERC20(params.intermediateToken).balanceOf(address(this)) != intermediateBefore) {
            revert ResidualIntermediateToken();
        }

        uint256 requiredFinalBalance = activeBalanceBefore + assets + params.minProfit;
        if (IPOCERC20(params.loanToken).balanceOf(address(this)) < requiredFinalBalance) {
            revert InsufficientProfit();
        }

        // Morpho pulls the exact principal after the callback returns.
        _forceApprove(params.loanToken, morpho, assets);
        _clearLoanState();
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        _setTokenAllowed(token, allowed);
    }

    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        _setRouterAllowed(router, allowed);
    }

    function setAerodromeFactoryAllowed(address factory, bool allowed) external onlyOwner {
        _setAerodromeFactoryAllowed(factory, allowed);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseUpdated(value);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (loanActive || to == address(0)) revert LoanStateMismatch();
        _safeTransfer(token, to, amount);
    }

    function _validateParams(ArbitrageParams calldata params) private view {
        if (
            params.loanToken == address(0) || params.intermediateToken == address(0)
                || params.firstLeg.router == address(0) || params.secondLeg.router == address(0)
                || params.profitReceiver == address(0)
        ) revert InvalidAddress();
        if (params.loanAmount == 0) revert InvalidAmount();
        if (params.loanToken == params.intermediateToken || params.firstLeg.router == params.secondLeg.router) {
            revert InvalidRoute();
        }
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (!allowedToken[params.loanToken] || !allowedToken[params.intermediateToken]) {
            revert TokenNotAllowed();
        }
        if (!allowedRouter[params.firstLeg.router] || !allowedRouter[params.secondLeg.router]) {
            revert RouterNotAllowed();
        }
        _validateLegFactory(params.firstLeg);
        _validateLegFactory(params.secondLeg);
    }

    function _validateLegFactory(SwapLeg calldata leg) private view {
        if (leg.kind == RouterKind.AERODROME) {
            if (leg.aeroFactory == address(0) || !allowedAerodromeFactory[leg.aeroFactory]) {
                revert FactoryNotAllowed();
            }
        }
    }

    function _swap(
        SwapLeg memory leg,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) private {
        _forceApprove(tokenIn, leg.router, amountIn);
        if (leg.kind == RouterKind.V2) {
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            IPOCV2Router(leg.router).swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline);
        } else {
            IPOCAeroRouter.Route[] memory routes = new IPOCAeroRouter.Route[](1);
            routes[0] =
                IPOCAeroRouter.Route({ from: tokenIn, to: tokenOut, stable: leg.aeroStable, factory: leg.aeroFactory });
            IPOCAeroRouter(leg.router).swapExactTokensForTokens(amountIn, amountOutMin, routes, address(this), deadline);
        }
        _forceApprove(tokenIn, leg.router, 0);
    }

    function _setTokenAllowed(address token, bool allowed) private {
        if (token == address(0)) revert InvalidAddress();
        allowedToken[token] = allowed;
        emit TokenAllowanceUpdated(token, allowed);
    }

    function _setRouterAllowed(address router, bool allowed) private {
        if (router == address(0)) revert InvalidAddress();
        allowedRouter[router] = allowed;
        emit RouterAllowanceUpdated(router, allowed);
    }

    function _setAerodromeFactoryAllowed(address factory, bool allowed) private {
        if (factory == address(0)) revert InvalidAddress();
        allowedAerodromeFactory[factory] = allowed;
        emit AerodromeFactoryAllowanceUpdated(factory, allowed);
    }

    function _clearLoanState() private {
        loanActive = false;
        activeLoanToken = address(0);
        activeLoanAmount = 0;
        activeBalanceBefore = 0;
        activeRouteHash = bytes32(0);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory result) = token.call(abi.encodeCall(IPOCERC20.transfer, (to, amount)));
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenCallFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (_tryApprove(token, spender, amount)) return;
        if (!_tryApprove(token, spender, 0) || !_tryApprove(token, spender, amount)) revert TokenCallFailed();
    }

    function _tryApprove(address token, address spender, uint256 amount) private returns (bool) {
        (bool success, bytes memory result) = token.call(abi.encodeCall(IPOCERC20.approve, (spender, amount)));
        return success && (result.length == 0 || (result.length == 32 && abi.decode(result, (bool))));
    }
}
