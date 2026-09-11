// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Fork test for MorphoAtomicArbPOCv2 against REAL Base mainnet state - specifically
// exercising the NEW capability over MorphoAtomicArbPOCBaseFork.t.sol: one leg routed
// through a Solidly/Aerodrome-style router instead of a Uniswap-V2-style one.
//
// Same LOCAL SIMULATION ONLY caveat as the v1 fork test: no real transaction is
// broadcast, no real funds are spent, this forks Base at whatever block your RPC
// returns and runs entirely in memory.
//
// Every address below (Morpho, USDC, WETH, Sushi V2 router, Aerodrome PoolFactory) is
// reused unchanged from MorphoAtomicArbPOCBaseFork.t.sol and tools/src/arb/routes.ts -
// both already independently verified against real on-chain state (the v1 fork test's
// successful profit capture, and dozens of real `arb-scan` runs that read sane
// Aerodrome prices every time). I (Claude) still do not have RPC or Foundry access in
// the sandbox I wrote this in, so I could not execute this file myself - run
// test_AerodromePoolExists FIRST, in isolation, before trusting the rest.
//
// Setup identical to the v1 fork test (run once in your morpho-toolkit clone):
//   cd evm
//   forge install foundry-rs/forge-std --no-commit   # skip if already installed
//   export BASE_RPC_URL=https://<your-base-rpc>
//
// Run:
//   forge test --match-path test/MorphoAtomicArbPOCv2BaseFork.t.sol -vvv
//
// Run just the sanity check first:
//   forge test --match-test test_AerodromePoolExists -vvv

import {Test, console2} from "forge-std/Test.sol";
import {MorphoAtomicArbPOCv2} from "../src/poc/MorphoAtomicArbPOCv2.sol";

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IV2Router {
    function factory() external pure returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
}

interface IAeroFactory {
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool);
}

interface IAeroPool {
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function token0() external view returns (address);
}

