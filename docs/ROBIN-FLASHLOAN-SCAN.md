# Robinhood: discovery, quote, POC flashloan

Tujuan: temukan arbitrage positif, berapa pun nilainya, lalu verifikasi pinjaman dan kedua swap dalam satu transaksi. Gross positif tetap ditampilkan meski estimasi gas lebih besar; gross bukan laba bersih.

Referensi: [FlipZ3ro/RobinArb](https://github.com/FlipZ3ro/RobinArb), commit `d7470305dd1ec33bca4e844eebc761d0deeb3ab6`. Dipakai sebagai referensi identitas pool, ABI, discovery event, quote dua arah, dan penyelesaian Universal Router. Executor referensi memakai modal deposit. Toolkit memakai Morpho flashloan; tidak mengimpor mode force/two-transaction atau private key referensi. Tidak membuat atau menambah likuiditas pool.

## Jalankan

Dari root repo:

```sh
cd tools
npm run build
npm test
npm run cli -- arb-scan --chain robinhood --max-seconds 300 --token-limit 100 --report ../report/robin-scan.json
npx tsx verify-robin-fork.mts ../report/robin-scan.json 0
```

Verifier memilih kandidat gross positif urutan ke-0, diurutkan dari gross tertinggi. Ini indeks kandidat, bukan indeks token. Argumen terakhir bisa diganti untuk menguji kandidat lain. Tanpa kandidat positif, verifier gagal eksplisit. Artefak fork: `<nama-report>-fork-<indeks>.json` dan `.log`.

Prerequisite verifier: Foundry, compiler lokal, forge-std di `evm/lib/forge-std`. Runner saat ini memakai compiler Termux `/data/data/com.termux/files/usr/bin/solc`; tool yang diuji adalah Solc 0.8.36, sementara default proyek 0.8.24. Fork terikat block laporan. Jika endpoint tidak melayani historical state, fork gagal; bukan bukti kandidat tidak ada.

Flag scanner:

- `--read-rpc URL`: endpoint baca eksplisit. Tanpa flag, RPC publik dengan fallback IP TLS/SNI untuk masalah DNS; dua IP bukan dua provider independen.
- `--amounts-raw 10000000000000,30000000000000,50000000000000`: nominal WETH dalam wei. Ukuran di atas saldo Morpho tidak diquote.
- Tanpa nominal: rentang logaritmik `1e12,3e12,1e13,3e13,...` hingga saldo WETH Morpho. Ini sampling, bukan jaminan optimum kontinu.
- `--from-block N`: batas awal event jika cache tidak dipakai. Nilai di atas nol membatasi discovery; bukan semua riwayat.
- `--json`: laporan JSON lengkap. `--broadcast` ditolak.
- `--legacy-scan`: alur scanner lama. Scanner Robinhood baru sekali jalan; tidak menyediakan watch loop.

## Jalur nyata

1. Baca `allTokensLength/allTokens` dari delapan factory curve terdaftar. Token perantara **tidak perlu saldo di Morpho**.
2. Baca status curve pada satu snapshot; graduated/ready-to-graduate tidak masuk route ini.
3. Temukan event V4 `Initialize` dengan filter currency native ETH dan token factory. Validasi hash PoolKey, fee, tick spacing, hooks. Pecah range jika RPC membatasi/timing out; backoff saat HTTP 429/503.
4. Cache pool di `report/robin-pools.json`; validasi hash block cache. Perubahan universe token memicu indexing ulang. Cache bukan harga.
5. Cek likuiditas V4; hooked pool tidak dieksekusi. Quote dua arah pada block sama: curve buy + V4 sell, V4 buy + curve sell. Output leg pertama menjadi input leg kedua; revert/zero output dicatat, tidak dianggap harga nol.
6. Morpho WETH hanya membatasi pinjaman. Simpan semua token, status, pool aktif, ukuran, quote, kegagalan; JSON checkpoint setelah tiap token. Terminal mencetak seluruh kandidat gross positif, tanpa ambang USD/bps.
7. `verify-robin-fork.mts` menjalankan `MorphoRobinArbFork.t.sol` pada snapshot laporan. `MorphoRobinArb.sol` meminjam WETH, unwrap, dua swap, rewrap, repay, lalu membayar selisih. Callback terikat lender/data aktif, owner-only, min-out/min-profit, rollback jika rugi. POC route immutable; belum deployed.

## Bukti live

Snapshot awal `72006614` (`2026-09-25T06:17:36.935Z`):

- 775 token factory; 771 curve aktif; 77 pool ditemukan.
- Hanya 4 token punya pool V4 usable: `$PET`, `RDOG`, `WA`, `SHAREBACK`; total 5 pool berlikuiditas.
- 160/160 round-trip quote valid; 10 kandidat ukuran/arah gross positif; nol failure.
- `report/robin-live.json`, `report/robin-live-fork-0.json` (RDOG), `report/robin-live-fork-1.json` ($PET).

Refinement ukuran `1e13` sampai `1e14` wei, langkah `1e13`, snapshot `72012627` (`2026-09-25T06:27:45.772Z`):

- Universe sama; 100/100 round-trip quote valid; 20 gross positif pada dua token; nol failure.
- Morpho: `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`; WETH tersedia `18.088738282830523463` pada snapshot.
- RDOG `0x0E51cFf72247C5a2d0CF6Ee7C618aF5333504663`: pinjam `0.00005 WETH`, kembali `0.000061831708585439 WETH`, gross `0.000011831708585439 WETH`.
- $PET `0x6F29AA0c4089D8a1230F34D835A20Ed66d174663`: pinjam `0.00005 WETH`, kembali `0.00006119465883145 WETH`, gross `0.00001119465883145 WETH`.
- Keduanya beli di V4 lalu jual di RobinFun curve. Pool V4 masing-masing fee `850000`, tick spacing `8500`, tanpa hook. Fee persis PoolKey dipertahankan; bukan diasumsikan 0.3%.
- Fork keduanya **PASS**: saldo lender pulih tepat, pembayaran owner sama gross, residual token/native nol. Tidak memakai `deal`, perubahan reserve, atau imbalance buatan dalam tes fork.
- Artefak: `report/robin-refined.json`, `report/robin-refined-fork-0.json` (RDOG), `report/robin-refined-fork-2.json` ($PET), beserta `.log`.

## Batas hasil

- **Belum ada laba bersih terverifikasi.** Estimasi gas `700000` unit memberi biaya `0.0000275394 ETH` pada refinement. Estimasi net RDOG `-0.000015707691414561 ETH`; $PET `-0.00001634474116855 ETH`.
- `CALL_GAS_USED` fork RDOG `437567`, $PET `434964` hanyalah pengukuran call dalam test. Bukan gas transaksi lengkap; tidak mencakup semua intrinsic gas/L1 fee, deployment, atau perbedaan cold/warm state. Jangan pakai sebagai bukti net profit.
- Kedua kandidat terverifikasi arah V4-to-curve. Arah curve-to-V4 lolos unit test, tetapi jalur Permit2 nyata belum diverifikasi dengan kandidat fork positif.
- Hanya keluarga RobinFun curve/V4 native ETH, delapan factory dikenal, bukan seluruh token/DEX/chain. Curve graduated, wrapped-ETH V4 pairs, hooks dan venue lain di luar scope laporan. Token cap diterapkan setelah pasangan usable ditemukan.
- `complete` berarti scan selesai untuk universe dan nominal tersebut, bukan seluruh pasar. `failed`/`partial` dan RPC error tidak berarti tidak ada peluang.
- Kandidat snapshot lama dapat berubah. Tidak ada signer, deploy mainnet, broadcast, atau uang riil diterima. `arb-plan/arb-execute` lama belum memakai hasil scanner Robinhood baru.

Verifikasi kode: TypeScript build dan 58 test lulus; 20 unit test Solidity lulus; kedua kandidat refinement lolos fork. Source: `tools/src/arb/robin-scan.ts`, `evm/src/poc/MorphoRobinArb.sol`, `tools/verify-robin-fork.mts`.
