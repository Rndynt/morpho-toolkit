# Routes and Coverage

## Route yang benar-benar digunakan scanner utama

`tools/src/arb/routes.ts`:

### Base

- Uniswap V2
- Sushi V2
- Aerodrome volatile
- Aerodrome stable

Static seed lama mencakup USDC/WETH, USDC/cbBTC, WETH/cbBTC, USDC/AERO, WETH/AERO. Broad `scan-morpho.ts` menambah pasangan antar-token discovery non-stable sampai `--max-tokens`.

### Robinhood

- Uniswap V2
- Froth legacy V2 tercatat tetapi unsupported fee model, sehingga dilewati fail-closed.
- Broad discovery memakai WETH sebagai anchor; USDG tidak lagi dipakai sebagai anchor default.

## Yang belum otomatis ter-scan

Adapter typed-call di `tools/src/arb/venues/adapters.ts` mencakup:

- Uniswap V3
- Aerodrome concentrated
- Curve stable
- Balancer Vault

Namun adapter bukan pool discovery. Sampai discovery pool per chain/factory/router tersambung ke scanner produksi, venue tersebut tidak boleh diklaim sudah dipantau.

## Filter stable

Broad discovery membuang pasangan stable/stable dan stable-like discovered token sebagai leg. Quote anchor seperti USDC/WETH tetap dipakai untuk menjembatani harga token non-stable.

Symbol bukan trust source. Production filter harus memakai `(chainId, checksum address)` dan token policy.

## Batasan penting

- Morpho inventory bukan seluruh token di chain.
- DEX pool yang tidak ditemukan dari seed/discovery tidak ter-scan.
- `quoted rows 0` berarti tidak ada quote dua venue usable, bukan tidak ada arbitrage.
- RPC timeout menginvalidasi cycle.
- Public RPC tidak cukup untuk scan O(n²) ribuan token tanpa batching/provider khusus.

## Acceptance sebelum klaim “semua route”

1. Pool discovery membaca factory/indexer untuk setiap venue.
2. Setiap pool memiliki bytecode, token pair, fee/tick/pool type tervalidasi.
3. Quote exact-input diuji pada snapshot block yang sama.
4. Pair coverage dan skipped reason diekspor.
5. V3/V4/Curve/Balancer memiliki fork fixture dan simulation test.
6. Tidak ada stable/depeg route kecuali eksplisit diizinkan.
