# Morpho Toolkit Status

## Current reality

`arb-scan --chain robinhood` memakai discovery RobinFun/V4 dan quote dua arah multi-ukuran, bukan saldo token perantara Morpho. Referensi [FlipZ3ro/RobinArb](https://github.com/FlipZ3ro/RobinArb) dipadukan dengan POC flashloan WETH Morpho, tanpa modal deposit atau broadcast. [Cara menjalankan dan bukti](../docs/ROBIN-FLASHLOAN-SCAN.md).

Snapshot `72012627`: 775 token factory, 77 pool ditemukan, 4 token punya 5 pool V4 usable. 100/100 quote valid; 20 kandidat gross positif pada RDOG dan $PET. Keduanya lolos fork flashloan, repay tepat, gross cocok quote. **Net positif belum terbukti; estimasi setelah gas negatif.** Artefak `report/robin-refined.json` dan `report/robin-refined-fork-{0,2}.json`. Belum deploy/mainnet execution.

`arb-scan --chain base` memakai bounded Aerodrome factory discovery dan counter-pool V2/V3/Slipstream: lihat [cakupan Base](../docs/BASE-DEX-SCAN.md). Helper discovery/sizing baru tidak boleh dianggap aktif di Base sebelum call graph dihubungkan. `scan-morpho.ts` / `--legacy-scan` tetap scanner Morpho-inventory/broad pairs lama; O(n²) dapat membebani RPC.

## Implemented

- Morpho discovery + on-chain balance.
- V2 Uniswap/Sushi route verification.
- Aerodrome volatile/stable route verification.
- Snapshot-pinned reserve and quote.
- Non-stable broad pair expansion.
- Base RPC fallback `mainnet.base.org` dan `base-rpc.publicnode.com`.
- Robinhood scanner baru: RPC publik TLS/SNI fallback, override `--read-rpc`; scanner legacy memakai konfigurasi sebelumnya.
- RobinFun/V4 quote dua arah; POC Morpho flashloan dan fork verifier read-only.
- Refinement ternary-search terbatas atas sweep kasar Robinhood (`tools/src/arb/optimize.ts`), otomatis jalan per token setelah sweep; baris hasil ditandai `refined:true` di report.
- Read-only scanner, plan, simulation.
- TypeScript build dan 58 test lulus; 20 unit test Solidity lulus; RDOG/$PET lolos fork nyata pada snapshot laporan.

## Not implemented as complete production coverage

- Semua DEX/pool di setiap chain.
- Cakupan menyeluruh V3/V4/Curve/Balancer; saat ini Base terbatas, Robinhood hanya RobinFun/V4.
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
