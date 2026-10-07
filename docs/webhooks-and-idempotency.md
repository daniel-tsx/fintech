# Webhooks and idempotency

Status: current.

## API idempotency

Money-moving endpoints require `Idempotency-Key`. The row key is `(merchant, operation, key)`. The request body is canonicalized and SHA-256 hashed. A first caller inserts `IN_PROGRESS` and performs the local mutation in the same transaction. PostgreSQL's unique constraint chooses the winner when concurrent requests race. A loser reads the committed row: same hash replays the stored status/body; a different hash returns `422`; an in-flight record returns `409`.

Keys are durable and have no automatic short TTL because retries and dead-letter replay can outlive a cache window. Redis is never used as the idempotency authority.

## Webhook inbox

The Stripe receiver preserves the raw request body and uses the official SDK's `constructEvent` verification with `STRIPE_WEBHOOK_SECRET` before insertion. It normalizes supported Stripe objects, stores the normalized payload, headers, receipt time, and external event ID before returning `202`. Duplicates conflict on `(provider, provider event ID)` and return the original inbox ID.

Workers claim pending events with `FOR UPDATE SKIP LOCKED`, set a processing lease, and dispatch by event type. Capture completion checks the successful-attempt guard and unique ledger business reference. Unsupported event types are retained as `IGNORED`. Missing payment/attempt/correlation prerequisites retry with bounded backoff; domain errors such as invalid transitions go to `DEAD`. This is not a guarantee for every out-of-order event or stale-worker interleaving; see [failure recovery](failure-recovery.md).

At-least-once delivery is assumed. Exactly-once delivery is not.
