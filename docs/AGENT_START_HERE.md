# Agent start here

Status: current. Owner: task routing; rules live in [AGENTS.md](../AGENTS.md).

Read what your [task size](../AGENTS.md#task-size) requires. This checkout follows the Mock PSP → Stripe → RabbitMQ learning sequence; older branch notes are not current runtime instructions.

## Read by task

| Task | Documents (T2: all; T1: the one owning the behavior) | Code to inspect |
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

F01 accounting work (capture allocation and the B-series checkpoints) is dormant: no scope is ACTIVE, dormant writers are not a runtime cutover, and legacy settlement/refund/dispute/payout semantics are unchanged. Records in `docs/audits/` are historical; open one only when the task names it. Approved policy that still governs it is listed under [Approved decision records](#approved-decision-records).

## Approved decision records

Most of `docs/audits/` is historical and opt-in. These records are approved policy, not history: T2 work on capture, ledger, refunds, disputes, settlement, payout, receipts/inbox or provider evidence must read the parts relevant to the invariant it touches.

- [Approved capture accounting contract](audits/h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09) — allocation, lots and accounting semantics approved for F01 (§16 only).
- [B3.2 human architecture decisions](audits/h1-fix-02-b3-2-human-decisions.md) — H01–H12 rollout, admission, writer, payout and evidence-gate choices, plus D01.

New approved decisions go to `docs/decisions/` and are added to this list.

## Evidence to preserve

For financial changes, name the invariant and its transaction boundary before coding. Check duplicate execution, failure after remote success, rollback, tenant ownership and conflicting concurrent operations where relevant. Keep tests specific to the risk; a mocked happy path is not evidence for a database race.

The [AI workflow](AI_WORKFLOW.md) describes the work loop. The [verification record](verification.md#verification-record) distinguishes local execution from configured CI and untested external boundaries.
