#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
command -v jq >/dev/null || { echo 'jq is required. Install with: sudo pacman -S jq' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'sudo is required to inspect PostgreSQL in this smoke test.' >&2; exit 1; }

PLAYER_ID="$(cat /proc/sys/kernel/random/uuid)"
ROUND_ID="pending-reference-$(date +%s)"
BET_EXTERNAL_ID="late-bet-${ROUND_ID}"
REFUND_EXTERNAL_ID="early-refund-${ROUND_ID}"
PROVIDER_ID="pending-reference-smoke"

WALLET_BODY="$(jq -nc --arg playerId "$PLAYER_ID" '{playerId:$playerId,initialBalance:{amount:"100.00",currency:"BRL"}}')"
WALLET_RESPONSE="$(curl -fsS --max-time 10 -X POST "$API_BASE_URL/wallets" -H 'Content-Type: application/json' -d "$WALLET_BODY")"
WALLET_ID="$(jq -er '.id' <<< "$WALLET_RESPONSE")"
echo "Created wallet: $WALLET_ID"

REFUND_BODY="$(jq -nc --arg providerId "$PROVIDER_ID" --arg externalId "$REFUND_EXTERNAL_ID" --arg playerId "$PLAYER_ID" --arg walletId "$WALLET_ID" --arg roundId "$ROUND_ID" --arg betExternalId "$BET_EXTERNAL_ID" \
  '{providerId:$providerId,externalTransactionId:$externalId,playerId:$playerId,walletId:$walletId,roundId:$roundId,gameId:"pending-reference-smoke",kind:"REFUND",money:{amount:"20.00",currency:"BRL"},referenceExternalTransactionId:$betExternalId}')"
REFUND_RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$REFUND_RESPONSE_FILE"' EXIT
HTTP_CODE="$(curl -sS --max-time 10 -o "$REFUND_RESPONSE_FILE" -w '%{http_code}' -X POST "$API_BASE_URL/wagering/transactions" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: ${PROVIDER_ID}:${REFUND_EXTERNAL_ID}" -d "$REFUND_BODY")"
if [[ "$HTTP_CODE" != "202" ]]; then
  echo "FAIL: expected REFUND without reference to return HTTP 202; got $HTTP_CODE." >&2
  cat "$REFUND_RESPONSE_FILE" >&2
  exit 1
fi
REFUND_ID="$(jq -er '.transactionId' "$REFUND_RESPONSE_FILE")"
echo "REFUND persisted as PENDING_REFERENCE: $REFUND_ID"

# Wait until the worker has actually observed the missing reference and persisted a retry.
RETRY_ATTEMPTS="0"
for attempt in $(seq 1 40); do
  RETRY_ATTEMPTS="$(sudo docker exec wagering-postgres psql -U wagering -d wagering -Atc \
    "select reference_attempts from wager_transactions where id = '$REFUND_ID' and status = 'PENDING_REFERENCE';")"
  if [[ "${RETRY_ATTEMPTS:-0}" =~ ^[1-9][0-9]*$ ]]; then
    break
  fi
  sleep 0.25
done
if [[ ! "${RETRY_ATTEMPTS:-0}" =~ ^[1-9][0-9]*$ ]]; then
  echo 'FAIL: worker did not persist a retry for the missing reference. Check worker startup and migration.' >&2
  exit 1
fi
echo "Worker persisted missing-reference retry attempt: $RETRY_ATTEMPTS"

BET_BODY="$(jq -nc --arg providerId "$PROVIDER_ID" --arg externalId "$BET_EXTERNAL_ID" --arg playerId "$PLAYER_ID" --arg walletId "$WALLET_ID" --arg roundId "$ROUND_ID" \
  '{providerId:$providerId,externalTransactionId:$externalId,playerId:$playerId,walletId:$walletId,roundId:$roundId,gameId:"pending-reference-smoke",kind:"BET",money:{amount:"20.00",currency:"BRL"}}')"
curl -fsS --max-time 10 -X POST "$API_BASE_URL/wagering/transactions" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: ${PROVIDER_ID}:${BET_EXTERNAL_ID}" -d "$BET_BODY" >/dev/null
echo "Submitted the referenced BET: $BET_EXTERNAL_ID"

FINAL_STATUS="PENDING_REFERENCE"
for attempt in $(seq 1 60); do
  TRANSACTION_RESPONSE="$(curl -fsS --max-time 5 "$API_BASE_URL/wagering/transactions/$REFUND_ID")"
  FINAL_STATUS="$(jq -r '.status' <<< "$TRANSACTION_RESPONSE")"
  if [[ "$FINAL_STATUS" == "PROCESSED" || "$FINAL_STATUS" == "REJECTED" || "$FINAL_STATUS" == "FAILED" ]]; then
    break
  fi
  sleep 0.5
done

if [[ "$FINAL_STATUS" != "PROCESSED" ]]; then
  echo "FAIL: expected pending REFUND to become PROCESSED; got $FINAL_STATUS." >&2
  echo "$TRANSACTION_RESPONSE" | jq . >&2
  sudo docker exec wagering-postgres psql -U wagering -d wagering -c \
    "select id, kind, status, failure_code, reference_attempts, reference_next_attempt_at from wager_transactions where wallet_id = '$WALLET_ID' order by created_at, id;" || true
  exit 1
fi

WALLET_FINAL="$(curl -fsS --max-time 5 "$API_BASE_URL/wallets/$WALLET_ID")"
FINAL_BALANCE="$(jq -r '.balance.amount' <<< "$WALLET_FINAL")"
RECONCILIATION="$(curl -fsS --max-time 5 -X POST "$API_BASE_URL/wallets/$WALLET_ID/reconciliation")"
CONSISTENT="$(jq -r '.consistent' <<< "$RECONCILIATION")"
LEDGER_COUNT="$(sudo docker exec wagering-postgres psql -U wagering -d wagering -Atc \
  "select count(*) from wallet_ledger_entries where wallet_id = '$WALLET_ID';")"

if [[ "$FINAL_BALANCE" != "100.00" || "$CONSISTENT" != "true" || "$LEDGER_COUNT" != "3" ]]; then
  echo "FAIL: unexpected final state: balance=$FINAL_BALANCE consistent=$CONSISTENT ledger=$LEDGER_COUNT" >&2
  echo "$RECONCILIATION" | jq . >&2
  exit 1
fi

echo "REFUND status: $FINAL_STATUS"
echo "Final wallet balance: R$ $FINAL_BALANCE"
echo "Ledger entries: $LEDGER_COUNT (OPENING + BET + REFUND)"
echo "Reconciliation: $CONSISTENT"
echo 'PASS: a REFUND received before its BET was retried and processed exactly once after the reference arrived.'
