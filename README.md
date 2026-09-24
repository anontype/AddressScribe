<p align="center">
  <img src="docs/hero.svg" alt="AddressScribe — a simple public blockchain activity finder" width="100%">
</p>

<h1 align="center">AddressScribe</h1>

<p align="center">A small, read-only tool for looking at public blockchain activity.</p>

I made AddressScribe because I wanted a simple way to look through recent public blockchain activity without asking anyone for a private key.

It looks at a small number of recent blocks or Solana slots and shows addresses that were active there. It supports Ethereum-compatible networks and Solana.

This is **not** a wallet generator. It does not create wallets, sign transactions, send money, or ask for seed phrases.

## What it does

- Finds recently active addresses.
- Shows a simple activity score.
- Checks the main coin balance of addresses it finds.
- Can look at the same Ethereum-style address on several networks.
- Shows results in a browser or in the terminal.
- Shows progress while a scan is running.
- Optionally checks balances for tokens or NFT collections that I explicitly provide.
- Optionally reads EVM receipts and internal calls when the RPC supports them.
- Checks block or slot links and can save a small range checkpoint.
- Saves results as JSON, JSONL, or CSV.

The list currently contains **37 networks**: 36 Ethereum-compatible networks and Solana.

I also added metadata for the networks supported by 0x. This is only information about networks. AddressScribe does not make swaps or transactions.

## Try it locally

You need Node.js `20.19` or newer.

