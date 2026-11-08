#!/usr/bin/env bash
set -euo pipefail

DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
EVENTS_QUEUE_NAME="wager-events.fifo"

awslocal sqs create-queue \
  --queue-name "$DLQ_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

DLQ_URL="$(awslocal sqs get-queue-url --queue-name "$DLQ_NAME" --query QueueUrl --output text)"
DLQ_ARN="$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)"

# Generate valid nested JSON without shell/printf escaping ambiguities.
ATTRIBUTES="$(DLQ_ARN="$DLQ_ARN" python3 - <<'PYJSON'
import json
import os

redrive = {
    "deadLetterTargetArn": os.environ["DLQ_ARN"],
    "maxReceiveCount": "5",
}
print(json.dumps({
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "VisibilityTimeout": "60",
    "RedrivePolicy": json.dumps(redrive, separators=(",", ":")),
}))
PYJSON
)"

awslocal sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "$ATTRIBUTES" >/dev/null

echo "SQS queues ready: $QUEUE_NAME -> $DLQ_NAME (maxReceiveCount=5)"

# Outbound integration events use a separate FIFO queue; the inbound consumer
# only accepts WagerTransactionRequested commands.
awslocal sqs create-queue \
  --queue-name "$EVENTS_QUEUE_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

echo "SQS outbound events queue ready: $EVENTS_QUEUE_NAME"
