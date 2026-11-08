# Distributed Wagering Processor — Implementation Notes

> Implementação do desafio técnico da Jungle Gaming. O enunciado original permanece em [`../README.md`](../README.md). Este documento descreve a solução, como executá-la e quais cenários foram validados.

## 1. Visão geral

O serviço processa operações financeiras de provedores de jogos (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) sobre carteiras em BRL. O foco da implementação é preservar as invariantes financeiras diante de requisições repetidas, concorrência entre instâncias, mensagens fora de ordem e reinicializações de workers.

A solução utiliza processamento transacional no PostgreSQL, idempotência persistida, Inbox/Outbox e filas SQS FIFO provisionadas pelo LocalStack.

## 2. Stack

- **Runtime e package manager:** Bun 1.x
- **Linguagem:** TypeScript em modo estrito
- **Framework:** NestJS
- **Persistência:** PostgreSQL 16
- **ORM e migrations:** MikroORM 7
- **Mensageria local:** AWS SQS via LocalStack
- **Aritmética monetária:** `decimal.js`
- **Orquestração:** Docker Compose

## 3. Arquitetura e fluxo financeiro

A entrada HTTP e o consumidor SQS reutilizam o mesmo caso de uso de processamento financeiro. As regras de negócio ficam no domínio; a persistência coordena wallet, wager transaction, ledger, Inbox e Outbox por meio de transações SQL.

### 3.1 Dinheiro e carteira

Os valores monetários trafegam como strings decimais com duas casas (`"25.00"`) e moeda ISO (`"BRL"`). A implementação utiliza aritmética decimal exata, evitando `number`/ponto flutuante para cálculos financeiros.

A carteira mantém saldo materializado e versão. Uma mudança de saldo gera um lançamento correspondente no ledger dentro da mesma transação SQL. O ledger é tratado como histórico auditável; a reconciliação compara o saldo armazenado com o saldo reconstruído a partir dos lançamentos.

### 3.2 Regras de operação

| Operação | Efeito no saldo | Ledger |
|---|---|---|
| `BET` | Débito; rejeita saldo insuficiente | `DEBIT` |
| `WIN` | Crédito | `CREDIT` |
| `LOSS` | Nenhum | Nenhum |
| `REFUND` | Crédito do valor da BET referenciada | `CREDIT` |
| `ROLLBACK` | Movimento inverso ao da transação referenciada | Direção inversa |

`REFUND` e `ROLLBACK` dependem de uma transação de referência válida. Uma referência ainda inexistente é persistida como `PENDING_REFERENCE` para reprocessamento posterior. Repetições idênticas são tratadas por idempotência persistida; a reutilização da mesma chave com conteúdo de negócio diferente é conflito.

### 3.3 Concorrência e idempotência

A consistência não depende da memória de uma instância nem exclusivamente dos recursos FIFO do SQS. O PostgreSQL é a fonte de verdade para deduplicação e concorrência. As requisições concorrentes compartilham as mesmas restrições e registros persistidos, permitindo que diferentes instâncias HTTP processem solicitações para a mesma carteira sem duplicar o efeito financeiro.

### 3.4 Inbox e consumidor SQS

O consumidor registra a mensagem na Inbox usando a identidade do consumidor e o identificador da mensagem. A Inbox, a transação financeira e os eventos de Outbox são persistidos atomicamente. O ACK da mensagem ocorre somente após o commit. Uma redelivery de mensagem já processada é reconhecida pela Inbox e não repete o efeito financeiro.

Erros permanentes de mensagem inválida são encaminhados à DLQ. Mensagens sujeitas a falha transitória permanecem disponíveis para redelivery conforme a política de visibilidade e consumo configurada.

### 3.5 Transactional Outbox

Os eventos de integração são gravados na mesma transação SQL que confirma a alteração financeira. Um publisher separado envia os eventos pendentes ao SQS e registra `published_at` após a aceitação pelo broker.

O publisher usa seleção concorrente com `FOR UPDATE SKIP LOCKED`, permitindo múltiplos publishers. A publicação segue semântica **at-least-once**: uma queda depois de o SQS aceitar a mensagem, mas antes do registro de publicação no banco, pode causar uma nova entrega. Consumidores downstream devem deduplicar pelo `eventId` estável.

### 3.6 Worker de referências pendentes

O worker consulta operações `PENDING_REFERENCE`, controla tentativas no PostgreSQL e agenda novas tentativas com backoff exponencial. Quando a referência aparece, a operação é reprocessada pelo fluxo financeiro. O limite de tentativas e o TTL são configuráveis por variáveis de ambiente; ao esgotar a política, a operação é rejeitada de forma auditável.

## 4. Requisitos

- Bun 1.x
- Docker Engine e Docker Compose plugin
- PostgreSQL e LocalStack iniciados pelo Compose

## 5. Configuração e execução local

1. Instale Bun e Docker no ambiente.
2. Copie o arquivo de exemplo de ambiente:

   ```bash
   cp .env.example .env
   ```

3. Suba as dependências:

   ```bash
   docker compose up -d
   ```

4. Aplique as migrations:

   ```bash
   bun install --frozen-lockfile
   bun run db:migrate
   ```

5. Inicie a API e os workers habilitados pela configuração:

   ```bash
   bun run dev
   ```

O script em `.localstack/init/ready.d/` provisiona as filas quando o LocalStack executa sua inicialização. Caso o container LocalStack já estivesse em execução antes da inclusão/alteração do script, recrie-o ou crie as filas necessárias manualmente antes dos testes.

