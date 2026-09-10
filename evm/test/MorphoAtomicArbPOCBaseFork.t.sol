// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Fork test for MorphoAtomicArbPOC against REAL Base mainnet state.
//
// Goal: prove the atomic borrow -> swap -> swap -> repay -> profit flow works against
// real Morpho Blue bytecode, real WETH/USDC, and real Uniswap V2 / Sushi V2 routers on
// Base - not just the mock routers used in MorphoAtomicArbPOC.t.sol.
//
// This is a LOCAL SIMULATION ONLY. No real transaction is broadcast, no real funds are
// spent. It forks Base at whatever block your RPC returns and runs entirely in memory.
//
// >>> VERIFY EVERY ADDRESS BELOW ON BASESCAN BEFORE TRUSTING THIS FILE <<<
// I (Claude) cross-checked these against the repo's own deployments.json/stablecoins.json
// and BaseScan search results, but I do not have RPC or Foundry access in the sandbox I
// wrote this in, so I could not execute this test myself. Run test_PairsExistOnBothRouters
// FIRST, in isolation - if it fails, the router/pair addresses below need adjusting before
// anything else in this file means anything.
//
// AUDIT NOTE (2026-09-10): the original SUSHI_V2_ROUTER value here was wrong on Base and
// is why test_PairsExistOnBothRouters reverted on factory() for a real run - see the
// constant below for the corrected address and how it was verified. Separately, live
// Base liquidity data (GeckoTerminal, checked same day) shows the classic SushiSwap V2
// WETH/USDC pool on Base is extremely thin (~$4k TVL) next to Uniswap V2's (~$9.6M) -
// roughly a 2,000x gap. test_CapturesRealImbalanceAcrossUniswapAndSushi was rewritten to
// size every trade off *live* on-chain reserves instead of fixed dollar amounts, and to
// dump into/buy from the shallow venue (Sushi) before clearing through the deep one
// (Uniswap) - the original fixed-5,000-USDC version would still fail the profitability
// assertion even with the router address fixed, because 5,000 USDC is ~2,000% of Sushi's
// entire pool. Re-run test_PairsExistOnBothRouters after pulling this file to confirm
// today's real reserves before trusting any of the numbers below.
//
// AUDIT NOTE (2026-09-10, cont.): test_RevertsWhenMinProfitUnrealistic previously used
// minProfit: type(uint256).max to force a guaranteed-unreachable profit target. That
// value overflows `activeBalanceBefore + assets + params.minProfit` inside
// MorphoAtomicArbPOC.executeArbitrage, which reverts with a generic Panic(0x11) instead
// of the intended InsufficientProfit() custom error - confirmed via the Termux test run
// (trace showed the revert happening on that addition, right after both real swaps and
// the balance checks had already succeeded). Not a fund-loss issue either way - the
// whole call still reverts atomically and onlyOwner already restricts who can trigger it
// - but it meant this test wasn't actually exercising the revert path it claimed to.
// Fixed by using loanAmount * 1_000_000 instead: still unreachable, but far below the
// point where the addition overflows.
//
// Setup (run once in your morpho-toolkit clone):
//   cd evm
//   forge install foundry-rs/forge-std --no-commit
//   echo 'forge-std/=lib/forge-std/src/' >> remappings.txt
//   export BASE_RPC_URL=https://<your-base-rpc>      # see docs/EVM-RPCS.md for providers
//
// Run:
//   forge test --match-path test/MorphoAtomicArbPOCBaseFork.t.sol -vvv
//
// Run just the sanity check first:
//   forge test --match-test test_PairsExistOnBothRouters -vvv

import {Test, console2} from "forge-std/Test.sol";
import {MorphoAtomicArbPOC} from "../src/poc/MorphoAtomicArbPOC.sol";

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

