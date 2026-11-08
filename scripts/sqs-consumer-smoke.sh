#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
QUEUE_NAME="${SQS_QUEUE_NAME:-wager-transactions.fifo}"
DLQ_NAME="${SQS_DLQ_NAME:-wager-transactions-dlq.fifo}"
CONSUMER_NAME="${SQS_CONSUMER_NAME:-wager-transaction-consumer-v1}"
RUN_ID="$(date +%s)-$$"
PLAYER_ID="$(cat /proc/sys/kernel/random/uuid)"
CORRELATION_ID="$(cat /proc/sys/kernel/random/uuid)"
MESSAGE_ID="sqs-smoke-${RUN_ID}"
IDEMPOTENCY_KEY="sqs-smoke:${RUN_ID}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (Arch Linux: sudo pacman -S jq)." >&2
  exit 1
fi
if ! curl -fsS --max-time 3 "${API_URL}/health/ready" >/dev/null; then
  echo "ERROR: API is not ready at ${API_URL}. Start bun run dev first." >&2
  exit 1
fi

sudo -v

WALLET_RESPONSE="$(curl -fsS -X POST "${API_URL}/wallets" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg playerId "$PLAYER_ID" '{playerId:$playerId,initialBalance:{amount:"100.00",currency:"BRL"}}')")"
WALLET_ID="$(jq -r '.id' <<< "$WALLET_RESPONSE")"
if [[ -z "$WALLET_ID" || "$WALLET_ID" == "null" ]]; then
  echo "ERROR: wallet creation did not return an id: $WALLET_RESPONSE" >&2
  exit 1
fi

MESSAGE_BODY="$(jq -nc \
  --arg messageId "$MESSAGE_ID" \
  --arg correlationId "$CORRELATION_ID" \
  --arg playerId "$PLAYER_ID" \
  --arg walletId "$WALLET_ID" \
  --arg externalId "bet-${RUN_ID}" \
  --arg idempotencyKey "$IDEMPOTENCY_KEY" \
  '{messageId:$messageId,type:"WagerTransactionRequested",version:1,correlationId:$correlationId,occurredAt:(now|todate),data:{providerId:"sqs-smoke",externalTransactionId:$externalId,idempotencyKey:$idempotencyKey,playerId:$playerId,walletId:$walletId,roundId:"sqs-smoke-round",gameId:"sqs-smoke-game",kind:"BET",money:{amount:"25.00",currency:"BRL"}}}')"

get_queue_url() {
  sudo docker exec wagering-localstack awslocal sqs get-queue-url \
    --queue-name "$QUEUE_NAME" --query QueueUrl --output text
}

get_dlq_url() {
  sudo docker exec wagering-localstack awslocal sqs get-queue-url \
    --queue-name "$DLQ_NAME" --query QueueUrl --output text
}

send_message() {
  local dedup_id="$1"
  sudo docker exec \
    -e MESSAGE_BODY="$MESSAGE_BODY" \
    -e MESSAGE_GROUP_ID="$PLAYER_ID" \
    -e MESSAGE_DEDUP_ID="$dedup_id" \
    -e QUEUE_NAME="$QUEUE_NAME" \
    wagering-localstack sh -lc '
      QUEUE_URL="$(awslocal sqs get-queue-url --queue-name "$QUEUE_NAME" --query QueueUrl --output text)"
      awslocal sqs send-message \
        --queue-url "$QUEUE_URL" \
        --message-group-id "$MESSAGE_GROUP_ID" \
        --message-deduplication-id "$MESSAGE_DEDUP_ID" \
        --message-body "$MESSAGE_BODY" >/dev/null
    '
}

sql() {
  sudo docker exec wagering-postgres psql -U wagering -d wagering -Atqc "$1"
}

wait_for_inbox() {
  for _ in $(seq 1 30); do
    local processed
    processed="$(sql "select coalesce((processed_at is not null)::text, 'false') from inbox_messages where consumer_name='${CONSUMER_NAME}' and message_id='${MESSAGE_ID}' limit 1" | tail -n 1)"
    if [[ "$processed" == "true" ]]; then return 0; fi
    sleep 1
  done
  echo "ERROR: Inbox message was not marked processed within 30 seconds." >&2
  return 1
}

