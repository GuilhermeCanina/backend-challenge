# Changelog

## 0.4.2 - 2026-11-08

- Adicionado `PendingReferenceWorkerService` para reprocessar REFUND/ROLLBACK recebidos antes da transação referenciada.
- Persistidos `reference_attempts` e `reference_next_attempt_at` por migration versionada.
- Adicionado `FOR UPDATE SKIP LOCKED` para coordenação entre múltiplas instâncias.
- Implementado backoff exponencial com teto, limite configurável de tentativas e TTL configurável.
- Após esgotamento, a pendência termina em `REJECTED` com `REFERENCE_NOT_FOUND` ou `REFERENCE_NOT_READY` e evento Outbox.
- Resolução financeira, ledger e Outbox compartilham o mesmo commit PostgreSQL.
- Adicionado `bun run test:pending-reference` para validar REFUND antes do BET, saldo final e reconciliação.

## 0.4.0 - 2026-11-08

- Implementado consumer SQS FIFO com long polling e encerramento gracioso.
- Adicionado contrato de mensagem `WagerTransactionRequested` versionado e parser estrito.
- Adicionada Inbox persistente com chave `(consumer_name, message_id)` e hash de negócio.
- Extraído `WageringService.processWagerInTransaction()` para compartilhar o mesmo caso de uso entre HTTP e SQS.
- Inbox, transação financeira, wallet, ledger e Outbox agora participam do mesmo commit PostgreSQL no fluxo SQS.
- ACK (`DeleteMessage`) somente após commit; redelivery encontra Inbox concluída e não duplica efeitos.
- Mensagens inválidas/conflitantes e erros permanentes são encaminhados à DLQ antes do ACK da fila de origem.
- Falhas transitórias não recebem ACK e usam a política de redrive da fila.
- Adicionados testes unitários do parser e script de integração `bun run test:sqs`.
- Corrigido o script LocalStack para construir a `RedrivePolicy` com JSON válido, sem escape manual frágil.
- Nenhuma migration nova: reutiliza `inbox_messages` criada na migration inicial.


## 0.3.4 - 2026-11-08

- Fixed NestJS dependency injection for `HealthController` by importing `SqsClientModule` into `HealthModule`; providers from sibling modules in `AppModule` are not visible across module scopes.
- Persisted `discovery.warnWhenNoEntities: false` in the MikroORM configuration because this project uses SQL migrations without decorated MikroORM entities.
- No financial domain behavior changed.

## 0.3.3 - 2026-11-08

- Fixed `Money.isPositive()` to mean strictly greater than zero. `decimal.js` considers zero positive for its sign predicate, which allowed zero-value wallet movements through domain validation.
- Added a regression test proving zero is not positive while positive values remain positive.
- This corrects wallet movements, opening balances, wager amounts and ledger amount validation wherever the domain uses `Money.isPositive()`.

## 0.3.2 - 2026-11-08

- Removed `registerRequestContext` from the core MikroORM configuration; the NestJS integration owns this option and its default request middleware remains enabled.
- Switched to direct default `EntityManager` injection supported by `@mikro-orm/nestjs` v7 for the single default connection.
- Switched `decimal.js` imports to the package's named `Decimal` class export to avoid NodeNext default-import namespace typing.
- Updated ledger-direction unit assertions to use the `LedgerDirection` enum instead of raw string literals.
- No financial domain rules changed.

## 0.3.1 - 2026-11-08

- Fixed MikroORM 7 metadata provider import: `ReflectMetadataProvider` now comes from `@mikro-orm/decorators/legacy`, not `@mikro-orm/core`.
- No financial processing behavior changed.


## 0.2.0 — 2026-11-06

- Added the `WagerTransaction` aggregate and its pending, pending-reference and terminal state transitions.
- Added in-memory domain processing for BET, WIN, LOSS, REFUND and ROLLBACK.
- Added reference-scope and amount validation, duplicate-reversal signaling, and distinct failure codes for insufficient BET balance vs. a negative-balance reversal.
- Added SHA-256 hashing over deterministic JSON with recursive object-key ordering.
- Required positive initial wallet balances.
- Added unit test coverage for the new domain rules and canonical payload hashing.
- Kept PostgreSQL application transactions, wallet row locking, persistent idempotency, API routes, SQS/Inbox, Outbox and integration/concurrency tests explicitly pending.

## [0.3.0] - 2026-11-08

- Added NestJS HTTP endpoints for wallet creation/queries, wager submission/queries, ledger pagination and reconciliation.
- Added PostgreSQL-backed processing inside MikroORM transactions.
- Added idempotency lookup and payload-hash conflict detection backed by PostgreSQL, with transaction-scoped advisory locks per idempotency/external identity.
- Added wallet-scoped `SELECT FOR UPDATE` and version-checked balance update.
- Added atomic wallet/OPENING/ledger/Outbox writes for wallet creation.
- Added atomic wager transaction/wallet/ledger/Outbox writes for BET/WIN/LOSS/REFUND/ROLLBACK outcomes.
- Added concrete versioned integration event classes.
- Added reconciliation endpoint and manual HTTP smoke-test collection.
- Fixed the duplicate-refund unit test fixture to use the referenced BET amount.
- SQS consumer/Inbox, Outbox publisher, pending-reference worker and real multi-instance integration tests remain pending.


## [0.4.1] - 2026-11-08

### Added
- OutboxPublisherService com `FOR UPDATE SKIP LOCKED` e publishers concorrentes protegidos por row locks.
- Fila FIFO de saída `wager-events.fifo`, separada da fila de comandos.
- Publicação com `MessageGroupId` por agregado e deduplication ID estável por evento.
- Retry persistente com `attempts`, `next_attempt_at` e backoff exponencial limitado, sem descartar eventos.
- Smoke test que cria uma wallet e verifica a publicação dos eventos de OPENING.

### Changed
- LocalStack inicializa também a fila de saída.
- Documentação explicita a semântica at-least-once e o trade-off de manter row lock durante o envio.
