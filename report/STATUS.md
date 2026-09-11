# Morpho-toolkit — status report

**Repo:** `git@github.com:Rndynt/morpho-toolkit.git` (fork of `FlipZ3ro/morpho-toolkit`)
**Date:** 2026-09-11
**Branch / HEAD at write-up:** `main` @ `f5441fb`
**Audience:** operator + next agent (Claude). Read this before changing scanner or deploying.

This is a working-capital bot project, not a classroom lab. Goal: **Morpho flashloan → two DEX legs → repay + keep profit**, atomically. That goal is **not live**.

## 1. Stated goal

Atomic arbitrage funded by Morpho Blue flashloan on **Base (8453)** and **Robinhood Chain (4663)**.

Required loop: discover Morpho-lendable tokens → find ≥2 liquid venues → size loan vs fees/impact/gas → encode executor that may profit → eth_call → broadcast.

Public `FlipZ3ro/morpho-toolkit` live `FlashLoanExecutor` is a **no-op** (profit reverts). Paying RH bot is `FlipZ3ro/RobinArb` (curve ↔ V4, ETH inventory), not Morpho.

## 2. Two layers

| Layer | Path | Role | Moves funds? |
|---|---|---|---|
| Eyes | `tools/` | RPC reads, Morpho API, math | No |
| Hands | `evm/` | Contracts + fork tests | Only after deploy + broadcast |

| Contract | Live? | Can keep profit? |
|---|---|---|
| `FlashLoanExecutor.sol` | Yes Base+RH | **No.** No-op. |
| `MorphoAtomicArbPOC.sol` | No | V2-style legs only |
| `MorphoAtomicArbPOCv2.sol` | **Not deployed** | Yes in fork tests (V2 or Aero + minProfit) |

`scan-morpho.ts` is the scan that was run. `cli.ts arb-scan` is still the old 5-pair path. `plan.ts` is not wired to broadcast.

## 3. Commits

| SHA | What |
|---|---|
| `8951e2b` | POC v2 BaseFork minProfit compile fix |
| operator forge | Fork tests PASS on publicnode (~50 USDC capture after scripted dump) |
| `0e14356` | discover.ts only; CLI flags were no-ops |
| `2c81b0c` / `da9a225` | scan-morpho.ts + tables |
| `f5441fb` | Expanded Morpho pairs injected into v2Pairs/solidlyPairs |

## 4. Latest Base scan (block 51167681)

25 Morpho assets ≥ $10k → 47 pairs attempted. Quoted ≥2 venues: 7 pairs / 21 rows.

| Pair | Spot | Fillable? |
|---|---|---|
| USDC/WETH | ~0.2% | No. Fees 60 bps. |
| WETH/cbBTC | Sushi +0.37% | No after impact |
| USDC/AERO | Uni −1.34% / Sushi +1.09% | Gross < 0.01 |
| WETH/AERO | < 0.7% | No |
| WETH/cbETH | < 0.4% | No |
| WETH/wstETH | Uni **+23.7%** vs ~1.24 | **Dust book, not an edge** |
| WETH/VVV | Uni −5.8% / Aero +4.1% | Still < 0.01 after impact |

RH earlier: Uni USDG/WETH ~$1.16M vs Froth **$0.13** at −22%. Optimizer 0. Correct.

**Live executable edge this session: none.** Fork ~50 USDC was test-injected.

## 5. Defects still on main

- `scanner.ts` drops V2 set unless **two** V2 routers resolve (Uni-only + Aero can vanish).
- TVL filter not in origin `scanner.ts`.
- `cli.ts` arb-scan stale.
- No Sync listener.

## 6. Blockers

POC v2 not deployed. Live executor reverts on profit. No V3/V4/curve legs. Dust still looks like +23% to a human.

## 7. Next (order)

1. Patch scanner.ts: allow one V2 venue; print/drop TVL < $1k.
2. Check Uni WETH/wstETH and WETH/VVV reserves; blacklist dust.
3. Deploy POC v2 only after eth_call on a real book (`plan.ts`).
4. Sync listener on thin side vs deep Aero.
5. RH: port RobinArb discovery or drop RH from Morpho-V2 story.

## 8. Commands

From repo root:

```bash
git pull && cd tools && npx tsx src/arb/scan-morpho.ts --chain base
git pull && cd tools && npx tsx src/arb/scan-morpho.ts --chain robinhood
```

## 9. Verdict

Flashloan primitive works. Arb loop does not. Expanded Morpho top-25 Base scan found no sizeable two-venue V2/Aero fill at that block.
