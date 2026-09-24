# Contributing

## Правила

- Сначала прочитайте `README.md` и `docs/PRIVACY.md`.
- Не добавляйте key generation, signing, transaction submission или identity storage.
- Не добавляйте реальные `.env`, RPC keys, addresses владельца, cookies или signed payloads.
- Новые chain capabilities должны иметь public RPC provenance и offline test.
- Новые зависимости должны объяснять runtime necessity и проходить `npm audit`.
- Публичные изменения идут через CI: lint, typecheck, offline tests и privacy gate.

## Development

```bash
npm install
npm run dev
npm run check
```

Сеть для unit tests не нужна. Для ручной проверки RPC используйте отдельный environment и небольшой bounded range.

## Chain adapter

Новый adapter должен:

1. определить family, cursor unit и public metadata;
2. читать только bounded range;
3. иметь batch path;
4. нормализовать evidence и coverage;
5. не путать signer, program, contract и wallet candidate;
6. корректно отменяться через `AbortSignal`;
7. иметь fake-client tests без реальной сети.

## Pull request

Опишите пользовательское изменение, privacy impact, coverage limits и точные команды проверки. Не добавляйте screenshots с реальными addresses, balances или hosted credentials.