wait_for_source_queue_empty() {
  local queue_url="$1"
  local consecutive_empty=0
  for _ in $(seq 1 30); do
    local attributes visible invisible
    attributes="$(sudo docker exec wagering-localstack awslocal sqs get-queue-attributes \
      --queue-url "$queue_url" \
      --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible)"
    visible="$(jq -r '.Attributes.ApproximateNumberOfMessages // "0"' <<< "$attributes")"
    invisible="$(jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"' <<< "$attributes")"
    if [[ "$visible" == "0" && "$invisible" == "0" ]]; then
      consecutive_empty=$((consecutive_empty + 1))
      if [[ "$consecutive_empty" -ge 3 ]]; then return 0; fi
    else
      consecutive_empty=0
    fi
    sleep 1
  done
  echo "ERROR: SQS source queue did not drain within 30 seconds." >&2
  return 1
}

echo "Wallet: $WALLET_ID"
echo "Sending first SQS message: $MESSAGE_ID"
send_message "${MESSAGE_ID}-delivery-1"
wait_for_inbox

echo "Sending duplicate business message with a different SQS deduplication ID."
send_message "${MESSAGE_ID}-delivery-2"
QUEUE_URL="$(get_queue_url)"
wait_for_source_queue_empty "$QUEUE_URL"

RESULT="$(sql "select w.balance::text || '|' || w.version::text || '|' || (select count(*) from wallet_ledger_entries l where l.wallet_id=w.id)::text || '|' || (select count(*) from wager_transactions t where t.wallet_id=w.id)::text || '|' || (select count(*) from inbox_messages i where i.consumer_name='${CONSUMER_NAME}' and i.message_id='${MESSAGE_ID}')::text from wallets w where w.id='${WALLET_ID}'")"
EXPECTED="75.00|2|2|2|1"

echo "Balance|Version|Ledger entries|Wager transactions|Inbox records: $RESULT"
if [[ "$RESULT" != "$EXPECTED" ]]; then
  echo "FAIL: expected $EXPECTED" >&2
  exit 1
fi

echo "Sending malformed SQS message to verify permanent failures reach the DLQ."
DLQ_URL="$(get_dlq_url)"
POISON_MESSAGE_ID="$(sudo docker exec \
  -e QUEUE_NAME="$QUEUE_NAME" \
  -e POISON_DEDUP_ID="poison-${RUN_ID}" \
  -e POISON_GROUP_ID="poison-${RUN_ID}" \
  wagering-localstack sh -lc '
    QUEUE_URL="$(awslocal sqs get-queue-url --queue-name "$QUEUE_NAME" --query QueueUrl --output text)"
    awslocal sqs send-message \
      --queue-url "$QUEUE_URL" \
      --message-group-id "$POISON_GROUP_ID" \
      --message-deduplication-id "$POISON_DEDUP_ID" \
      --message-body "{" \
      --query MessageId --output text
  ')"

DLQ_MATCH=""
for _ in $(seq 1 30); do
  DLQ_BATCH="$(sudo docker exec wagering-localstack awslocal sqs receive-message \
    --queue-url "$DLQ_URL" \
    --max-number-of-messages 10 \
    --wait-time-seconds 1 \
    --message-attribute-names All)"
  DLQ_MATCH="$(jq -c --arg sourceId "$POISON_MESSAGE_ID" \
    '[.Messages[]? | select(.MessageAttributes.SourceMessageId.StringValue == $sourceId)][0] // empty' \
    <<< "$DLQ_BATCH")"
  if [[ -n "$DLQ_MATCH" ]]; then break; fi
  sleep 1
done

if [[ -z "$DLQ_MATCH" ]]; then
  echo "FAIL: malformed message was not copied to the DLQ." >&2
  exit 1
fi
DLQ_FAILURE_CODE="$(jq -r '.MessageAttributes.FailureCode.StringValue // ""' <<< "$DLQ_MATCH")"
DLQ_RECEIPT_HANDLE="$(jq -r '.ReceiptHandle' <<< "$DLQ_MATCH")"
if [[ "$DLQ_FAILURE_CODE" != "INVALID_MESSAGE" ]]; then
  echo "FAIL: expected INVALID_MESSAGE in DLQ, got '$DLQ_FAILURE_CODE'." >&2
  exit 1
fi
sudo docker exec \
  -e DLQ_URL="$DLQ_URL" \
  -e DLQ_RECEIPT_HANDLE="$DLQ_RECEIPT_HANDLE" \
  wagering-localstack sh -lc '
    awslocal sqs delete-message --queue-url "$DLQ_URL" --receipt-handle "$DLQ_RECEIPT_HANDLE" >/dev/null
  '
wait_for_source_queue_empty "$QUEUE_URL"

echo "PASS: valid SQS message, duplicate Inbox delivery, atomic financial processing, and invalid-message DLQ handling."
