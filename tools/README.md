# `tools/`

CLI TypeScript untuk discovery Morpho, read-only quote, broad non-stable screening, plan, simulation, dan status chain.

## Folder

```text
src/
├── cli.ts                 # CLI utama
├── commands/              # command status/dry-run
├── config/                # chain, env, deployment, token policy
├── morpho/                # Morpho API + balanceOf on-chain
├── arb/
│   ├── routes.ts          # route V2/Aerodrome yang terdaftar
│   ├── discover.ts        # pembentukan pair broad dari token discovery
│   ├── scanner.ts         # reserve, quote, optimizer, gas
│   ├── quotes.ts          # quote exact-input pada snapshot block
│   ├── venues/            # adapter V3/CL/Curve/Balancer dan graph
│   └── shadow.ts          # shadow observation, tanpa signer
└── ui/                    # output terminal
```

## Instalasi

```bash
cd tools
npm ci
cp .env.example .env
chmod 600 .env
```

`.env` hanya untuk konfigurasi lokal. Screening tidak memerlukan `PRIVATE_KEY`.

## Verifikasi

```bash
npm run build
npm test
npm run cli -- help
npm run cli -- chains
```

## Screening broad non-stable

```bash
npx tsx src/arb/scan-morpho.ts --chain base --max-tokens 1000 --min-usd 0
```

Default command di atas:

- mengambil token Morpho dengan metadata dan balance valid;
- mengizinkan token tanpa harga segar sebagai discovery bila diminta;
- membuang stable-like token sebagai pair-vs-stable;
- mempertahankan quote anchor chain seperti USDC/WETH;
- membentuk pasangan luas antar-token discovered, bukan hanya `USDC/token`;
- membaca Uni V2, Sushi V2, dan Aerodrome yang terdaftar;
- tidak mengirim transaction.

Untuk discovery unpriced:

```bash
npx tsx src/arb/scan-morpho.ts \
  --chain base --max-tokens 1000 --min-usd 0 \
  --include-unpriced-discovery
```

Untuk mengurangi beban RPC saat debugging:

```bash
npx tsx src/arb/scan-morpho.ts --chain base --max-tokens 100 --min-usd 0
```

1000 token menghasilkan pair O(n²); RPC public dapat timeout. Naikkan bertahap, gunakan provider ber-rate-limit lebih tinggi, atau jalankan per batch chain/token. Timeout bukan hasil scan valid.

## Arbitrage CLI

```bash
npm run cli -- arb-scan --chain base
npm run cli -- arb-scan --chain base --min-net 5
npm run cli -- arb-scan --chain base --watch --interval 20
npm run cli -- arb-scan --chain base --json
```

`arb-scan` read-only. `arb-plan` membuat plan dan fresh quote:

```bash
npm run cli -- arb-plan --chain base --opportunity 1
npm run cli -- arb-execute --chain base --opportunity 1
```

Tanpa `--broadcast`, `arb-execute` simulation-only.

## Route coverage

Route utama saat ini bukan seluruh DEX dunia. Lihat `docs/ROUTES-AND-COVERAGE.md`. Adapter V3/Curve/Balancer tersedia sebagai fondasi typed-call/guard, tetapi discovery pool produksi harus tersambung sebelum dianggap ter-scan.

## Error

- `quoted rows 0`: tidak ada dua venue usable pada pair tersebut.
- `fewer than 2 usable router quotes`: pair dilewati.
- `request timed out`: RPC gagal; ulangi dengan fallback/provider lain.
- `BlockNotFoundError`: provider tidak melayani historical block; gunakan provider archive-capable atau latest snapshot.
- `UnknownRpcError`: provider mengembalikan error tidak terstruktur; ganti endpoint.

## Keamanan

Jangan menjalankan `setup --broadcast`, `flashloan --broadcast`, atau `arb-execute --broadcast` untuk screening. Jangan simpan private key di shell history, README, registry, atau log.
