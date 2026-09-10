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
npm run cli -- arb-scan --chain base --watch                    # loop tiap 20 detik, Ctrl+C untuk stop
npm run cli -- arb-scan --chain base --watch --interval 10       # loop tiap 10 detik
```

Mode `--watch` polling berkelanjutan (baca-saja, tetap tidak pernah broadcast apapun):
tiap siklus cuma print satu baris ringkas (jam, block, ada opportunity atau tidak) supaya
gak berisik; begitu ada yang lolos `--min-net`, baru tabel lengkap (SPOT PRICES + tabel
opportunity) ditampilkan penuh. Error RPC sesaat (rate limit, timeout) di satu siklus
tidak menghentikan loop - cuma dicatat, lanjut ke siklus berikutnya. Karena gap harga
lintas-DEX sifatnya intermiten, cara paling realistis menangkapnya memang dengan
mengawasi terus-menerus, bukan cek manual sesekali.

Route yang terdaftar di `arb/routes.ts`: WETH/USDC di Base lewat Uniswap V2 + Sushi V2
(diverifikasi via `evm/test/MorphoAtomicArbPOCBaseFork.t.sol`), plus Aerodrome (volatile
pool) - DEX dengan likuiditas terbesar di Base, jauh lebih mungkin jadi sumber selisih
harga asli dibanding dua V2 fork yang nyaris tidak ada volume. Alamat PoolFactory
Aerodrome dicek silang dari beberapa sumber tapi belum dijalankan langsung (lihat
komentar "VERIFY ON BASESCAN" di `routes.ts`) - `arb-scan` akan skip dengan alasan yang
jelas di tabel SKIPPED kalau alamatnya ternyata salah, tidak bikin scan lain gagal.

Estimasi gas dikurangi dari gross profit menggunakan referensi harga ETH yang dibangun
dari SEMUA pair yang terdaftar (bukan cuma pair yang lagi discan) - jadi USDC/AERO tetap
dapat referensi harga gas yang benar walau pair itu sendiri tidak mengandung WETH, selama
ada pair lain (USDC/WETH, WETH/AERO) yang menjembatani. Kalau belum ada jembatan sama
sekali ke WETH untuk suatu token, kolom EST. NET akan tampil "n/a" - itu artinya perlu
pair tambahan yang melibatkan token itu dan WETH, bukan berarti scanner-nya salah.

Angka yang keluar dari scanner ini adalah **estimasi untuk deteksi**, bukan parameter
transaksi final - sebelum benar-benar memanggil `executeArbitrage`, kuotasi ulang secara
presisi on-chain (mis. `getAmountsOut`) di titik itu juga, karena reserve bisa berubah
antara waktu scan dan waktu eksekusi.

### Troubleshooting RPC

- **URL yang muncul di error beda dari isi `.env` kamu** (mis. `wss://...` padahal
  `.env` isinya `https://...`): `dotenv` tidak menimpa environment variable yang sudah
  ke-`export` duluan di shell kamu. Jalankan `unset BASE_RPC_URL` (atau nama var chain
  lain yang relevan) sebelum menjalankan CLI, supaya nilai di `.env` yang dipakai.
- **`factory()`/`getPair()` gagal dengan pesan generik semacam "Invalid parameters"**:
  biasanya gateway publik multi-node yang node-nya belum sinkron sempurna satu sama
  lain, atau tidak mendukung fitur tertentu. Coba RPC lain - `https://base.drpc.org`
  dan `https://mainnet.base.org` sudah terverifikasi jalan normal untuk `arb-scan`.
- **Respons HTML/403 dari Cloudflare**: itu proxy/gateway-nya sendiri yang memblokir,
  ganti provider.

CLI selalu mengambil `.env` dari folder `tools/`, sehingga command aman dijalankan dari working directory lain. Registry contract dan artifact dibaca dari `../evm/`.

## Data rahasia

- RPC dan `PRIVATE_KEY` hanya disimpan di `.env`.
- `.env.example` berisi template tanpa secret.
- Jangan memasukkan private key ke `deployments.json`, command line, log, atau dokumentasi.
