# Operations Runbook

## 1. Tujuan

Menemukan kandidat arbitrage secara read-only. Tidak ada wallet signer, transaksi, atau penggunaan saldo asli pada tahap screening.

## 2. Urutan kerja

```bash
cd /data/data/com.termux/files/home/projects/morpho-toolkit/tools
npm ci
npm run build
npm test
npm run cli -- chains
```

Lanjutkan hanya jika build/test lulus.

## 3. Cek RPC

```bash
curl -sS -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  https://mainnet.base.org
```

Base harus menjawab `0x2105`. Robinhood harus menjawab `0x1237`.

RPC fallback yang telah diverifikasi read-only pada sesi terakhir:

- Base: `https://mainnet.base.org`
- Base: `https://base-rpc.publicnode.com`
- Robinhood: `https://robinhood.rpc.blxrbdn.com`
- Robinhood: `https://rpc-robinhood.blockmachine.io`

Endpoint publik dapat rate-limit, timeout, atau berubah. Selalu cek `eth_chainId` sebelum scan.

## 4. Jalankan scan

```bash
npx tsx src/arb/scan-morpho.ts --chain base --max-tokens 100 --min-usd 0
```

Mulai dari 100. Naikkan ke 500/1000 hanya jika RPC sanggup:

```bash
npx tsx src/arb/scan-morpho.ts --chain base --max-tokens 1000 --min-usd 0 2>&1 | tee ../report/base-scan.log
```

Monitor:

```bash
end=$((SECONDS+1800)); while [ $SECONDS -lt $end ]; do
  date -Iseconds
  timeout 180s npx tsx src/arb/scan-morpho.ts --chain base --max-tokens 100 --min-usd 0
  sleep 20
done 2>&1 | tee ../report/base-monitor.log
```

## 5. Cara membaca hasil

Valid:

- snapshot block muncul;
- `quoted rows` lebih besar dari 0;
- opportunity menampilkan gross/net;
- semua quote berasal dari snapshot block yang sama.

Tidak valid sebagai kesimpulan pasar:

- RPC timeout;
- `quoted rows 0`;
- semua pair masuk `SKIPPED`;
- provider gagal historical block;
- hanya satu venue berhasil.

`No opportunity` hanya berarti tidak ada profit pada pair/venue yang berhasil di-quote di snapshot tersebut.

## 6. Threshold

- `--min-usd`: filter awal inventory; `0` memperluas discovery.
- `--min-tvl`: filter TVL venue; default `1000`.
- `--max-tokens`: cap token discovery; 1000 dapat menghasilkan terlalu banyak pair.
- `--min-net`: threshold output CLI arb-scan.
- `--gas-units`: estimasi gas display/plan.

## 7. Masalah umum

### RPC timeout

Turunkan `--max-tokens`, ganti endpoint, jalankan ulang. Jangan mencatat cycle timeout sebagai “tidak ada peluang”.

### `quoted rows 0`

Periksa route registry, alamat router/factory, bytecode, pair existence, dan fee model. Ini coverage/venue failure.

### `BlockNotFoundError`

Provider tidak punya historical state yang diminta. Gunakan latest block atau archive-capable RPC.

### Stablecoin muncul

Stable-like symbol difilter pada broad discovery, tetapi label token dari API tidak selalu dapat dipercaya. Untuk production, filter harus berbasis address policy per chain, bukan symbol saja.

## 8. Sebelum live

Wajib ada:

1. route discovery lengkap dan terverifikasi;
2. quote dua venue pada snapshot yang sama;
3. simulation full calldata berhasil;
4. minOut, minProfit, deadline, gas, L1 fee, relay bid terhitung;
5. token policy executable dan fork test lulus;
6. shadow run minimal 7 hari sesuai `docs/FORK-AND-SHADOW-READINESS.md`;
7. private submission endpoint;
8. review manual sebelum `--broadcast`.

Screening tidak otomatis berubah menjadi live execution.
