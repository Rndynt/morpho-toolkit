# Morpho Toolkit

Toolkit EVM untuk dua pekerjaan terpisah:

1. `tools/`: scanner read-only, screening arbitrage, quote, plan, dan status RPC.
2. `evm/`: kontrak Solidity, fork test, deployment registry, dan executor.

Default aman: semua scan, quote, plan, dan simulation tidak mengirim transaksi. Jangan memakai `--broadcast` sebelum review route, policy token, gas, slippage, dan private relay.

## Status aktual

- Liquidity scanner Morpho: tersedia.
- Broad non-stable discovery: tersedia pada `scan-morpho.ts`; default cap 1000 token.
- Arbitrage route lama: V2 + Aerodrome volatile/stable pada route registry.
- Stable/stable dan stablecoin depeg noise: difilter dari broad discovery.
- V3/V4/Curve/Balancer adapter: tipe dan guard tersedia; pool discovery production belum tersambung penuh ke scanner utama.
- Flashloan executor utama: exact-principal no-op; bukan executor profit.
- Arb executor POC v2: tersedia untuk plan/fork test; belum deployment production.

## Struktur folder

```text
morpho-toolkit/
├── README.md                 # peta proyek dan quick start
├── docs/                     # dokumentasi operasional/detail
├── evm/                      # Solidity, Foundry, deployment/token registry
│   ├── src/                  # FlashLoanExecutor dan kontrak arb POC
│   ├── test/                 # unit/fork tests
│   ├── script/               # deployment scripts
│   ├── deployments.json      # address deployment per chain
│   ├── stablecoins.json      # seed token discovery
│   └── token-policies.json   # policy executable per chain+address
├── tools/                    # CLI TypeScript read-only/plan/simulation
│   ├── src/cli.ts            # entrypoint CLI
│   ├── src/morpho/           # discovery dan balance Morpho
│   ├── src/arb/              # route, quote, optimizer, scanner
│   ├── src/config/           # chain, env, registry
│   └── .env                  # lokal; jangan commit
└── report/                   # log/status lokal; jangan commit secret/strategy log
```

## Prasyarat

- Node.js 20+; proyek telah diverifikasi pada Node `v26.4.0`.
- npm.
- Foundry hanya diperlukan untuk `evm/`.
- RPC read endpoint untuk chain yang dipantau.
- `PRIVATE_KEY` tidak diperlukan untuk scan/plan/simulation.

## Setup

```bash
cd /data/data/com.termux/files/home/projects/morpho-toolkit/tools
npm ci
cp .env.example .env
chmod 600 .env
```

Isi RPC read-only di `tools/.env`. Jangan menulis private key untuk screening:

```dotenv
BASE_RPC_URL=https://mainnet.base.org
ROBINHOOD_RPC_URL=https://robinhood.rpc.blxrbdn.com
```

Gunakan `npm run cli -- status` bila tersedia pada branch yang dipakai, atau:

```bash
npm run cli -- chains
```

## Build dan test

```bash
cd tools
npm run build
npm test

cd ../evm
forge build
forge test -vv
```

`npm run build` harus lulus. Test TypeScript harus seluruhnya lulus sebelum scan panjang.

## Command utama

Semua command berikut dijalankan dari `tools/`.

### Status chain

```bash
npm run cli -- chains
npm run cli -- help
```

### Morpho liquidity scan

```bash
npm run cli -- scan --chain base --min-usd 100000
npm run cli -- scan --chain base --min-usd 0 --token 0xTokenAddress --json
npm run cli -- scan-all --chains base,robinhood --min-usd 100000
```

### Broad non-stable arbitrage screening

Command ini read-only. Ia mengambil aset discovery Morpho, membuang stable-like token sebagai lawan stable, membentuk pasangan token secara luas, lalu membaca reserve/quote pada route yang terdaftar.

```bash
npx tsx src/arb/scan-morpho.ts \
  --chain base \
  --max-tokens 1000 \
  --min-usd 0 \
  --min-tvl 1000
```

Robinhood:

```bash
ROBINHOOD_RPC_URL=https://robinhood.rpc.blxrbdn.com \
npx tsx src/arb/scan-morpho.ts \
  --chain robinhood \
  --max-tokens 1000 \
  --min-usd 0
```

Log ke file:

```bash
npx tsx src/arb/scan-morpho.ts --chain base --max-tokens 1000 --min-usd 0 \
  2>&1 | tee ../report/base-scan.log
```

Monitor berkala 30 menit:

```bash
end=$((SECONDS+1800)); while [ $SECONDS -lt $end ]; do
  date -Iseconds
  npx tsx src/arb/scan-morpho.ts --chain base --max-tokens 1000 --min-usd 0
  sleep 20
done 2>&1 | tee ../report/base-monitor.log
```

Interpretasi output:

- `OPPORTUNITIES`: kandidat quote yang lolos optimizer dan threshold.
- `No opportunity`: pada snapshot itu tidak ada kandidat profitable dari route yang berhasil di-quote.
- `quoted rows 0`: route/pair tidak berhasil mendapat dua venue usable; bukan bukti pasar tidak punya peluang.
- `SKIPPED`: lihat alasan pair/venue gagal.
- RPC timeout/error: cycle tidak valid; jangan hitung sebagai hasil negatif.

### CLI arbitrage lama

```bash
npm run cli -- arb-scan --chain base
npm run cli -- arb-scan --chain base --min-net 5
npm run cli -- arb-scan --chain base --watch --interval 20
npm run cli -- arb-scan --chain base --gas-units 350000 --json
```

`arb-scan` memakai route registry utama. Untuk broad discovery non-stable, gunakan `src/arb/scan-morpho.ts`.

### Plan dan simulation

```bash
npm run cli -- arb-setup --chain base
npm run cli -- arb-plan --chain base --opportunity 1
npm run cli -- arb-execute --chain base --opportunity 1
```

Nama `arb-execute` tanpa `--broadcast` tetap simulation-only. Jangan menambahkan `--broadcast` otomatis.

## Command state-changing

Berisiko nyata dan tidak diperlukan untuk screening:

```bash
npm run cli -- setup --chain base --select USDC,WETH --plan
npm run cli -- setup --chain base --select USDC,WETH --broadcast
npm run cli -- flashloan --chain base --asset WETH --amount 1
```

`--broadcast` mengirim transaksi. Executor `FlashLoanExecutor.sol` adalah no-op exact-principal; callback profit akan revert. Jangan gunakan sebagai arb executor.

## Dokumentasi lanjutan

- `docs/OPERATIONS.md`: prosedur harian, monitor, error, dan interpretasi.
- `docs/ROUTES-AND-COVERAGE.md`: route/venue yang benar-benar dipindai dan gap coverage.
- `docs/EVM-RPCS.md`: konfigurasi RPC dan fallback.
- `docs/MORPHO-SCAN.md`: discovery liquidity.
- `docs/DEPLOYMENT-CHECK.md`: token policy dan deployment.
- `docs/FORK-AND-SHADOW-READINESS.md`: syarat sebelum live.
- `evm/README.md`: kontrak dan Foundry.
- `tools/README.md`: CLI TypeScript.

## Larangan

- Jangan commit `.env`, private key, endpoint privat, atau log strategi.
- Jangan menganggap price API sebagai quote eksekusi.
- Jangan menganggap `quoted rows 0` sebagai zero opportunity.
- Jangan broadcast tanpa simulation full transaction, minProfit, minOut, deadline, gas, dan private submission endpoint.