contract MorphoAtomicArbPOCv2BaseForkTest is Test {
    // ---- Base mainnet addresses (chainId 8453) - all reused, unchanged, from the v1 ----
    // ---- fork test and tools/src/arb/routes.ts. See those for how each was verified. ----
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant UNISWAP_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant SUSHI_V2_ROUTER = 0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;
    address constant AERODROME_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    // Aerodrome's actual Router contract (not just the factory) - needed here because,
    // unlike the read-only tools/arb-scan, this test actually calls swapExactTokensForTokens.
    // Cross-checked against Aerodrome's own substreams indexing package (substreams.dev),
    // which lists this address alongside AERODROME_FACTORY and the AERO token address -
    // both of which are independently confirmed correct via dozens of real arb-scan runs
    // against live RPC. Same "will fail cleanly if wrong" posture as every other address
    // in this file either way: test_AerodromePoolExists doesn't touch this one, only the
    // factory, so if it's still wrong somehow it would only surface as a clean revert in
    // the second test, not a fund-loss issue (this is a local fork simulation).
    address constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;

    address constant PROFIT_RECEIVER = address(0xFEED);
    uint256 constant MIN_USABLE_RESERVE = 0.1 ether;

    MorphoAtomicArbPOCv2 poc;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));

        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;
        address[] memory routers = new address[](3);
        routers[0] = UNISWAP_V2_ROUTER;
        routers[1] = SUSHI_V2_ROUTER;
        routers[2] = AERODROME_ROUTER;
        address[] memory factories = new address[](1);
        factories[0] = AERODROME_FACTORY;

        poc = new MorphoAtomicArbPOCv2(MORPHO, tokens, routers, factories);
    }

    /// Run this one first, alone. Read-only - proves the Aerodrome factory address
    /// resolves a real WETH/USDC volatile pool with real reserves before anything else
    /// in this file is trusted.
    function test_AerodromePoolExists() public {
        _aeroWethReserve("Aerodrome (volatile)");
    }

    /// Same manufactured-imbalance technique as MorphoAtomicArbPOCBaseFork.t.sol's
    /// test_CapturesRealImbalanceAcrossUniswapAndSushi, but the sell leg now goes through
    /// Aerodrome instead of Uniswap V2 - this is what actually exercises the new
    /// RouterKind.AERODROME dispatch path against real bytecode instead of a mock.
    /// Steps: dump WETH into Sushi's shallow pool (real swap) -> buy the now-cheap WETH
    /// back via Sushi (V2 leg) -> sell it via Aerodrome (AERODROME leg) -> verify Morpho
    /// is repaid and PROFIT_RECEIVER is paid real USDC.
    function test_CapturesImbalanceSellingThroughAerodrome() public {
        (uint256 sushiWethReserve, uint256 sushiUsdcReserve) = _v2Reserves(SUSHI_V2_ROUTER, "Sushi V2");
        _aeroWethReserve("Aerodrome (volatile)"); // re-confirm the Aerodrome leg is healthy too

        address whale = address(0xB0B);
        uint256 dumpAmount = sushiWethReserve * 20 / 100;
        deal(WETH, whale, dumpAmount);

        vm.startPrank(whale);
        IERC20Min(WETH).approve(SUSHI_V2_ROUTER, dumpAmount);
        address[] memory dumpPath = new address[](2);
        dumpPath[0] = WETH;
        dumpPath[1] = USDC;
        IV2Router(SUSHI_V2_ROUTER).swapExactTokensForTokens(dumpAmount, 0, dumpPath, whale, block.timestamp);
        vm.stopPrank();

        console2.log("Whale dumped WETH into Sushi V2:", dumpAmount);

        uint256 loanAmount = sushiUsdcReserve * 10 / 100;
        require(loanAmount > 0, "Sushi pool too thin to size a loan");

        uint256 wethOut = _quoteV2(SUSHI_V2_ROUTER, USDC, WETH, loanAmount);
        uint256 usdcBack = _quoteAero(WETH, USDC, wethOut);

        console2.log("Loan (USDC, 6dp):", loanAmount);
        console2.log("WETH bought on Sushi:", wethOut);
        console2.log("USDC back from Aerodrome:", usdcBack);

        assertGt(usdcBack, loanAmount, "no real opportunity created - increase dump size");

        uint256 expectedProfit = usdcBack - loanAmount;
        uint256 minProfit = expectedProfit / 2;

        MorphoAtomicArbPOCv2.ArbitrageParams memory params = MorphoAtomicArbPOCv2.ArbitrageParams({
            loanToken: USDC,
            intermediateToken: WETH,
            firstLeg: MorphoAtomicArbPOCv2.SwapLeg({
                router: SUSHI_V2_ROUTER,
                kind: MorphoAtomicArbPOCv2.RouterKind.V2,
                aeroStable: false,
                aeroFactory: address(0)
            }),
            secondLeg: MorphoAtomicArbPOCv2.SwapLeg({
                router: AERODROME_ROUTER,
                kind: MorphoAtomicArbPOCv2.RouterKind.AERODROME,
                aeroStable: false,
                aeroFactory: AERODROME_FACTORY
            }),
            loanAmount: loanAmount,
            minIntermediateAmount: wethOut * 995 / 1000,
            minFinalAmount: usdcBack * 995 / 1000,
            minProfit: minProfit,
            deadline: block.timestamp + 300,
            profitReceiver: PROFIT_RECEIVER
        });

        uint256 receiverBefore = IERC20Min(USDC).balanceOf(PROFIT_RECEIVER);
        uint256 profit = poc.executeArbitrage(params);

        assertGe(profit, minProfit, "profit below the minimum we required");
        assertEq(IERC20Min(USDC).balanceOf(PROFIT_RECEIVER) - receiverBefore, profit, "profit not paid out correctly");
        assertEq(IERC20Min(USDC).balanceOf(address(poc)), 0, "loan-token dust left in contract");

        console2.log("Captured profit via Aerodrome leg (USDC, 6dp):", profit);
    }

    /// New-in-v2 guard: an Aerodrome leg pointed at a factory the owner never
    /// allowlisted must revert before any funds move, even if the router address itself
    /// is allowlisted and would otherwise resolve a real pool.
    function test_RevertsWhenAerodromeFactoryNotAllowlisted() public {
        poc.setAerodromeFactoryAllowed(AERODROME_FACTORY, false);

        MorphoAtomicArbPOCv2.ArbitrageParams memory params = MorphoAtomicArbPOCv2.ArbitrageParams({
            loanToken: USDC,
            intermediateToken: WETH,
            firstLeg: MorphoAtomicArbPOCv2.SwapLeg({
                router: SUSHI_V2_ROUTER,
                kind: MorphoAtomicArbPOCv2.RouterKind.V2,
                aeroStable: false,
                aeroFactory: address(0)
            }),
            secondLeg: MorphoAtomicArbPOCv2.SwapLeg({
                router: AERODROME_ROUTER,
                kind: MorphoAtomicArbPOCv2.RouterKind.AERODROME,
                aeroStable: false,
                aeroFactory: AERODROME_FACTORY
            }),
            loanAmount: 1,
            minIntermediateAmount: 0,
            minFinalAmount: 0,
            minProfit: 0,
            deadline: block.timestamp + 300,
            profitReceiver: PROFIT_RECEIVER
        });

        vm.expectRevert(MorphoAtomicArbPOCv2.FactoryNotAllowed.selector);
        poc.executeArbitrage(params);
    }

    /// Same safety invariant as the v1 fork test: an unreachable profit target must
    /// revert the whole call, never partially execute.
    function test_RevertsWhenMinProfitUnrealistic() public {
        MorphoAtomicArbPOCv2.ArbitrageParams memory params = MorphoAtomicArbPOCv2.ArbitrageParams({
            loanToken: USDC,
            intermediateToken: WETH,
            firstLeg: MorphoAtomicArbPOCv2.SwapLeg({
                router: SUSHI_V2_ROUTER,
                kind: MorphoAtomicArbPOCv2.RouterKind.V2,
                aeroStable: false,
                aeroFactory: address(0)
            }),
            secondLeg: MorphoAtomicArbPOCv2.SwapLeg({
                router: AERODROME_ROUTER,
                kind: MorphoAtomicArbPOCv2.RouterKind.AERODROME,
                aeroStable: false,
                aeroFactory: AERODROME_FACTORY
            }),
            loanAmount: 1_000e6,
            minIntermediateAmount: 0,
            minFinalAmount: 0,
            minProfit: 1_000e6 * 1_000_000, // unreachable, well below the overflow boundary
            deadline: block.timestamp + 300,
            profitReceiver: PROFIT_RECEIVER
        });

        vm.expectRevert(MorphoAtomicArbPOCv2.InsufficientProfit.selector);
        poc.executeArbitrage(params);
    }

    // ---- helpers ----

    function _v2Reserves(address router, string memory label)
        internal
        view
        returns (uint256 wethReserve, uint256 usdcReserve)
    {
        address factory = IV2Router(router).factory();
        address pair = IV2Factory(factory).getPair(WETH, USDC);
        require(pair != address(0), string.concat(label, ": no WETH/USDC pair"));

        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        address token0 = IV2Pair(pair).token0();
        (wethReserve, usdcReserve) = token0 == WETH ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        console2.log(label, "WETH reserve:", wethReserve);
        console2.log(label, "USDC reserve:", usdcReserve);
        require(wethReserve > MIN_USABLE_RESERVE, string.concat(label, ": pool too thin to trust"));
    }

    function _aeroWethReserve(string memory label) internal view returns (uint256 wethReserve) {
        address pool = IAeroFactory(AERODROME_FACTORY).getPool(WETH, USDC, false);
        require(pool != address(0), string.concat(label, ": no WETH/USDC volatile pool - check AERODROME_FACTORY"));

        (uint256 r0, uint256 r1,) = IAeroPool(pool).getReserves();
        address token0 = IAeroPool(pool).token0();
        wethReserve = token0 == WETH ? r0 : r1;

        console2.log(label, "pool:", pool);
        console2.log(label, "WETH reserve:", wethReserve);
        require(wethReserve > MIN_USABLE_RESERVE, string.concat(label, ": pool too thin to trust"));
    }

    function _quoteV2(address router, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (uint256)
    {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256[] memory amounts = IV2Router(router).getAmountsOut(amountIn, path);
        return amounts[1];
    }

    /// Quotes a single-hop Aerodrome swap the same way MorphoAtomicArbPOCv2 executes it:
    /// via the real Router's getAmountsOut(uint256,Route[]), not a hand-rolled formula,
    /// so this test's expectations track whatever the real Router actually does.
    function _quoteAero(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        IAeroRouterQuote.Route[] memory routes = new IAeroRouterQuote.Route[](1);
        routes[0] = IAeroRouterQuote.Route({from: tokenIn, to: tokenOut, stable: false, factory: AERODROME_FACTORY});
        uint256[] memory amounts = IAeroRouterQuote(AERODROME_ROUTER).getAmountsOut(amountIn, routes);
        return amounts[amounts.length - 1];
    }
}

interface IAeroRouterQuote {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function getAmountsOut(uint256 amountIn, Route[] memory routes) external view returns (uint256[] memory amounts);
}