A configuração local de exemplo utiliza PostgreSQL em `localhost:5432` e LocalStack em `localhost:4566`. Consulte `.env.example` para a lista completa de parâmetros e valores padrão. Não versione o arquivo `.env` real.

## 6. API HTTP

Os principais endpoints previstos pela implementação são:

| Método | Endpoint | Finalidade |
|---|---|---|
| `POST` | `/wallets` | Criar carteira e registrar `OPENING`/ledger quando aplicável |
| `GET` | `/wallets/:walletId` | Consultar carteira |
| `GET` | `/wallets/:walletId/ledger` | Consultar lançamentos |
| `POST` | `/wagering/transactions` | Submeter operação com `Idempotency-Key` |
| `GET` | `/wagering/transactions/:transactionId` | Consultar operação |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar operação externa |
| `POST` | `/wallets/:walletId/reconciliation` | Reconciliar saldo e ledger |
| `GET` | `/health/live` | Liveness |
| `GET` | `/health/ready` | Readiness de PostgreSQL e SQS |

Exemplo de submissão:

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-123
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "<player-uuid>",
  "walletId": "<wallet-uuid>",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

A chave de idempotência deve ser enviada no header. O hash de payload considera os campos de negócio, não metadados de transporte.

## 7. Filas

A configuração padrão utiliza:

- `wager-transactions.fifo`: entrada de operações;
- `wager-transactions-dlq.fifo`: mensagens permanentes/inválidas encaminhadas à DLQ;
- `wager-events.fifo`: eventos publicados pela Outbox.

Os nomes e parâmetros de conexão são configuráveis em `.env`. Em ambiente local, o endpoint SQS é fornecido pelo LocalStack.

## 8. Validação e testes

### 8.1 Validação automatizada

```bash
bun run validate
```

Esse comando executa o typecheck, a suíte unitária e o build NestJS.

### 8.2 Testes de integração

Com PostgreSQL, LocalStack, migrations e API/worker configurados:

```bash
bun run test:sqs
bun run test:outbox
bun run test:pending-reference
```

### 8.3 Scripts de concorrência

Os scripts abaixo exercitam cenários adicionais no ambiente local. Para os testes multi-instância, inicie cada instância em uma porta diferente, compartilhando o mesmo PostgreSQL e LocalStack:

```bash
PORT=3000 bun run dev
PORT=3001 bun run dev
PORT=3002 bun run dev
```

Em outro terminal:

```bash
./scripts/concurrency-smoke.sh
./scripts/idempotency-50-smoke.sh
./scripts/multi-instance-idempotency-smoke.sh
```

Os scripts de integração e concorrência devem ser executados em ambiente descartável/de teste, pois criam carteiras, transações e mensagens reais.

### 8.4 Evidências executadas durante o desenvolvimento

No ambiente local Arch Linux, com Bun 1.4.4, PostgreSQL e LocalStack em containers, foram observados os seguintes resultados:

| Cenário | Resultado observado |
|---|---|
| TypeScript, testes unitários e build (`bun run validate`) | 53 testes aprovados; typecheck e build aprovados |
| SQS, Inbox, duplicidade e mensagem inválida/DLQ (`bun run test:sqs`) | Aprovado; uma transação financeira, uma Inbox processada e mensagem inválida encaminhada à DLQ |
| Outbox (`bun run test:outbox`) | Aprovado; eventos aceitos pelo SQS antes de `published_at` ser marcado |
| Referência fora de ordem (`bun run test:pending-reference`) | Aprovado; REFUND anterior à BET foi reprocessado, com reconciliação consistente |
| 50 submissões idênticas em paralelo | Aprovado; 1 transação, 49 replays e um único débito |
| 50 submissões distribuídas em três instâncias HTTP | Aprovado; distribuição 17/17/16, 1 transação e 49 replays |
| Publishers concorrentes em três instâncias | 40 eventos publicados, 0 pendentes e nenhuma linha com número de tentativas diferente de 1 no recorte consultado |
| Crash do Consumer após commit e antes do ACK | Aprovado; redelivery reconhecida pela Inbox sem segundo efeito financeiro |
| Crash do Publisher após aceitação pelo SQS e antes do commit no banco | Aprovado; eventos recuperados após reinício e linhas da Outbox marcadas como publicadas |

Os testes de crash utilizaram instrumentação temporária de fault injection, removida após a validação. Os resultados acima são evidências dos cenários executados no ambiente de desenvolvimento, não uma garantia de comportamento em qualquer infraestrutura.

## 9. Limitações conhecidas e próximos passos

- O fluxo de retry transitório do Consumer e o esgotamento de tentativas até DLQ precisam de uma validação de integração dedicada, incluindo indisponibilidade temporária do PostgreSQL.
- As métricas exigidas pelo desafio (transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência) precisam ser conferidas/completadas antes de considerar observabilidade integralmente atendida.
- Os testes multi-instância executados cobrem idempotência HTTP e concorrência dos publishers; não representam, por si só, todos os cenários possíveis de disputa de wallet entre workers.
- A entrega de eventos é at-least-once. Consumidores downstream precisam implementar deduplicação por `eventId`.
- A autenticação não foi implementada nesta entrega; o enunciado permite deixá-la fora do escopo desde que a decisão e o ponto de extensão sejam documentados na arquitetura.

## 10. Decisões arquiteturais

As decisões de domínio, concorrência, persistência, mensageria, trade-offs e limitações estão detalhadas em [`../ARCHITECTURE.md`](../ARCHITECTURE.md). O enunciado original e seus critérios permanecem disponíveis em [`../README.md`](../README.md).
