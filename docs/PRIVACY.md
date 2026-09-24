# Privacy boundary

## Threat model

Защищаются:

- private keys, mnemonics и seed phrases;
- пользовательские RPC credentials;
- локальные identity inputs;
- cookies, browser storage и history поиска;
- secrets в source control;
- accidental network exposure;
- unintended signing or transaction execution.

Не защищаются публичные on-chain данные: адрес, transaction hash, block, balance и activity уже видны в blockchain публично.

## Запрещённые возможности

В production path отсутствуют:

- key generation;
- wallet import;
- signing;
- `eth_sendRawTransaction`;
- Solana transaction signing/sending;
- allowance mutation;
- swap execution;
- user account/profile;
- analytics/telemetry.

`npm run privacy:check` ищет запрещённые API и browser persistence. CI запускает эту проверку на каждый pull request.

## Secrets

- Не добавляйте `.env` или реальные RPC keys в git.
- `.gitignore` исключает `.env`, output JSONL, logs и checkpoints.
- Registry содержит только публичные endpoints без query credentials.
- Hosted RPC key передаётся через environment.
- URL userinfo, query и secret path редактируются в ошибках.
- API `/api/chains` не возвращает RPC URLs.
- CLI output path создаётся с mode `0600`.
- Token contracts/mints, receipts and traces are public read-only inputs; they are not credentials and are never sent to signing or execution methods.
- An optional 0x price preview reads `ZEROEX_API_KEY` on the server and returns only price fields. It never accepts or creates a signed transaction.
- `--state-file` stores only range cursors, block/slot hashes and coverage; wallet addresses and RPC URLs are rejected by the checkpoint validator.

## Browser

PWA использует только same-origin resources:

- нет external fonts;
- нет CDN;
- нет analytics SDK;
- нет cookies;
- нет `localStorage` и `sessionStorage`;
- нет address/profile form;
- CSP запрещает внешний executable content;
- service worker не кэширует `/api/*`.

Результаты живут в JavaScript memory текущей вкладки. Закрытие или reload очищает session state.

## Remote access

Default bind — `127.0.0.1`.

Для `0.0.0.0`, LAN или reverse proxy обязателен `ADDRESSSCRIBE_TOKEN`. Проверка header выполняется constant-time. Static shell может быть доступен без token, но chain metadata и scan APIs защищены.

Прямой non-loopback bind по умолчанию отклоняется, потому что token не должен передаваться по plain HTTP. Для доверенной локальной сети есть явный `--allow-insecure-lan`; для телефона и публичного доступа используйте HTTPS reverse proxy. Token не должен попадать в URL или logs.

## Public data warning

Finder предназначен для анализа публичной активности. Он не доказывает:

- что адрес принадлежит человеку;
- что баланс прибыльный;
- что транзакция была успешной, если RPC не вернул receipt;
- что EVM address принадлежит тому же физическому лицу во всех сетях.

## Incident handling

При обнаружении утечки:

1. немедленно отозвать hosted RPC key;
2. не публиковать содержимое secret;
3. удалить его из history rotation plan;
4. проверить logs и output files;
5. открыть приватное security report через GitHub Security Advisories.

Никогда не отправляйте private key или seed phrase в issue, pull request, CI logs или chat.
