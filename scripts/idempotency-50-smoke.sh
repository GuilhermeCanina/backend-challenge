#!/usr/bin/env bash
# Sends the exact same BET 50 times concurrently with one Idempotency-Key.
# Requires: curl, jq, and the v0.4.2 API running with PostgreSQL/migrations ready.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
command -v jq >/dev/null || { echo 'jq is required. Install with: sudo pacman -S jq' >&2; exit 1; }

PLAYER_ID="$(cat /proc/sys/kernel/random/uuid)"
RUN_ID="$(date +%s)-$$"
PROVIDER_ID="idempotency-50-smoke-${RUN_ID}"
EXTERNAL_ID="bet-${RUN_ID}"
IDEMPOTENCY_KEY="${PROVIDER_ID}:${EXTERNAL_ID}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

WALLET_BODY="$(jq -nc --arg playerId "$PLAYER_ID" \
  '{playerId:$playerId,initialBalance:{amount:"100.00",currency:"BRL"}}')"
WALLET_RESPONSE="$(curl -fsS --max-time 10 -X POST "$BASE_URL/wallets" \
  -H 'Content-Type: application/json' -d "$WALLET_BODY")"
WALLET_ID="$(jq -er '.id' <<< "$WALLET_RESPONSE")"
echo "Created wallet: $WALLET_ID"

BET_BODY="$(jq -nc --arg providerId "$PROVIDER_ID" --arg externalId "$EXTERNAL_ID" \
  --arg playerId "$PLAYER_ID" --arg walletId "$WALLET_ID" \
  '{providerId:$providerId,externalTransactionId:$externalId,playerId:$playerId,walletId:$walletId,roundId:"idempotency-50-round",gameId:"idempotency-50-smoke",kind:"BET",money:{amount:"10.00",currency:"BRL"}}')"

echo 'Sending 50 concurrent requests with the same payload and Idempotency-Key...'
for i in $(seq 1 50); do
  (
    status="$(curl -sS --max-time 30 -o "$TMP_DIR/body-$i.json" -w '%{http_code}' \
      -X POST "$BASE_URL/wagering/transactions" \
      -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
      -d "$BET_BODY")" || status='000'
    printf '%s' "$status" > "$TMP_DIR/status-$i"
  ) &
done
wait

HTTP_200=0
for i in $(seq 1 50); do
  status="$(cat "$TMP_DIR/status-$i" 2>/dev/null || echo missing)"
  if [[ "$status" != '200' ]]; then
    echo "FAIL: request $i returned HTTP $status." >&2
    cat "$TMP_DIR/body-$i.json" 2>/dev/null | jq . >&2 || true
    exit 1
  fi
  HTTP_200=$((HTTP_200 + 1))
done

shopt -s nullglob
RESPONSES=("$TMP_DIR"/body-*.json)
if [[ "${#RESPONSES[@]}" -ne 50 ]]; then
  echo "FAIL: expected 50 response bodies, found ${#RESPONSES[@]}." >&2
  exit 1
fi

SUMMARY="$(jq -s -e '
  {
    responses: length,
    uniqueTransactions: ([.[].transactionId] | unique | length),
    originalRequests: ([.[] | select(.idempotentReplay == false)] | length),
    replays: ([.[] | select(.idempotentReplay == true)] | length),
    allProcessed: all(.[]; .status == "PROCESSED"),
    sameBalance: all(.[]; .balance.amount == "90.00")
  }
  | select(.responses == 50 and .uniqueTransactions == 1 and
           .originalRequests == 1 and .replays == 49 and
           .allProcessed and .sameBalance)
' "${RESPONSES[@]}")" || {
  echo 'FAIL: responses did not satisfy the idempotency invariants.' >&2
  jq -s '[.[] | {transactionId,status,balance,idempotentReplay}]' "${RESPONSES[@]}" >&2 || true
  exit 1
}

WALLET_FINAL="$(curl -fsS --max-time 10 "$BASE_URL/wallets/$WALLET_ID")"
FINAL_BALANCE="$(jq -r '.balance.amount' <<< "$WALLET_FINAL")"
LEDGER="$(curl -fsS --max-time 10 "$BASE_URL/wallets/$WALLET_ID/ledger?limit=50")"
LEDGER_COUNT="$(jq -r '.items | length' <<< "$LEDGER")"
RECONCILIATION="$(curl -fsS --max-time 10 -X POST "$BASE_URL/wallets/$WALLET_ID/reconciliation")"
CONSISTENT="$(jq -r '.consistent' <<< "$RECONCILIATION")"

if [[ "$HTTP_200" -ne 50 || "$FINAL_BALANCE" != '90.00' || \
      "$LEDGER_COUNT" != '2' || "$CONSISTENT" != 'true' ]]; then
  echo "FAIL: HTTP_200=$HTTP_200 balance=$FINAL_BALANCE ledger=$LEDGER_COUNT reconciliation=$CONSISTENT" >&2
  echo "$RECONCILIATION" | jq . >&2
  exit 1
fi

echo "$SUMMARY" | jq .
echo "HTTP 200 responses: $HTTP_200/50"
echo "Final wallet balance: R$ $FINAL_BALANCE"
echo "Ledger entries: $LEDGER_COUNT (OPENING + one BET)"
echo "Reconciliation: $CONSISTENT"
echo 'PASS: 50 concurrent identical submissions produced one financial transaction and 49 idempotent replays.'
