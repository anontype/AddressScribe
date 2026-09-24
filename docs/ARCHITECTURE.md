# Архитектура

## Цели

AddressScribe — локально запускаемый read-only инструмент, который:

1. читает ограниченный публичный chain range;
2. нормализует EVM и Solana activity;
3. отделяет EOA-like адреса от contracts и programs;
4. показывает coverage, а не выдаёт partial result за полный;
5. не имеет signing, wallet или identity boundary.

## Request flow

```text
PWA / CLI
  │ mode + chains + depth + concurrency + limit
  ▼
HTTP server / CLI validation
  │ allowlisted request fields
  ▼
scanChains
  ├── chain registry
  ├── RPC URL resolution
  ├── per-chain JsonRpcClient
  ├── EVM or Solana scanner
  ├── optional balance enrichment
  └── deterministic aggregation
  ▼
coverage + candidates + gas metadata + 0x capability metadata
  ▼
NDJSON / JSON / JSONL / CSV
```

## Chain registry

`src/config/chains.js` хранит стабильный публичный registry. Сетевой источник не нужен для запуска. Поля:

- `id`, `name`, `chainId`, `family`;
- native symbol/decimals;
- public RPC fallbacks и explorer;
- `readOnly` capabilities;
- текущий 0x metadata status.

Registry не содержит private keys и hosted credentials. Пользовательские RPC добавляются только через process environment и не возвращаются в `/api/chains`.

## Transport

`JsonRpcClient` отвечает за:

- HTTP JSON-RPC 2.0;
- response size cap (16 MiB by default, configurable up to 32 MiB);
- timeout;
- token-bucket rate limit;
- retries для transport/5xx;
- `Retry-After`;
- остановку на HTTP 429 без переключения на другой public endpoint;
- batch ID correlation и partial batch errors;
- redaction endpoint URLs.

Batch fallback не переключает RPC для обхода rate limit. Это важно: максимальная скорость не должна превращаться в abuse чужих публичных endpoints.

Optional `GET /api/quote` is a server-side read-only proxy to the 0x Allowance Holder price endpoint. It requires `ZEROEX_API_KEY`, accepts only bounded EVM price parameters, allowlists response fields, and never returns a transaction payload.

## EVM pipeline

1. Получить head.
2. Проверить `eth_chainId` и вычислить bounded range.
3. Запросить full canonical blocks JSON-RPC batch chunks до 20 blocks.
4. Собрать `from`, `to`, value, method selector и bounded evidence.
5. Приоритизировать кандидатов.
6. Проверить `eth_getCode` batch chunks до 100 addresses.
7. Исключить contracts; unknown оставить с partial confidence. Проверки classification используют отдельный bounded budget и не зависят от `--limit` результата.
8. Нормализовать counters и activity score.
9. При явном `--receipts` запросить bounded `eth_getTransactionReceipt` и заполнить status/fees без догадок.
10. При явном `--traces` запросить bounded `trace_block` и добавить internal value evidence; если метод недоступен, coverage становится partial.

Full block RPC обычно не содержит `gasUsed`/`effectiveGasPrice`. Fee не выдумывается: без этих полей он остаётся нулевым.

## Solana pipeline

1. Получить `finalized` slot.
2. Запросить `getBlock` с `jsonParsed`, full transactions и version `1`.
3. Выделить fee payer и explicit signers.
4. Исключить известные programs.
5. Классифицировать bounded accounts через `getMultipleAccounts` chunks до 100; budget не зависит от числа возвращаемых адресов.
6. Учесть success/failure и lamport fees.
7. Нормализовать score и partial coverage.
8. Slot с `result: null` считать пропущенным, а не пустым блоком.

Публичный signer — это `wallet_candidate`, а не доказательство человеческого владения.

## Optional read-only enrichment

- EVM `eth_call(balanceOf)` проверяет только явно переданные ERC-20/ERC-721 contracts.
- Solana `getTokenAccountsByOwner` проверяет только явно переданные mints.
- Wallet cap — 20, token cap — 20; calls и ответы bounded.
- Unsupported RPC не ломает основной scan: coverage получает `token-rpc-unsupported` или `token-balance-incomplete`.

## Modes

### activity

Кандидаты сортируются по transparent activity score. Score не является прогнозом цены, прибыльности или намерения адреса.

### balances

Сначала выполняется bounded activity scan. Затем публичный native balance запрашивается только для уже найденных кандидатов. Это не глобальный поиск кошельков по балансу.

### multichain

Один EVM address key объединяет данные выбранных EVM chains. Для каждой chain сохраняются отдельные counters и native balance. Разные активы не суммируются без price oracle.

## Ranking

Score складывается из:

- transaction frequency;
- counterparty diversity;
- method diversity;
- success evidence;
- bounded value/fee evidence.

Штрафы:

- contract;
- program;
- unknown classification.

Tie-break детерминированный: score, confidence, transaction count, chain, address.

## Coverage

Каждый chain result содержит:

- `complete` или `partial`;
- фактически просканированный range;
- количество blocks/slots и transactions;
- caps;
- причины пропусков;
- количество проверенных classifications.

Partial coverage никогда не маскируется под пустой полный результат.

## Storage and output

Default PWA не сохраняет API responses. CLI пишет файл только по явному `--output` с mode `0600`. JSONL предпочтительнее для больших результатов. Checkpoint store допускает только cursor/hash/coverage и никогда не сохраняет RPC URL или адреса. При `--state-file` CLI сохраняет только range cursors, block/slot hashes и coverage; server и PWA не пишут checkpoints.

## Scaling path

Бесплатные public RPC подходят для bounded demo. Production scale требует hosted indexer/RPC:

- cursor pagination;
- durable database;
- block hash lineage и reorg rollback;
- provider quota accounting;
- multiple workers;
- S3/warehouse raw archive;
- no public endpoint stress tests.

Текущий pet project сознательно остаётся single-node и local-first.
