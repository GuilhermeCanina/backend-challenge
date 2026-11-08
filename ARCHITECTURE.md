# Architecture decisions — Distributed Wagering Processor

## Status

Esta é uma entrega time-boxed **v0.4.2**. O domínio financeiro, a API HTTP transacional, o consumer SQS com Inbox persistente e o publisher da Outbox foram implementados. O worker de referência pendente foi adicionado na v0.4.2; a validação extensiva de falhas/múltiplos processos permanece pendente.

## Stack e persistência

- Bun 1.x, TypeScript strict e NestJS.
- PostgreSQL é a fonte da verdade para saldo, idempotência, transações e ledger.
- MikroORM 7 fornece o limite transacional (`EntityManager.transactional`) e a conexão PostgreSQL. O use case usa SQL explícito por meio da conexão transacional para tornar visíveis `SELECT FOR UPDATE`, advisory locks, inserts e constraints; não há dependência de estado de processo.
- `decimal.js` existe apenas por trás de `Money`. APIs recebem e devolvem dinheiro como strings decimais de duas casas; PostgreSQL usa `NUMERIC(20,2)`.
- LocalStack provisiona a fila de comandos `wager-transactions.fifo`, sua DLQ e a fila de eventos `wager-events.fifo`. O consumer de entrada e o publisher Outbox ficam ativos por padrão; podem ser desligados independentemente por configuração.

## Caminho de processamento HTTP

`POST /wagering/transactions` valida a entrada e o header `Idempotency-Key`, normaliza os campos de negócio e calcula SHA-256 de JSON canônico. Dentro de uma única `EntityManager.transactional()`:

1. Adquire advisory transaction locks específicos para a idempotency key e para `(providerId, externalTransactionId)`. Eles serializam somente requisições que disputam a mesma identidade, não todas as wallets.
2. Consulta a transação existente. Hash igual devolve a resposta original persistida; hash diferente retorna conflito.
3. Carrega a wallet com `SELECT ... FOR UPDATE`, serializando movimentos da mesma wallet entre processos/instâncias PostgreSQL.
4. Resolve a referência, reidrata o domínio e executa `WageringProcessor`.
5. Persiste `wager_transactions`; se houve movimento, atualiza wallet com predicado de versão e insere o ledger append-only.
6. Insere os eventos de integração na Outbox antes do commit.

Qualquer exceção no caminho reverte todos os writes. O banco mantém constraints únicas como última defesa, inclusive ledger por transação/wallet e reversão por referência/tipo.

## Abertura de wallet

`POST /wallets` cria a wallet com saldo inicial positivo e versão 1. Na mesma transação SQL grava a transação interna `OPENING`, um ledger `CREDIT` de saldo zero para o saldo inicial e `WalletBalanceChanged`. O schema valida no commit a continuidade e a correspondência do saldo materializado com o ledger.

## Idempotência e concorrência

- O header é obrigatório e é a fonte da verdade. Hash inclui apenas campos de negócio normalizados; headers de transporte não entram.
- A unicidade da key é persistida no PostgreSQL; não há cache em memória.
- Requisições concorrentes com a mesma key são serializadas por advisory transaction lock por key. A mesma operação com payload divergente não é tratada como replay.
- `SELECT FOR UPDATE` é aplicado somente à wallet afetada. Duas wallets distintas podem progredir em paralelo.
- O `UPDATE wallets` também verifica a versão anterior, além do row lock, como defesa adicional.

## Ledger e integridade do banco

- Ledger é append-only, sem UPDATE/DELETE.
- Cada linha guarda direção, valor, moeda, saldos anterior/posterior e wallet_version.
- Constraints/triggers no PostgreSQL garantem saldo não-negativo, aritmética, unicidade por wallet/version, sequência de versões, correspondência com o saldo materializado e referências cruzadas para wallet/transaction.
- Reconciliação calcula `SUM(CREDIT) - SUM(DEBIT)` e reporta divergências sem consertá-las silenciosamente.

## Eventos e mensageria

As subclasses `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` produzem envelopes versionados. Os envelopes correspondentes são inseridos em `outbox_messages` dentro da transação financeira; eventos de saldo são gerados somente quando existe ledger.

**Implementado na v0.4.0:** o consumer SQS recebe `WagerTransactionRequested`, valida o envelope e registra `(consumer_name, message_id)` na Inbox. Inbox, transação financeira, wallet, ledger e Outbox compartilham o mesmo `EntityManager.transactional()`. `DeleteMessage` só ocorre depois do commit. Mensagens repetidas com o mesmo hash são ACK sem reprocessamento; identidade reutilizada com payload diferente e erros permanentes são encaminhados à DLQ antes do ACK da origem. Falhas transitórias não recebem ACK e usam a `RedrivePolicy` da fila. O shutdown espera o long poll/processamento em andamento terminar antes de parar novos polls.

**Implementado na v0.4.1:** Outbox publisher usa `FOR UPDATE SKIP LOCKED`, publica em fila FIFO separada, mantém `published_at` nulo até a confirmação do SQS, registra tentativas e agenda retry exponencial. O envio e o commit SQL não são atomicamente distribuídos: crash após aceitação SQS e antes do commit pode duplicar a publicação; por isso o contrato é at-least-once com `eventId` estável e deduplicação necessária nos consumidores downstream.

