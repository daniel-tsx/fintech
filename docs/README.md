# Documentation index

Status: current.

- [Transactional outbox to RabbitMQ](outbox-rabbitmq.md) - relay, topology, ACK/retry/DLQ, and diff-based learning map.
- [Architecture](architecture.md) — boundaries, runtime topology, and design decisions.
- [Real PSP: Stripe](real-psp-stripe.md) — branch-specific external provider boundary and learning map.
- [Database design](database-design.md) — tables, constraints, locks, and immutability.
- [Payment lifecycle](payment-lifecycle.md) — authorization and capture state machines.
- [Ledger](ledger.md) — chart of accounts and double-entry postings.
- [Webhooks and idempotency](webhooks-and-idempotency.md) — inbox, retries, and API keys.
- [Settlement and payout](settlement-and-payout.md) — pending, available, and concurrency.
- [Refunds and disputes](refunds-and-disputes.md) — compensating financial events.
- [Reconciliation](reconciliation.md) — mismatch detection without history rewriting.
- [Concurrency](concurrency.md) — races and database protections.
- [Failure scenarios](failure-scenarios.md) — historical Mock PSP behavior from the original branch.
- [Security](security.md) — tenancy, credentials, audit, and the PCI boundary.
- [Observability](observability.md) — correlation, logs, and metrics.
- [UI signature](ui-signature.md) — the transaction trace lab visual language.
