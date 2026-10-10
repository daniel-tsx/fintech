# Agent start here

Status: current. Owner: task routing; rules live in [AGENTS.md](../AGENTS.md).

Read the [project overview](../README.md), [documentation index](README.md), package scripts and Git status first. This checkout follows the Mock PSP → Stripe → RabbitMQ learning sequence; older branch notes are not current runtime instructions.

## Read by task

| Task | Required documents | Code to inspect |
| --- | --- | --- |
| Architecture, README, claims | [Architecture](architecture.md), [verification](verification.md), [Stripe boundary](real-psp-stripe.md), [outbox delivery](outbox-rabbitmq.md) | Root modules, runtime entry points, tests and Git history |
| Authorization, capture, cancellation | [Payment lifecycle](payment-lifecycle.md), Stripe boundary, [webhooks/idempotency](webhooks-and-idempotency.md), [concurrency](concurrency.md) | `payments/`, `payment-commands/`, `payment-provider/`, `webhooks/` |
| Ledger, schema or migration | [Ledger](ledger.md), [database design](database-design.md), concurrency | `ledger/`, `database/schema.ts`, checked-in SQL and integration suite |
| Refunds, disputes | [Refunds/disputes](refunds-and-disputes.md), ledger, concurrency, webhooks/idempotency | `refunds/`, `disputes/`, webhook business service |
| Settlement, payout or balances | [Settlement/payout](settlement-and-payout.md), ledger, concurrency | `settlements/`, `payouts/`, internal outbox processor |
| Retries, inbox, outbox or workers | Webhooks/idempotency, outbox delivery, [failure recovery](failure-recovery.md) | `outbox/`, `rabbitmq/`, `payment-commands/`, `webhooks/`, `jobs/` |
| Reconciliation | [Reconciliation](reconciliation.md), Stripe boundary, failure recovery | `reconciliation/`, `PaymentProvider.fetchStatus` and tests |
| Auth, tenancy, logging | [Security](security.md), [observability](observability.md) | Guards, controllers, serializers, audit and middleware |
| Dashboard | [UI signature](ui-signature.md), verification, relevant payment-flow document | `apps/web/app/`, `components/`, `lib/api.ts` and API response shape |
| Setup, CI, scripts | Verification, [AI workflow](AI_WORKFLOW.md) | Package scripts, lockfile, Compose, env loading and CI |

API code paths above are relative to `apps/api/src/` unless stated otherwise. Test claims against `apps/api/test/`. The immutable triggers and functional indexes in SQL exceed what the Drizzle schema describes.

For ongoing F01 work, also read the [approved capture accounting contract](audits/h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09), [B1 checkpoint](audits/h1-fix-02-b1-allocation-foundation.md) and [B2.1 capture integration](audits/h1-fix-02-b2-1-capture-integration.md). Confirmed new captures now append original journal-backed lots atomically. Refund/dispute/settlement writers remain legacy and every scope remains dormant. Do not consume partially populated allocation state or treat lot creation as cutover.

[B2.2 refund integration](audits/h1-fix-02-b2-2-refund-integration.md) adds a separate gated service tested with synthetic dormant admission. It is absent from runtime modules/controllers/webhook dispatch; no production switch enables it. Read its cutover and lock dependencies before wiring it. Migration 0005 adds an exception inbox disposition, not ACTIVE scopes or live refund routing.

[B2.3 dispute integration](audits/h1-fix-02-b2-3-dispute-integration.md) adds the similarly disconnected dispute service and shared hold reductions in both dormant paths. Read its provider evidence, payment-state and lock dependencies before wiring either service. All scopes remain dormant; legacy settlement/refund/dispute/payout semantics remain unchanged.

## Evidence to preserve

For financial changes, name the invariant and its transaction boundary before coding. Check duplicate execution, failure after remote success, rollback, tenant ownership and conflicting concurrent operations where relevant. Keep tests specific to the risk; a mocked happy path is not evidence for a database race.

The [AI workflow](AI_WORKFLOW.md) describes the work loop. The [verification record](verification.md#verification-record) distinguishes local execution from configured CI and untested external boundaries.