**Implementado na v0.4.2:** `PendingReferenceWorkerService` pesquisa operações elegíveis em PostgreSQL usando `FOR UPDATE SKIP LOCKED`. Cada linha mantém `reference_attempts` e `reference_next_attempt_at`; ausência de referência (ou referência ainda pendente) agenda retry com backoff exponencial limitado. Após 10 tentativas ou TTL padrão de 3600 segundos, a operação termina como `REJECTED` com `REFERENCE_NOT_FOUND`/`REFERENCE_NOT_READY`/`REFERENCE_TTL_EXPIRED`. Quando a referência está `PROCESSED`, o worker reutiliza o `WageringProcessor`; estado da transação, saldo, ledger e eventos Outbox são gravados atomicamente. A concorrência entre workers é coordenada pelo row lock da pendência e pelo row lock da wallet.

## HTTP e autenticação

Endpoints implementados: criação/consulta de wallet, ledger paginado, processamento/consulta de wager e reconciliação. `200` indica processada; `202`, referência pendente; `422`, rejeição de negócio; `400`, payload inválido; `404`, recurso ausente; `409`, conflito de idempotência/identidade.

Autenticação foi omitida conforme permitido no enunciado, que atribui zero pontos a esse item. O guard/adapter de identidade do provedor deve ser inserido na borda HTTP quando houver IdP externo; não há tabela de usuário ou senha local.

## Limitações e validação

A validação de entrega deve ser realizada no ambiente Arch Linux com Bun, PostgreSQL e LocalStack. O parser e scripts receberam verificações estáticas durante a preparação, mas isso **não** substitui `bun run typecheck`, `bun test`, `bun run build` e o teste de integração `bun run test:sqs` com PostgreSQL/LocalStack reais. O comportamento sob múltiplas instâncias, queda após commit antes do ACK e redrive por falhas transitórias ainda precisa ser comprovado.

Antes da entrega, executar no Arch Linux:

```bash
bun install
bun run typecheck
bun test
bun run build

docker compose up -d
bun run db:migrate
```

Depois executar os cenários de smoke descritos em `docs/smoke-test.http` e validar especialmente concorrência do saldo 100.00 com duas BET de 80.00.


## SQS Consumer e Inbox (v0.4.0)

O `SqsConsumerService` executa long polling na fila FIFO configurada em `SQS_QUEUE_NAME`. O envelope de entrada usa `type: WagerTransactionRequested`, `version: 1`, `messageId` estável, `correlationId` opcional e os dados da operação, incluindo `idempotencyKey`. `OPENING` é reservado para a criação interna da carteira e não é aceito como mensagem externa.

Para cada mensagem válida, o consumer abre uma transação PostgreSQL e adquire um advisory transaction lock específico para `(consumerName, messageId)`. Em seguida lê ou insere a linha da Inbox. Se a identidade já estiver processada com o mesmo hash, a mensagem é considerada redelivery e não chama o domínio financeiro. Se o mesmo ID vier com outro hash, é conflito permanente e a mensagem é enviada à DLQ.

Para uma mensagem nova, o consumer chama `WageringService.processWagerInTransaction()` com o mesmo EntityManager transacional. Assim, Inbox, wager transaction, eventual atualização da wallet, ledger e Outbox são confirmados no mesmo commit. `DeleteMessage` ocorre somente depois que `EntityManager.transactional()` termina com sucesso. Se o processo cair entre commit e ACK, a nova entrega encontra `processed_at` na Inbox e é removida sem novo efeito financeiro.

Falhas permanentes de envelope/negócio são copiadas para a DLQ com atributos de diagnóstico; a mensagem original é removida somente após confirmação do envio à DLQ. Se o envio à DLQ falhar, a original permanece sem ACK. Falhas transitórias (por exemplo, PostgreSQL indisponível) sofrem rollback e não recebem ACK; o SQS as redelivers e a `RedrivePolicy` da fila principal as move para DLQ após o limite configurado. O worker processa sequencialmente cada lote recebido e para novos polls durante shutdown; mensagens recebidas mas ainda não iniciadas permanecem invisíveis até o visibility timeout e são redelivered com segurança.

Limites da versão: crash recovery e publishers concorrentes ainda precisam ser validados em integração real; o consumer de entrada não consome a fila de eventos de saída. O `PENDING_REFERENCE` é persistido e ACKado como resultado da mensagem de entrada; a resolução posterior é executada pelo worker PostgreSQL, independente do SQS. O comportamento sob múltiplas instâncias e crash recovery deve ser confirmado pelos testes de integração antes de ser declarado validado.


## Outbox Publisher (v0.4.1)

O publisher seleciona um único evento elegível por transação, ordenado por `occurred_at` e `id`, usando `FOR UPDATE SKIP LOCKED`. A linha permanece bloqueada enquanto `SendMessage` é executado; depois de confirmação, o mesmo commit grava `published_at` e incrementa `attempts`. Em falha de envio, o commit grava `attempts` e `next_attempt_at` com backoff exponencial limitado. Eventos com retry futuro são ignorados temporariamente; eventos de outros agregados continuam avançando, enquanto eventos posteriores do mesmo agregado aguardam o anterior para preservar a ordem FIFO por wallet.

A readiness verifica PostgreSQL e a existência das filas SQS de entrada e saída. A fila de saída `wager-events.fifo` é separada da fila de entrada `wager-transactions.fifo`: a fila de entrada espera comandos `WagerTransactionRequested`, enquanto a fila de saída transporta envelopes `IntegrationEvent`. `aggregate_id` determina a ordem FIFO por agregado; `eventId` é usado como deduplication ID estável. A deduplicação SQS é apenas uma otimização temporária, não exactly-once.

Trade-off: manter o row lock durante a chamada SQS simplifica a exclusão mútua entre publishers e evita que dois processos publiquem simultaneamente a mesma linha. A contrapartida é manter uma transação SQL aberta durante a latência de rede. Em escala maior, uma estratégia com lease/claim persistente pode reduzir esse tempo, mas exigiria colunas adicionais e reconciliação de leases expirados.
