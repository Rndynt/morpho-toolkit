# Morpho Tools

TypeScript toolkit untuk scan liquidity Morpho, deploy/sync executor, dan menjalankan exact-principal flashloan di seluruh EVM yang terdaftar.

## Struktur source

```text
src/
├── cli.ts              interactive dan non-interactive CLI entrypoint
├── commands/
│   ├── dry-run.ts      no-broadcast plan
│   └── status.ts       RPC configuration status
├── config/
│   ├── chains.ts       chain metadata dan nama environment RPC
│   ├── env.ts          loader tools/.env
│   └── registry.ts     deployment, token, dan artifact paths
├── morpho/
│   ├── scanner.ts      API discovery + on-chain balance verification
│   ├── scanner.test.ts threshold tests
│   ├── plan.ts         auditable Morpho no-op plan
│   └── guards.ts       exact-principal guards
├── arb/
│   ├── routes.ts       verified V2-router/pair config per chain (read this before scanning)
│   ├── math.ts         closed-form optimal two-leg AMM arbitrage size + AMM quote helper
│   ├── math.test.ts    self-consistency tests (checks x* beats neighboring trade sizes)
│   └── scanner.ts      read-only on-chain reserve reads + opportunity ranking
└── ui/
    └── index.ts        terminal rendering
```

## Menjalankan

```bash
npm run cli
npm run cli -- chains
npm run cli -- scan-all --min-usd 100000
npm run cli -- arb-scan --chain base
npm run build
npm test
```

Contoh langsung:

```bash
npm run cli -- flashloan --chain arbitrum --asset WETH --amount '$100000'
```

## Arbitrage scanner (`arb-scan`)

Read-only. Tidak pernah mengirim transaksi, tidak butuh `PRIVATE_KEY`, aman dijalankan
berulang-ulang. Untuk tiap pasangan token+router yang terdaftar di `arb/routes.ts`, dia
membaca reserve on-chain lewat Multicall3, lalu menghitung ukuran pinjaman yang secara
matematis optimal (closed-form, lihat komentar di `arb/math.ts`) untuk tiap kombinasi
"beli di router X, jual di router Y" pada kedua arah token. Estimasi gas dikurangi dari
gross profit kalau ada referensi harga native token yang bisa dipakai (saat ini: pool
apa pun yang salah satu sisinya WETH).

```bash
npm run cli -- arb-scan --chain base                 # tabel, threshold profit = 0
npm run cli -- arb-scan --chain base --min-net 5      # cuma tampilkan net profit >= 5 (unit loan token)
npm run cli -- arb-scan --chain base --gas-units 350000 --json
```

Route yang terdaftar di `arb/routes.ts` baru satu: WETH/USDC di Base lewat Uniswap V2 +
Sushi V2 - persis alamat yang sudah diverifikasi lewat
`evm/test/MorphoAtomicArbPOCBaseFork.t.sol`. Menambah pair/router baru berarti
memverifikasi dulu (getPair tidak revert, reserve masuk akal) sebelum dipercaya; entry
yang salah alamat cukup di-skip otomatis dengan alasan di kolom `SKIPPED ROUTERS`, tidak
bikin scan lain gagal.

Angka yang keluar dari scanner ini adalah **estimasi untuk deteksi**, bukan parameter
transaksi final - sebelum benar-benar memanggil `executeArbitrage`, kuotasi ulang secara
presisi on-chain (mis. `getAmountsOut`) di titik itu juga, karena reserve bisa berubah
antara waktu scan dan waktu eksekusi.

CLI selalu mengambil `.env` dari folder `tools/`, sehingga command aman dijalankan dari working directory lain. Registry contract dan artifact dibaca dari `../evm/`.

## Data rahasia

- RPC dan `PRIVATE_KEY` hanya disimpan di `.env`.
- `.env.example` berisi template tanpa secret.
- Jangan memasukkan private key ke `deployments.json`, command line, log, atau dokumentasi.
