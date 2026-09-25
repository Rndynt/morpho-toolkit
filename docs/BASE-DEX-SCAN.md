# Base DEX scanner (read-only)

`cd tools && npm run cli -- arb-scan --chain base`

Base now defaults to DEX-driven discovery, not Morpho inventory. Reads Aerodrome factory first/latest pool indices (default total cap 80), discovers token identities on chain, excludes stable symbols, then resolves WETH counter-pools for each eligible token (default cap 30). Morpho WETH balance limits **only loan size**. No intermediate balance requirement, no Cartesian token catalogue expansion.

```sh
npm run cli -- arb-scan --chain base --pool-limit 40 --token-limit 16 --concurrency 2 --max-seconds 300 --report ../report/base-dex-scan.json
```

Flags: `--amounts-raw 1000000000000000,10000000000000000` (WETH wei), `--read-rpc URL` (optional explicit single read provider), `--json`, `--watch --interval 20`. Timeout budget stops starting new reads; in-flight bounded RPC retries can finish later. Public RPCs have intermittent failures. `--legacy-scan` explicitly restores old scanner; other chains unchanged. `arb-plan`/`arb-execute` continue using the old guarded executable scanner; this new report is **not** a transaction plan.

## Actual coverage

- Uniswap V2, Sushi V2 router `getAmountsOut`.
- Aerodrome stable/volatile router `getAmountsOut`, never reserve-ratio pricing.
- Uniswap V3 QuoterV2, fees 100/500/3000/10000.
- Initial Aerodrome Slipstream QuoterV2, tick spacings 1/10/50/100/200.
- Both directions, distinct pools, exact first-leg output fed to second leg at one block; zero output rejected. Pool fees/impact are embedded in on-chain quotes.
- Atomic JSON checkpoint after every token; all discovered tokens, source pools, found counter-pools, every attempted route, negative results, skipped loan sizes, RPC/metadata failures included.

JSON-RPC HTTP batching intentionally disabled after live endpoints rejected/timed out batches. Worker pool bounds independent reads. Endpoint chain ID checked before use; transport failover handles subsequent read failures. URLs/raw RPC errors never persisted.

## Limits / fail-closed

Not all Base pools: factory sample only; discovery currently starts from Solidly factory, so CL-only tokens absent from that sample are missed. WETH-only loan anchor; no arbitrary token-token or multihop routes. Stable-symbol exclusion is heuristic, not a complete token classification registry. New Slipstream factories, V4, Curve, Balancer unsupported.

All estimates `executable:false`: unknown token transfer behavior not simulated. Deployed POC V2 cannot execute CL; existing adapters only encode legacy V3 / Slipstream calldata, not a validated production executor. Gas estimate 600000 units; `netBeforeL1FeeRaw` excludes L1 data fee/slippage/MEV, **not net profit**. No signer/broadcast; `--broadcast` rejected. No profitable/executable claim follows from a positive gross quote. Snapshot hash checked again at completion; failed/partial runs must not be interpreted as no opportunity.

Deployment/ABI sources verified during implementation:
- https://raw.githubusercontent.com/Uniswap/sdks/main/sdks/sdk-core/src/addresses.ts
- https://raw.githubusercontent.com/aerodrome-finance/slipstream/main/README.md
- https://raw.githubusercontent.com/aerodrome-finance/slipstream/main/contracts/periphery/interfaces/IQuoterV2.sol

Run regressions: `npm run build && npm test`.
