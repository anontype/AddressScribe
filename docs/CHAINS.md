# Chain registry

Registry is intentionally explicit. A chain is listed when the project has a bounded read path and public RPC metadata; `0x` means the current 0x Swap/Gasless metadata list, not transaction execution.

| Slug | Name | Family | Chain ID | 0x metadata |
|---|---|---:|---:|:---:|
| `ethereum` | Ethereum | EVM | 1 | yes |
| `polygon` | Polygon | EVM | 137 | yes |
| `base` | Base | EVM | 8453 | yes |
| `arbitrum` | Arbitrum One | EVM | 42161 | yes |
| `arbitrum-nova` | Arbitrum Nova | EVM | 42170 | — |
| `optimism` | OP Mainnet | EVM | 10 | yes |
| `avalanche` | Avalanche C-Chain | EVM | 43114 | yes |
| `bnb` | BNB Smart Chain | EVM | 56 | yes |
| `blast` | Blast | EVM | 81457 | — |
| `zora` | Zora | EVM | 7777777 | — |
| `sei` | Sei | EVM | 1329 | — |
| `b3` | B3 | EVM | 8333 | — |
| `berachain` | Berachain | EVM | 80094 | yes |
| `flow` | Flow EVM | EVM | 747 | — |
| `apechain` | ApeChain | EVM | 33139 | — |
| `soneium` | Soneium | EVM | 1868 | — |
| `shape` | Shape | EVM | 360 | — |
| `unichain` | Unichain | EVM | 130 | yes |
| `ronin` | Ronin | EVM | 2020 | — |
| `abstract` | Abstract | EVM | 2741 | yes |
| `hyperevm` | HyperEVM | EVM | 999 | yes |
| `somnia` | Somnia | EVM | 5031 | — |
| `megaeth` | MegaETH | EVM | 4326 | — |
| `gunz` | GUNZ | EVM | 43419 | — |
| `mantle` | Mantle | EVM | 5000 | yes |
| `scroll` | Scroll | EVM | 534352 | yes |
| `linea` | Linea | EVM | 59144 | yes; Swap only |
| `robinhood` | Robinhood Chain | EVM | 4663 | yes |
| `ink` | Ink | EVM | 57073 | yes |
| `monad` | Monad | EVM | 143 | yes |
| `animechain` | Animechain | EVM | 69000 | — |
| `arc` | Arc | EVM | 5042 | yes; Swap only |
| `plasma` | Plasma | EVM | 9745 | yes |
| `sonic` | Sonic | EVM | 146 | yes |
| `tempo` | Tempo | EVM | 4217 | yes |
| `world-chain` | World Chain | EVM | 480 | yes |
| `solana` | Solana | SVM | 999999999991 | yes; separate SVM API metadata |

## Adding a chain

1. Add the chain to `src/config/chains.js` with a public RPC and explorer provenance.
2. Mark `zeroEx` only when the chain is in the current 0x list.
3. Add an offline fake-client test for the adapter behavior.
4. Re-run `npm run check` and a one-block live smoke test.

A registry entry does not imply archive access, full historical indexing, WSS, gasless execution or swap execution.
