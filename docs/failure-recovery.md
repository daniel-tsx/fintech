# Failure recovery and simulation

Status: current. Owner: current failure exercises and recovery limits. [Outbox delivery](outbox-rabbitmq.md) owns broker mechanics; [webhooks/idempotency](webhooks-and-idempotency.md) owns inbox processing.

The current checkout has no scenario-selectable Mock PSP or injection endpoints. Failure simulations use injected Stripe clients, broker channels and database doubles. The [original scenario catalog](archive/failure-scenarios.md) is historical.

| Boundary/failure | Current behavior | Executed-test entry point |
| --- | --- | --- |
| Broker unavailable | Relay leaves the command retryable in PostgreSQL | [Relay unit tests](../apps/api/test/unit/outbox-relay.service.spec.ts) |
| Confirm received, local publication mark lost | Same outbox ID can be published again | Relay unit tests |
| Remote capture response lost | Adapter classifies unknown outcome; consumer retries original command/key | [Stripe adapter tests](../apps/api/test/unit/stripe-payment.provider.spec.ts), [consumer tests](../apps/api/test/unit/payment-command.consumer.spec.ts) |
| Duplicate consumer execution | Original provider key is reused; mirror upsert uses provider/key uniqueness | [Handler tests](../apps/api/test/unit/payment-command-handler.spec.ts) |
| Retry/DLQ publication fails | Original message is not ACKed; delayed NACK requeues it | [Broker tests](../apps/api/test/unit/rabbitmq.service.spec.ts) |
| Permanent/malformed command, retries exhausted | Confirm-publish to dead-letter queue, then ACK original | Consumer and broker tests |
| Tampered webhook body | Signature rejected before insertion | [Signature test](../apps/api/test/unit/webhook-signature.spec.ts) |
| Simultaneous duplicate webhook | Database event uniqueness chooses one receipt | [PostgreSQL suite](../apps/api/test/integration/financial-concurrency.spec.ts) |
| Provider/internal drift | Record issue and review note; no financial repair | [Reconciliation test](../apps/api/test/unit/reconciliation.service.spec.ts) |

Run the exercises without provider or broker infrastructure:

```bash
pnpm --filter @fintech-lab/api test:unit
```

For the PostgreSQL exercises, follow [verification](verification.md#database-integration-tests). The suite also checks payout/refund races, deferred ledger rejection and signed webhook-driven capture.

## Ordering and recovery limits

The inbox retains delayed events and retries missing payment/attempt/correlation prerequisites with bounded backoff. Domain validation failures go to `DEAD` rather than universally waiting for earlier events. Some out-of-order transitions remain unaudited; there is no claim that every ordering converges. Stale-worker lease bookkeeping also needs targeted concurrency tests.

An unknown provider outcome is not a failed payment. The consumer reuses the original key, while a signed webhook can independently finish local capture. Reconciliation can query only known provider references and records disagreement; it does not complete missing journals. If the reference and webhook are both unavailable and retries exhaust, recovery requires external reference discovery and operator review. No replay UI or automated financial repair is implemented.

At-least-once delivery is expected. The tests exercise selected duplicate/retry paths with mocks and PostgreSQL, not live broker crashes, Stripe networking or exactly-once delivery.
