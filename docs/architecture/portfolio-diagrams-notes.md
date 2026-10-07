# Portfolio architecture diagrams

Status: current supporting visuals for merged `main`. Reviewed against code on 2026-10-07.

[Architecture](../architecture.md) owns the current architecture. These assets illustrate that document; they do not define a second architecture or replace the agent task routing and document lifecycle.

## Which diagram to use

| Diagram | Editable source | PNG export | Best use |
| --- | --- | --- | --- |
| System overview | [system-overview.svg](system-overview.svg) | [system-overview.png](system-overview.png), 2400 × 1500 | **Upwork thumbnail / first portfolio image.** Shows the client, API, durable store, command delivery, external provider and webhook return path. |
| Capture durable boundaries | [capture-flow-durable-boundaries.svg](capture-flow-durable-boundaries.svg) | [capture-flow-durable-boundaries.png](capture-flow-durable-boundaries.png), 2400 × 1925 | **Technical discussion / second portfolio image.** Explains atomic intent acceptance, provider retries and webhook-driven financial completion. |

The overview is a logical view, not an exact deployment topology: it groups PostgreSQL tables inside one durable store and the PaymentProvider port/Stripe adapter inside the consumer. The capture diagram is a logical success path for manual capture of an already-authorized payment. Its three phases distinguish API acceptance, asynchronous provider execution and internal financial completion. Settlement, available balance and payout are internal accounting simulations after capture, not Stripe settlement or external transfers.

## Boundary labels and code evidence

| Boundary | Current implementation |
| --- | --- |
| T1 — API capture transaction | [Payments + idempotency](../../apps/api/src/payments/payments.service.ts): one transaction for row locking, attempt, pending state, outbox, audit and replayable response. Scope is `(merchant, operation, key)`; capture operation includes payment ID. |
| A1 — Outbox claim | [Relay](../../apps/api/src/outbox/outbox-relay.service.ts): `SKIP LOCKED`, atomic claim and two-minute lease; completion/retry writes compare `locked_at`. |
| Broker boundary | [RabbitMQ](../../apps/api/src/rabbitmq/rabbitmq.service.ts): persistent messages, publisher confirms, manual ACK, delayed retry and dead letters. `messageId` is the outbox ID. |
| T2 — Provider execution | [Stripe adapter](../../apps/api/src/payment-provider/stripe-payment.provider.ts): HTTPS outside local transactions; persisted `capture:<attemptId>` is reused on redelivery. |
| A2 — Consumer bookkeeping | [Command handler](../../apps/api/src/payment-commands/payment-command-handler.service.ts): transactionally upsert references, conditionally mark attempt `PROCESSING`, then ACK. No ledger posting. |
| A3 — Webhook receipt | [Receiver](../../apps/api/src/webhooks/webhook-receiver.service.ts): raw-body signature verification, normalization and inbox persistence before `202`; unique provider/event ID. |
| A4 — Webhook claim | [Processor](../../apps/api/src/webhooks/webhook-processor.service.ts): `SKIP LOCKED`, lease, bounded backoff and `DEAD` state for failed processing. |
| T3 — Business transaction | [Webhook business logic](../../apps/api/src/webhooks/webhook-business.service.ts): lock inbox/attempt/payment; validate evidence; atomically apply state, journal, audit and processed inbox. Successful-attempt guard and ledger business uniqueness protect duplicate success. |

Also inspected: [API idempotency](../../apps/api/src/common/idempotency.service.ts), [schema constraints](../../apps/api/src/database/schema.ts), [ledger](../../apps/api/src/ledger/ledger.service.ts), [scheduling](../../apps/api/src/jobs/job-scheduler.service.ts) and [reconciliation](../../apps/api/src/reconciliation/reconciliation.service.ts).

## Assumptions and presentation limits

- **Current provider path:** Stripe implements PaymentProvider; relay and consumer carry provider commands through RabbitMQ. A2 is consumer bookkeeping. T2 is an external boundary, not a claimed Stripe-internal transaction.
- **Ordering:** `202` accepts intent; `PUBLISHED` means broker acceptance. Consumer delivery can race the publication mark; webhooks can precede A2/ACK. No distributed transaction or exactly-once delivery is implied.
- **Background work:** Redis/BullMQ schedules webhook, internal settlement/payout and reconciliation jobs. PostgreSQL owns financial effects. Reconciliation flags drift in referenced Stripe objects; it does not finalize captures or rewrite history.
- **UI/process grouping:** Client/operator includes API callers and the Next.js inspection UI. It does not imply a full admin console or checkout. Webhook ingress belongs to the HTTP API.
- **Review limit:** This shows successful-capture protections. Inbox bookkeeping lacks relay-style lease-token fencing; stale-worker and failure/out-of-order guards need review before deployment. Business logic was not changed.
- **Portfolio claims:** Production-oriented patterns in a learning implementation; not deployed. Broker provisioning, credentials, customer confirmation, provider settlement ingestion and real payouts remain outside scope. Multi-capture depends on provider/account support.

## Editing and re-exporting

SVGs contain editable vector text, nodes and connectors, with labeled XML groups and no remote assets. PNGs use a light background and dark text.

Re-export with the existing `sharp` package (the optional argument points to an already-installed `node_modules` directory):

```text
node docs/architecture/export-diagrams.cjs [path/to/node_modules]
```

The export script preserves aspect ratio and writes both PNGs at 2400 pixels wide. It does not alter application dependencies or make network calls.

## Validation

- Reviewed diagrams against merged `main`: API, relay, broker/consumer, Stripe adapter, inbox, ledger constraints, scheduler and reconciliation code.
- SVG XML parsing and both PNG exports succeeded; the exported images were visually inspected.
- Local documentation links, export-script syntax and documentation whitespace checks passed.
- Live Stripe/RabbitMQ execution and deployment topology are intentionally unverified. See [Verification](../verification.md) for repository-wide coverage and limits.
