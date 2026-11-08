#!/usr/bin/env bash
# Sends 50 identical BET requests across three API instances sharing PostgreSQL.
# Requires curl and jq. Start three app processes on ports 3000, 3001 and 3002 first.
set -euo pipefail

API_1="${API_1:-http://localhost:3000}"
API_2="${API_2:-http://localhost:3001}"
API_3="${API_3:-http://localhost:3002}"
APIS=("$API_1" "$API_2" "$API_3")

command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
command -v jq >/dev/null || { echo 'jq is required. Install with: sudo pacman -S jq' >&2; exit 1; }

for api in "${APIS[@]}"; do
  if ! curl -fsS --max-time 5 "$api/health/ready" >/dev/null; then
    echo "FAIL: $api is not ready. Confirm all three instances are running." >&2
    exit 1
  fi
done

PLAYER_ID="$(cat /proc/sys/kernel/random/uuid)"
RUN_ID="$(date +%s)-$$"
PROVIDER_ID="multi-instance-idempotency-${RUN_ID}"
EXTERNAL_ID="bet-${RUN_ID}"
IDEMPOTENCY_KEY="${PROVIDER_ID}:${EXTERNAL_ID}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

WALLET_BODY="$(jq -nc --arg playerId "$PLAYER_ID" \
  '{playerId:$playerId,initialBalance:{amount:"100.00",currency:"BRL"}}')"
WALLET_RESPONSE="$(curl -fsS --max-time 10 -X POST "${API_1}/wallets" \
  -H 'Content-Type: application/json' -d "$WALLET_BODY")"
WALLET_ID="$(jq -er '.id' <<< "$WALLET_RESPONSE")"
echo "Created wallet through instance 1: $WALLET_ID"

BET_BODY="$(jq -nc --arg providerId "$PROVIDER_ID" --arg externalId "$EXTERNAL_ID" \
  --arg playerId "$PLAYER_ID" --arg walletId "$WALLET_ID" \
  '{providerId:$providerId,externalTransactionId:$externalId,playerId:$playerId,walletId:$walletId,roundId:"multi-instance-round",gameId:"multi-instance-smoke",kind:"BET",money:{amount:"10.00",currency:"BRL"}}')"

echo 'Sending 50 identical requests distributed across ports 3000, 3001 and 3002...'
for i in $(seq 1 50); do
  (
    api_index=$(((i - 1) % 3))
    api="${APIS[$api_index]}"
    status="$(curl -sS --max-time 30 -o "$TMP_DIR/body-$i.json" -w '%{http_code}' \
      -X POST "$api/wagering/transactions" \
      -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
      -d "$BET_BODY")" || status='000'
    printf '%s' "$status" > "$TMP_DIR/status-$i"
    printf '%s' "$api_index" > "$TMP_DIR/instance-$i"
  ) &
done
wait

for i in $(seq 1 50); do
  status="$(cat "$TMP_DIR/status-$i" 2>/dev/null || echo missing)"
  if [[ "$status" != '200' ]]; then
    echo "FAIL: request $i returned HTTP $status." >&2
    cat "$TMP_DIR/body-$i.json" 2>/dev/null | jq . >&2 || true
    exit 1
  fi
done

RESPONSES=("$TMP_DIR"/body-*.json)
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
  echo 'FAIL: cross-instance responses violated idempotency invariants.' >&2
  jq -s '[.[] | {transactionId,status,balance,idempotentReplay}]' "${RESPONSES[@]}" >&2 || true
  exit 1
}

WALLET_FINAL="$(curl -fsS --max-time 10 "${API_1}/wallets/$WALLET_ID")"
FINAL_BALANCE="$(jq -r '.balance.amount' <<< "$WALLET_FINAL")"
LEDGER="$(curl -fsS --max-time 10 "${API_1}/wallets/$WALLET_ID/ledger?limit=50")"
LEDGER_COUNT="$(jq -r '.items | length' <<< "$LEDGER")"
RECONCILIATION="$(curl -fsS --max-time 10 -X POST "${API_1}/wallets/$WALLET_ID/reconciliation")"
CONSISTENT="$(jq -r '.consistent' <<< "$RECONCILIATION")"

if [[ "$FINAL_BALANCE" != '90.00' || "$LEDGER_COUNT" != '2' || "$CONSISTENT" != 'true' ]]; then
  echo "FAIL: balance=$FINAL_BALANCE ledger=$LEDGER_COUNT reconciliation=$CONSISTENT" >&2
  jq . <<< "$RECONCILIATION" >&2
  exit 1
fi

printf 'Requests sent to each instance: '
for index in 0 1 2; do
  count="$(grep -l "^$index$" "$TMP_DIR"/instance-* 2>/dev/null | wc -l | tr -d ' ')"
  printf '%s=%s ' "$((index + 1))" "$count"
done
printf '\n'
echo "$SUMMARY" | jq .
echo 'HTTP 200 responses: 50/50'
echo "Final wallet balance: R$ $FINAL_BALANCE"
echo "Ledger entries: $LEDGER_COUNT (OPENING + one BET)"
echo "Reconciliation: $CONSISTENT"
echo 'PASS: three API instances handled 50 identical concurrent requests with one financial effect and 49 idempotent replays.'
