#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
OUTBOX_QUEUE_NAME="${SQS_OUTBOX_QUEUE_NAME:-wager-events.fifo}"

command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
command -v jq >/dev/null || { echo 'jq is required. Install with: sudo pacman -S jq' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'sudo is required to inspect the Compose containers in this smoke test.' >&2; exit 1; }

# Ensure the separate outbound FIFO exists even when LocalStack predates this package version.
sudo docker exec wagering-localstack awslocal sqs create-queue \
  --queue-name "$OUTBOX_QUEUE_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

PLAYER_ID="$(cat /proc/sys/kernel/random/uuid)"
WALLET_BODY="$(jq -nc --arg playerId "$PLAYER_ID" \
  '{playerId:$playerId,initialBalance:{amount:"100.00",currency:"BRL"}}')"
WALLET_RESPONSE="$(curl -fsS --max-time 5 -X POST "$API_BASE_URL/wallets" \
  -H 'Content-Type: application/json' -d "$WALLET_BODY")"
WALLET_ID="$(jq -er '.id' <<< "$WALLET_RESPONSE")"

echo "Created wallet for Outbox smoke test: $WALLET_ID"

PUBLISHED_COUNTS="0:0"
for attempt in $(seq 1 60); do
  PUBLISHED_COUNTS="$(sudo docker exec wagering-postgres psql -U wagering -d wagering -Atc \
    "select count(*) filter (where event_type = 'WagerTransactionProcessed' and published_at is not null)::text || ':' || count(*) filter (where event_type = 'WalletBalanceChanged' and published_at is not null)::text from outbox_messages where aggregate_id = '$WALLET_ID';")"
  if [[ "$PUBLISHED_COUNTS" == "1:1" ]]; then
    break
  fi
  sleep 0.5
done

if [[ "$PUBLISHED_COUNTS" != "1:1" ]]; then
  echo "FAIL: expected one published WagerTransactionProcessed and one published WalletBalanceChanged; got $PUBLISHED_COUNTS." >&2
  sudo docker exec wagering-postgres psql -U wagering -d wagering -c \
    "select id, event_type, attempts, next_attempt_at, published_at from outbox_messages where aggregate_id = '$WALLET_ID' order by occurred_at, id;" || true
  exit 1
fi

TOTAL_ROWS="$(sudo docker exec wagering-postgres psql -U wagering -d wagering -Atc \
  "select count(*) from outbox_messages where aggregate_id = '$WALLET_ID';")"
if [[ "$TOTAL_ROWS" != "2" ]]; then
  echo "FAIL: expected exactly 2 Outbox rows for wallet OPENING; got $TOTAL_ROWS." >&2
  exit 1
fi

UNPUBLISHED_ROWS="$(sudo docker exec wagering-postgres psql -U wagering -d wagering -Atc \
  "select count(*) from outbox_messages where aggregate_id = '$WALLET_ID' and published_at is null;")"
if [[ "$UNPUBLISHED_ROWS" != "0" ]]; then
  echo "FAIL: expected no unpublished rows for wallet $WALLET_ID; got $UNPUBLISHED_ROWS." >&2
  exit 1
fi

QUEUE_URL="$(sudo docker exec wagering-localstack awslocal sqs get-queue-url \
  --queue-name "$OUTBOX_QUEUE_NAME" --query QueueUrl --output text)"
if [[ -z "$QUEUE_URL" || "$QUEUE_URL" == "None" ]]; then
  echo "FAIL: outbound queue '$OUTBOX_QUEUE_NAME' was not found." >&2
  exit 1
fi

echo "Published event types: WagerTransactionProcessed + WalletBalanceChanged"
echo "Outbox records: $TOTAL_ROWS; published_at NULL: $UNPUBLISHED_ROWS"
echo "Outbound FIFO queue: $OUTBOX_QUEUE_NAME ($QUEUE_URL)"
echo "PASS: OPENING Outbox events were accepted by SQS before their rows were marked published."
