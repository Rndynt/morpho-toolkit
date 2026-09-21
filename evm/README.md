# `evm/`

Foundry layer: kontrak Solidity, fork test, deployment script, deployment registry, stablecoin seed, dan token execution policy.

## Folder

```text
src/                  # FlashLoanExecutor dan arb executor POC
script/               # Deploy.s.sol
 test/                # unit/fork tests
poc/                  # executor arbitrage POC v1/v2 dan ABI map
foundry.toml          # konfigurasi Foundry
foundry.lock          # dependency lock
lib/                  # forge-std dan dependency Foundry
deployments.json      # Morpho/executor address per chain
stablecoins.json      # discovery seed; bukan trust source
token-policies.json   # executable policy per chain+checksum address
```

## Build/test

```bash
cd evm
forge build
forge test -vv
```

## Executor utama

`src/FlashLoanExecutor.sol` hanya exact-principal no-op. Ia tidak melakukan swap. Profit tambahan dapat membuat callback revert. Jangan memakainya untuk arbitrage profit.

## POC arbitrage

Baca `poc/README.md` dan `poc/DEX-SWAP-ABI-MAP.md`. POC v2 mendukung route terstruktur dengan guard router/factory, minOut, minProfit, deadline, dan reentrancy/state checks. Deployment production belum otomatis diaktifkan.

## Deployment

Jangan broadcast dari dokumentasi ini tanpa policy dan fork test.

```bash
export MORPHO_ADDRESS=0x...
export TOKEN_ADDRESSES=0xTokenA,0xTokenB
export PRIVATE_KEY=0x...
forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_RPC_URL" --broadcast
```

Private key hanya di environment lokal yang aman. Jangan commit atau memasukkannya ke log.

## Policy

Token executable wajib memiliki:

- chain ID dan checksum address benar;
- runtime code hash/fingerprint tervalidasi;
- decimals/symbol on-chain;
- transfer/approve/flashloan/swap/repayment/rescue fork test lulus;
- tidak paused/blacklisted/rebasing tak teruji;
- entry eksplisit di `token-policies.json`.

Discovery API atau symbol tidak cukup untuk allowlist.
