# Documentation index

Status: current. Owner: navigation and source-of-truth routing.

Start with the [project overview](../README.md). Each document below owns its named subject; executable code and checked-in SQL win when prose disagrees. Update the owning document instead of adding parallel notes.

## Engineering workflow

- [Agent start here](AGENT_START_HERE.md) — task reading matrix and code entry points.
- [AI workflow](AI_WORKFLOW.md) — inspect → define → change → verify → record → review.
- [Repository rules](../AGENTS.md) — financial invariants and safety; [Claude entry point](../CLAUDE.md).

## Architecture and correctness

| Document | Owns |
| --- | --- |
| [Architecture](architecture.md) | Runtime units, module boundaries, provider/internal ownership |
| [Database design](database-design.md) | Schema, checked-in SQL constraints and triggers |
| [Ledger](ledger.md) | Accounts, capture postings, rounding and immutable accounting |
| [Concurrency](concurrency.md) | Locks/uniqueness, executed race coverage and gaps |
| [Portfolio architecture diagrams](architecture/portfolio-diagrams-notes.md) | Supporting visuals for Architecture, editable sources, exports and review limits |

## Payment flows

- [Payment lifecycle](payment-lifecycle.md) — authorization/capture states and asynchronous completion.
- [Refunds and disputes](refunds-and-disputes.md) — refundable limits, holds and compensating journals.
- [Settlement and payout](settlement-and-payout.md) — internal pending/available transfers and reservation.

## Reliability and provider boundary

- [Webhooks and idempotency](webhooks-and-idempotency.md) — API replay, signed inbox, deduplication and retries.
- [Transactional outbox / RabbitMQ](outbox-rabbitmq.md) — current relay/consumer topology, confirms, ACK/retry/DLQ and duplicate-publication gap.
- [Stripe boundary](real-psp-stripe.md) — current provider mapping/ownership; parent-branch polling comparison is explicitly historical.
- [Failure recovery](failure-recovery.md) — current mocked exercises and recovery limits.
- [Reconciliation](reconciliation.md) — referenced-object drift detection and recorded resolution.

## Operations and security

- [Setup and verification](verification.md) — supported tools, environment placement, migration/seed, exact checks, CI coverage and executed evidence.
- [Observability](observability.md) — correlation, logs, database snapshot metrics and health limits.
- [Security](security.md) — inspected controls, development identities and unverified authorization/compliance boundaries.

## Presentation

- [UI signature](ui-signature.md) — dashboard visual conventions.
- [Dashboard screenshot](assets/README.md) — seeded fixture provenance and reproduction.

## Historical material

- [Original Mock PSP failure scenarios](archive/failure-scenarios.md) — historical; runtime scenario controls were removed before this checkout.
- Git history: `4f1cf61` introduced the Mock PSP lab; `286c8c3` replaced the provider boundary with Stripe; `5b6ebd1` introduced RabbitMQ relay/consumers.

Historical text explains earlier design decisions; it does not define current setup commands or verification. The former [failure-scenarios path](failure-scenarios.md) remains a redirect for existing links.
