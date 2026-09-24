# Security policy

## Supported versions

Активно поддерживается текущая minor line проекта. Security fixes публикуются в новом patch release.

## Reporting

Используйте GitHub Security Advisories для приватного report. Не включайте в публичный issue:

- private keys;
- mnemonics или seed phrases;
- RPC credentials;
- `.env`;
- signed payloads;
- пользовательские token или access token.

В report укажите версию, Node.js, mode, chain и минимальный reproduction без secrets.

## Security boundaries

Проект read-only. Optional 0x price preview использует только server-side `ZEROEX_API_KEY` и возвращает price fields; он не создаёт и не подписывает transaction. Сообщения о key generation, signing, transaction submission, allowance mutation, telemetry или persistent browser identity рассматриваются как security defects, а не feature requests.

## Disclosure

Maintainer подтверждает получение, проверяет report через минимальный offline test и выпускает fix до публичного disclosure. Сроки зависят от severity и не обещаются до подтверждения.