```bash
git clone https://github.com/anontype/AddressScribe.git
cd AddressScribe
npm install
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

If I am changing the code and want the server to restart automatically, I use:

```bash
npm run dev
```

## Using the web app

1. Choose one or more networks.
2. Choose how many recent blocks or slots to check. I would start with `1` or `2`.
3. Choose a mode.
4. Press **Run finder**.
5. Wait for the results to appear.

The app can be installed as a PWA if the browser supports it. The basic app page can load without internet, but a search still needs the AddressScribe server.

In **Additional checks**, I can enter public token contracts or Solana mints. I can also ask the server for EVM receipts or internal calls. These extra requests are optional because many public RPC services do not provide them.

## The three modes

### Transactions

This is the normal mode. It finds addresses that sent or received something in the selected recent range.

### Balances

This mode first finds active addresses. It then checks the main coin balance of those addresses and sorts the list by that balance.

It does not search every wallet on the internet and return all rich wallets.

### All networks

This mode combines activity for the same Ethereum-style address across the selected networks.

I keep balances separate because the same coin can have a different value or risk on different networks. The app does not invent one total dollar amount.

## Command line examples

List the networks:

```bash
node src/cli.js chains
```

Look at recent Ethereum activity:

```bash
node src/cli.js scan --chain ethereum --blocks 5
```

Look at several networks:

```bash
node src/cli.js scan --chain base,arbitrum,solana --blocks 2
```

Combine Ethereum-style addresses from several networks:

```bash
node src/cli.js scan --chain base,arbitrum --mode multichain
```

Save results as JSONL:

```bash
node src/cli.js scan --chain ethereum --format jsonl --output out/activity.jsonl
```

Check a public ERC-20 balance for the first 20 found addresses:

```bash
node src/cli.js scan --chain ethereum --blocks 2 --token ethereum:0x6B175474E89094C44Da98b954EedeAC495271d0F:erc20:18
```

Ask for EVM receipts and internal calls:

```bash
node src/cli.js scan --chain ethereum --blocks 2 --receipts --traces
```

Save safe range metadata for a later run:

```bash
node src/cli.js scan --chain ethereum --blocks 2 --state-file out/scan.checkpoint.json
```

Start the server manually:

```bash
node src/cli.js serve --host 127.0.0.1 --port 4173
```

## If I need a more reliable RPC

An RPC is simply a service that returns blockchain data. The project has public endpoints, but they can be busy or limited.

I can provide my own endpoint through environment variables:

```bash
export BASE_RPC_URL="https://my-base-rpc.example"
export SOLANA_RPC_URL="https://my-solana-rpc.example"
export ADDRESSSCRIBE_RPC_URLS='{"ethereum":["https://my-ethereum-rpc.example"]}'
```

The app does not load `.env` files automatically. The [`.env.example`](.env.example) file only shows the available settings and does not contain real keys.

The default response limit is 16 MiB. I can change it up to 32 MiB with `ADDRESSSCRIBE_RPC_MAX_RESPONSE_BYTES`.

## Optional 0x price preview

I can also expose a read-only 0x price preview when I set `ZEROEX_API_KEY` on the server:

```bash
export ZEROEX_API_KEY="my-server-side-key"
node src/cli.js serve
```

The browser can call `GET /api/quote` with `chainId`, `sellToken`, `buyToken`, and `sellAmount`. The server adds the API key and returns only price data. It does not ask for a taker, create a transaction, sign anything, or execute a swap. Without the key, the endpoint returns `quote_unavailable` instead of pretending to have a quote.

## Privacy

I built this as a read-only project:

- It never asks for a private key.
- It has no wallet generator.
- It cannot sign or send transactions.
- It does not use cookies, analytics, or tracking.
- Search results are kept in the current page memory and are not saved in browser storage.
- Raw RPC responses are not sent to the browser.
- Secrets in RPC URLs are hidden from error messages.
- The service worker caches only the static app page, not search results.
- A checkpoint file, when I use `--state-file`, contains only range cursors, hashes, and coverage. It does not contain wallet addresses. On the next CLI run, AddressScribe compares an overlapping block or slot and reports `reorg-detected` if its hash changed.

If I run the server for another device, the access token stays in the current tab memory. It is sent in the `X-AddressScribe-Token` header.

Plain HTTP access to other devices is disabled by default. For use on a phone or another computer, I use an HTTPS proxy. For a trusted local test network only, plain LAN access can be enabled with `--allow-insecure-lan`.

The full privacy notes are in [`docs/PRIVACY.md`](docs/PRIVACY.md).

## What the results do not prove

The app shows public blockchain observations. It cannot prove who controls an address.

- An address can belong to a person, a contract, an exchange, a bridge, or an automated service.
- A Solana signer is an account that signed a transaction. It does not prove that a particular person owns the account.
- A score is only a ranking based on visible activity. It is not a price prediction.
- A `partial` result means that some data could not be read. It does not mean that the missing data is empty.

## Honest limitations

- I only scan a small recent range, up to 50 blocks or slots. This is not a search through all blockchain history. A complete history search needs a dedicated indexer.
- The normal balance is only the network's main coin, such as ETH or SOL. I can check specific token contracts or Solana mints when I provide them, but this is not a complete token or NFT portfolio.
- Some EVM transactions happen inside smart contracts and may not appear unless the RPC supports extra tracing methods.
- The newest blocks or slots can sometimes be rearranged by the network. For important work, use a range that has already been confirmed.
- Public RPC services can limit requests or may not support every method. When that happens, the app says the result is `partial` instead of pretending it is complete.
- The app cannot tell whether an address is safe, profitable, or controlled by a particular person.

## What I cannot honestly add yet

I did not add a fake 0x quote button. The current 0x quote service needs an API key and can require a paid request, so a preview without those things would be dishonest.

I also did not add a full historical indexer. That needs a hosted provider, credentials, and a different storage design. The local scanner stays small and predictable instead.

## Networks and methods

Ethereum-compatible networks use methods such as `eth_getBlockByNumber`, `eth_getCode`, `eth_getBalance`, `eth_getTransactionReceipt`, and optional `trace_block`.

Solana uses methods such as `getSlot`, `getBlock`, `getMultipleAccounts`, `getBalance`, and optional `getTokenAccountsByOwner`.

The full network list is in [`docs/CHAINS.md`](docs/CHAINS.md).

## Development checks

I run these checks before changing the project:

```bash
npm test
npm run lint
npm run typecheck
npm run privacy:check
npm run check
```

The automated tests use fake RPC responses. They do not need real network access and do not use up RPC limits.

## License

[MIT](LICENSE)
