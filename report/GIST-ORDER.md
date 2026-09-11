# Spec: gist FlipZ3ro (ikuti ini)

https://gist.github.com/FlipZ3ro/50be2506274208f8c84245af71beb1f8

## Alur

```
owner -> Morpho flashLoan -> router A -> router B -> minOut+minProfit -> approve Morpho -> profitReceiver
```

## Urutan adapter (jangan dibalik)

1. Uni V2 + Sushi V2 (POC sekarang)
2. V3 legacy + SwapRouter02 (dua adapter terpisah)
3. Aerodrome/Velodrome (Base/OP), lalu Balancer V2 + Curve (allowlist pool)
4. Universal Router / RedSnwapper hanya setelah parser ketat + fork test

## Gist bilang POC ini belum punya

Quote scanner, route discovery, gas-to-token, private tx, adapter non-V2, deploy script, fork test DEX nyata.

Checklist broadcast: pilih chain + 2 venue, verifikasi ABI, fork sim block terbaru, baru kirim.

## Repo ini vs gist (2026-09-11)

| Langkah | Status |
|---|---|
| 1 V2+Sushi | Ada, unit tes mock |
| Fork DEX nyata | Sebagian (BaseFork). Profit tes = dump Sushi buatan |
| 2 V3 + SwapRouter02 | BELUM |
| 3 Aero | Ada di POCv2, belum deploy |
| 3 Balancer/Curve | BELUM |
| 4 UR | Jangan |
| Scanner | Mulai, masih tanpa TVL filter di scanner.ts |
| Deploy/broadcast | BELUM. Executor live no-op |

Penyimpangan: scan Morpho/RH/RobinArb didahulukan sebelum gist langkah 2 dan sebelum fork-sim+deploy venue yang sudah kompatibel.
