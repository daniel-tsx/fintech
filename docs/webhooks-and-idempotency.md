# Webhooks and idempotency

Status: current.

## API idempotency

Money-moving endpoints require `Idempotency-Key`. The row key is `(merchant, operation, key)`. The request body is canonicalized and SHA-256 hashed. A first caller inserts `IN_PROGRESS` and performs the local mutation in the same transaction. PostgreSQL's unique constraint chooses the winner when concurrent requests race. A loser reads the committed row: same hash replays the stored status/body; a different hash returns `422`; an in-flight record returns `409`.

Keys are durable and have no automatic short TTL because retries and dead-letter replay can outlive a cache window. Redis is never used as the idempotency authority.

## Webhook inbox

The receiver verifies an HMAC SHA-256 signature against the raw payload before insertion. It stores payload, headers, receipt time, and provider event ID before returning `202`. Duplicates conflict on the provider event ID and return the original inbox ID.

Workers claim pending events with `FOR UPDATE SKIP LOCKED`, set a processing lease, and dispatch by event type. Each business side effect has an independent uniqueness key (`provider event`, `provider transaction`, or ledger business reference), so lease expiry and duplicate queue delivery are safe. Unknown event types are retained as `IGNORED`; invalid transitions become inspectable failures. Out-of-order events stay pending with bounded retry until prerequisites appear, then move to dead-letter state.

At-least-once delivery is assumed. Exactly-once delivery is not.
