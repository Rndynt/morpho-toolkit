# Morpho Toolkit Status

## Current reality

Scanner diperbarui untuk broad non-stable discovery. Ia tidak lagi hanya membentuk `USDC/token` atau `WETH/token`; ia membentuk pair luas antar-token discovered, sambil membuang stable/stable. Default broad cap `1000` token, tetapi scan O(n²) dapat membebani public RPC.

## Implemented

- Morpho discovery + on-chain balance.
- V2 Uniswap/Sushi route verification.
- Aerodrome volatile/stable route verification.
- Snapshot-pinned reserve and quote.
- Non-stable broad pair expansion.
- Base RPC fallback `mainnet.base.org` dan `base-rpc.publicnode.com`.
- Robinhood RPC fallback/operator endpoint harus diset lewat `ROBINHOOD_RPC_URL`.
- Read-only scanner, plan, simulation.
- TypeScript build lulus; tests lulus pada sesi update.

## Not implemented as complete production coverage

- Semua DEX/pool di setiap chain.
- V3/V4/Curve/Balancer pool discovery production.
- Reliable high-throughput RPC batching untuk ribuan token.
- Live profitable executor deployment.

## Interpretasi scan

`No opportunity` hanya valid untuk pair/venue yang berhasil di-quote. `quoted rows 0`, timeout, BlockNotFound, atau provider error berarti scan tidak konklusif.

## Safe commands

```bash
cd tools
npm run build
npm test
npx tsx src/arb/scan-morpho.ts --chain base --max-tokens 100 --min-usd 0
```

Baca `README.md`, `docs/OPERATIONS.md`, dan `docs/ROUTES-AND-COVERAGE.md` sebelum mengubah route atau menjalankan monitor panjang.
