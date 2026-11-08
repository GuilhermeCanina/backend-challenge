#!/usr/bin/env bash
# Verifies the challenge's required race: two BET 80.00 against a 100.00 wallet.
# Requires: curl, jq, Docker services, migrations and API already running.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PLAYER_ID="$(cat /proc/sys/kernel/random/uuid)"
RUN_ID="$(date +%s)-$$"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

wallet_response="$(curl -fsS -X POST "$BASE_URL/wallets" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg playerId "$PLAYER_ID" '{playerId:$playerId,initialBalance:{amount:"100.00",currency:"BRL"}}')")"
WALLET_ID="$(jq -r '.id' <<<"$wallet_response")"
if [[ -z "$WALLET_ID" || "$WALLET_ID" == "null" ]]; then
  echo "Could not create wallet: $wallet_response" >&2
  exit 1
fi

post_bet() {
  local suffix="$1"
  local external_id="race-${RUN_ID}-${suffix}"
  local body
  body="$(jq -nc \
    --arg providerId 'race-smoke-provider' \
    --arg externalTransactionId "$external_id" \
    --arg playerId "$PLAYER_ID" \
    --arg walletId "$WALLET_ID" \
    '{providerId:$providerId,externalTransactionId:$externalTransactionId,playerId:$playerId,walletId:$walletId,roundId:"race-round",gameId:"race-game",kind:"BET",money:{amount:"80.00",currency:"BRL"}}')"
  curl -sS -o "$TMP_DIR/body-$suffix.json" -w '%{http_code}' \
    -X POST "$BASE_URL/wagering/transactions" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: race-${RUN_ID}-${suffix}" \
    -d "$body" > "$TMP_DIR/status-$suffix"
}

post_bet a & pid_a=$!
post_bet b & pid_b=$!
wait "$pid_a"
wait "$pid_b"

status_a="$(cat "$TMP_DIR/status-a")"
status_b="$(cat "$TMP_DIR/status-b")"
balance="$(curl -fsS "$BASE_URL/wallets/$WALLET_ID" | jq -r '.balance.amount')"
ledger_count="$(curl -fsS "$BASE_URL/wallets/$WALLET_ID/ledger?limit=50" | jq -r '.items | length')"

printf 'Wallet: %s\nBET A: HTTP %s %s\nBET B: HTTP %s %s\nFinal balance: %s BRL\nLedger entries: %s\n' \
  "$WALLET_ID" "$status_a" "$(cat "$TMP_DIR/body-a.json")" \
  "$status_b" "$(cat "$TMP_DIR/body-b.json")" "$balance" "$ledger_count"

if ! { [[ "$status_a" == '200' && "$status_b" == '422' ]] || [[ "$status_a" == '422' && "$status_b" == '200' ]]; }; then
  echo 'FAIL: expected exactly one HTTP 200 and one HTTP 422.' >&2
  exit 1
fi
if [[ "$balance" != '20.00' ]]; then
  echo "FAIL: expected final balance 20.00, got $balance." >&2
  exit 1
fi
if [[ "$ledger_count" != '2' ]]; then
  echo "FAIL: expected exactly 2 ledger entries (OPENING + one BET), got $ledger_count." >&2
  exit 1
fi

echo 'PASS: one BET processed, one rejected for insufficient funds, one debit only.'