contract MorphoAtomicArbPOCBaseForkTest is Test {
    // ---- Base mainnet addresses (chainId 8453) ----
    // Morpho + USDC: taken directly from this repo's evm/deployments.json ("base" entry,
    // status "deployed-and-live-flashloan-verified") and evm/stablecoins.json.
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    // Canonical OP-stack WETH predeploy, identical on every OP-stack chain incl. Base.
    address constant WETH = 0x4200000000000000000000000000000000000006;
    // Matches docs.uniswap.org's v2-deployments page and the address seen live in the
    // Termux test run (factory() succeeded, real WETH/USDC pair returned). No change needed.
    address constant UNISWAP_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    // CORRECTED. The old value (0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506) *is* Sushi's
    // V2 Router on Polygon/Arbitrum/BSC/Ethereum/Fantom (same deployer, deterministic
    // address), but on Base that exact address is a completely different, unrelated
    // unverified contract (an old NFT-descriptor-style contract, not a router at all) -
    // that's why factory() reverted. The real address below is pulled straight from
    // SushiSwap's own deployments repo (github.com/sushiswap/v2-core, deployments/base/
    // UniswapV2Router02.json) and independently confirmed as "Sushi: Router v2" (verified
    // contract) on basescan.org.
    address constant SUSHI_V2_ROUTER = 0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;

    address constant PROFIT_RECEIVER = address(0xFEED);
    uint256 constant MIN_USABLE_RESERVE = 0.1 ether; // below this, pool is too thin to trust

    MorphoAtomicArbPOC poc;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));

        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;
        address[] memory routers = new address[](2);
        routers[0] = UNISWAP_V2_ROUTER;
        routers[1] = SUSHI_V2_ROUTER;

        // Deployed here, so this test contract is `owner` for onlyOwner-gated calls below.
        poc = new MorphoAtomicArbPOC(MORPHO, tokens, routers);
    }

    /// Run this one first, alone. It only reads on-chain state - proves a WETH/USDC pair
    /// really exists with real reserves on both routers before anything else is trusted.
    function test_PairsExistOnBothRouters() public {
        _wethReserve(UNISWAP_V2_ROUTER, "Uniswap V2");
        _wethReserve(SUSHI_V2_ROUTER, "Sushi V2");
    }

    /// The core proof. Steps:
    ///  1. Read both pools' REAL, LIVE reserves - Sushi's Base pool is ~2,000x shallower
    ///     than Uniswap's right now (checked via GeckoTerminal the same day this was
    ///     written: ~$4k vs ~$9.6M), so every amount below is derived as a fraction of
    ///     the live reserves instead of a fixed dollar figure. A fixed 5,000 USDC loan
    ///     would be ~2,000% of Sushi's entire pool and would fail no matter which router
    ///     address is used - this is a sizing problem, not just an address problem.
    ///  2. Simulate a whale dumping WETH into the SHALLOW pool (Sushi) via a REAL swap
    ///     call - a modest absolute size still moves a thin pool a lot, which is exactly
    ///     what makes small-pool venues attractive (and risky) arb targets in the wild.
    ///  3. Quote both legs on-chain (getAmountsOut): buy the now-cheap WETH on Sushi,
    ///     then clear it through Uniswap's deep pool, where the sell leg barely moves the
    ///     price and doesn't eat the profit from the first leg.
    ///  4. Call executeArbitrage and verify Morpho gets repaid and PROFIT_RECEIVER is paid
    ///     real USDC - all against real Base mainnet bytecode, not mocks.
    function test_CapturesRealImbalanceAcrossUniswapAndSushi() public {
        (uint256 sushiWethReserve, uint256 sushiUsdcReserve) = _reserves(SUSHI_V2_ROUTER, "Sushi V2");
        _wethReserve(UNISWAP_V2_ROUTER, "Uniswap V2"); // just re-confirm the deep pool is healthy too

        // --- Step 2: manufacture a real imbalance on the shallow venue ---
        address whale = address(0xB0B);
        uint256 dumpAmount = sushiWethReserve * 20 / 100; // 20% of THIS pool's depth, not
        // the deep pool's - sizing off the wrong pool is exactly what broke the original.
        deal(WETH, whale, dumpAmount);

        vm.startPrank(whale);
        IERC20Min(WETH).approve(SUSHI_V2_ROUTER, dumpAmount);
        address[] memory dumpPath = new address[](2);
        dumpPath[0] = WETH;
        dumpPath[1] = USDC;
        IV2Router(SUSHI_V2_ROUTER).swapExactTokensForTokens(dumpAmount, 0, dumpPath, whale, block.timestamp);
        vm.stopPrank();

        console2.log("Whale dumped WETH into Sushi V2:", dumpAmount);

        // --- Step 3: size the round trip off Sushi's own (pre-dump) USDC depth ---
        uint256 loanAmount = sushiUsdcReserve * 10 / 100; // 10% of Sushi's own liquidity -
        // small enough that the buy leg doesn't dominate the pool on top of the dump.
        require(loanAmount > 0, "Sushi pool too thin to size a loan - pick a deeper pair");

        uint256 wethOut = _quote(SUSHI_V2_ROUTER, USDC, WETH, loanAmount);
        uint256 usdcBack = _quote(UNISWAP_V2_ROUTER, WETH, USDC, wethOut);

        console2.log("Loan (USDC, 6dp):", loanAmount);
        console2.log("WETH bought on Sushi:", wethOut);
        console2.log("USDC back from Uniswap:", usdcBack);

        assertGt(usdcBack, loanAmount, "no real opportunity created - increase dump size or pick a different pair");

        uint256 expectedProfit = usdcBack - loanAmount;
        uint256 minProfit = expectedProfit / 2; // buffer for the block(s) between quote and execution

        MorphoAtomicArbPOC.ArbitrageParams memory params = MorphoAtomicArbPOC.ArbitrageParams({
            loanToken: USDC,
            intermediateToken: WETH,
            firstRouter: SUSHI_V2_ROUTER,
            secondRouter: UNISWAP_V2_ROUTER,
            loanAmount: loanAmount,
            minIntermediateAmount: wethOut * 995 / 1000,
            minFinalAmount: usdcBack * 995 / 1000,
            minProfit: minProfit,
            deadline: block.timestamp + 300,
            profitReceiver: PROFIT_RECEIVER
        });

        // --- Step 4: execute and verify ---
        uint256 receiverBefore = IERC20Min(USDC).balanceOf(PROFIT_RECEIVER);
        uint256 profit = poc.executeArbitrage(params);

        assertGe(profit, minProfit, "profit below the minimum we required");
        assertEq(IERC20Min(USDC).balanceOf(PROFIT_RECEIVER) - receiverBefore, profit, "profit not paid out correctly");
        assertEq(IERC20Min(USDC).balanceOf(address(poc)), 0, "loan-token dust left in contract");

        console2.log("Captured profit (USDC, 6dp):", profit);
    }

    /// Safety invariant: if the required profit can't realistically be met, the whole
    /// transaction must revert - never partially execute or lose the borrowed principal.
    function test_RevertsWhenMinProfitUnrealistic() public {
        MorphoAtomicArbPOC.ArbitrageParams memory params = MorphoAtomicArbPOC.ArbitrageParams({
            loanToken: USDC,
            intermediateToken: WETH,
            firstRouter: UNISWAP_V2_ROUTER,
            secondRouter: SUSHI_V2_ROUTER,
            loanAmount: 1_000e6,
            minIntermediateAmount: 0,
            minFinalAmount: 0,
            // 1,000,000x the loan amount: impossible to satisfy, but small enough not to
            // overflow `activeBalanceBefore + assets + minProfit` inside the contract -
            // type(uint256).max here previously tripped a Panic(0x11) overflow instead of
            // the intended InsufficientProfit() revert (see AUDIT NOTE below).
            minProfit: loanAmount * 1_000_000,
            deadline: block.timestamp + 300,
            profitReceiver: PROFIT_RECEIVER
        });

        vm.expectRevert(MorphoAtomicArbPOC.InsufficientProfit.selector);
        poc.executeArbitrage(params);
    }

    /// Access-control guard: only the deploying owner may trigger an arbitrage call.
    function test_RevertsForNonOwnerCaller() public {
        MorphoAtomicArbPOC.ArbitrageParams memory params = MorphoAtomicArbPOC.ArbitrageParams({
            loanToken: USDC,
            intermediateToken: WETH,
            firstRouter: UNISWAP_V2_ROUTER,
            secondRouter: SUSHI_V2_ROUTER,
            loanAmount: 1,
            minIntermediateAmount: 0,
            minFinalAmount: 0,
            minProfit: 0,
            deadline: block.timestamp + 300,
            profitReceiver: PROFIT_RECEIVER
        });

        vm.prank(address(0xDEAD));
        vm.expectRevert(MorphoAtomicArbPOC.Unauthorized.selector);
        poc.executeArbitrage(params);
    }

    /// Allowlist guard: a de-allowlisted router must be rejected before any funds move.
    function test_RevertsWhenRouterNotAllowlisted() public {
        poc.setRouterAllowed(SUSHI_V2_ROUTER, false);

        MorphoAtomicArbPOC.ArbitrageParams memory params = MorphoAtomicArbPOC.ArbitrageParams({
            loanToken: USDC,
            intermediateToken: WETH,
            firstRouter: UNISWAP_V2_ROUTER,
            secondRouter: SUSHI_V2_ROUTER,
            loanAmount: 1,
            minIntermediateAmount: 0,
            minFinalAmount: 0,
            minProfit: 0,
            deadline: block.timestamp + 300,
            profitReceiver: PROFIT_RECEIVER
        });

        vm.expectRevert(MorphoAtomicArbPOC.RouterNotAllowed.selector);
        poc.executeArbitrage(params);
    }

    // ---- helpers ----

    function _wethReserve(address router, string memory label) internal view returns (uint256 wethReserve) {
        (wethReserve,) = _reserves(router, label);
    }

    /// Same lookup as _wethReserve, but also returns the USDC side - used to size trades
    /// as a fraction of a pool's own live depth instead of a fixed dollar amount, which is
    /// what let this test silently assume Sushi and Uniswap have comparable liquidity on
    /// Base when in reality they can differ by orders of magnitude.
    function _reserves(address router, string memory label)
        internal
        view
        returns (uint256 wethReserve, uint256 usdcReserve)
    {
        address factory = IV2Router(router).factory();
        address pair = IV2Factory(factory).getPair(WETH, USDC);
        require(pair != address(0), string.concat(label, ": no WETH/USDC pair on this router - pick a different one"));

        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        address token0 = IV2Pair(pair).token0();
        if (token0 == WETH) {
            (wethReserve, usdcReserve) = (uint256(r0), uint256(r1));
        } else {
            (wethReserve, usdcReserve) = (uint256(r1), uint256(r0));
        }

        console2.log(label, "pair:", pair);
        console2.log(label, "WETH reserve:", wethReserve);
        console2.log(label, "USDC reserve:", usdcReserve);
        require(wethReserve > MIN_USABLE_RESERVE, string.concat(label, ": pool too thin to trust for this test"));
    }

    function _quote(address router, address tokenIn, address tokenOut, uint256 amountIn)
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
}
