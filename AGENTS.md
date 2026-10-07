# Agent guide — Fintech Lab

This is a portfolio/reference payment platform. Financial correctness takes priority over convenience. Read [docs/AGENT_START_HERE.md](docs/AGENT_START_HERE.md) and the task's documents before editing behavior.

## Start here

1. Confirm the checkout and inspect `git status`. Preserve existing work.
2. Read `README.md`, `CLAUDE.md`, `docs/README.md` and `package.json`.
3. Use the reading matrix in `docs/AGENT_START_HERE.md`. Verify documents against code.
4. State the intended change and verification. Keep the diff surgical.

## Repository context

- Repository slug: `fintech`. Workspace/application name: `fintech-lab`; package filters use `@fintech-lab/api` and `@fintech-lab/web`.
- NestJS modular monolith in `apps/api`; Next.js inspection dashboard in `apps/web`.
- Current provider is `StripePaymentProvider`. The deterministic Mock PSP exists in Git history, not the current runtime.
- Provider commands: PostgreSQL outbox → relay → RabbitMQ → consumer → `PaymentProvider`.
- BullMQ schedules inbox, internal settlement/payout and reconciliation work. PostgreSQL owns durable internal effects.
- [Verification](docs/verification.md) owns setup, environment placement, commands and evidence. Node ≥22; pnpm is pinned in `packageManager`.

## Financial invariants

- Workflow state, provider state and ledger state are separate. Provider success does not itself finalize a local capture or post a journal.
- Preserve API idempotency scope, payload comparison and replayed status/body. Local intent, outbox, audit and replay response must commit atomically.
- Preserve provider keys across retries/redelivery. Never generate a new key to work around an unknown outcome.
- At-least-once delivery is expected. Queue IDs, Redis locks and broker ACKs are not financial uniqueness guarantees.
- Ledger postings remain balanced, currency-isolated, immutable and unique by business reference. Corrections use compensating journals.
- Captured ≠ settled; settled ≠ paid out. Settlement/payout here are internal lab accounting, not external bank transfers.
- Do not change ledger semantics, fee/refund rounding, lock order or balance reservation casually. Explain the affected invariant and verify it explicitly.
- `apps/api/drizzle/0000_cheerful_sunset_bain.sql` contains hand-written financial constraints/triggers. Do not replace it with generated SQL, use schema push, or destructively regenerate migration history.
- Schema changes require a reviewed forward migration that preserves deferred balance checks, immutability, evidence protections and uniqueness.
- Concurrency-sensitive changes need relevant PostgreSQL verification; unit mocks cannot prove locks or commit-time constraints. If unavailable, report the missing evidence.

## Scope and safety

- Never print or commit private environment values. Checked-in demo identities and placeholder keys are local fixtures.
- Use a disposable local database for integration tests; they append rows and intentionally do not delete immutable history.
- No production data/migrations, real payments, live webhooks, deployment, cloud provisioning or remote push without explicit session authorization.
- Builds/tests use mocked Stripe and broker boundaries. Do not start provider consumers or call reconciliation with real credentials as a verification shortcut.
- Preserve the modular monolith and provider port. Avoid speculative financial/product features.
- Documentation claims must point to implementation or executed checks. Separate implemented, inspected, tested and externally verified.
- No fabricated users, metrics, testimonials, compliance claims or readiness guarantees. License choice belongs to the owner.

## Finish

Run relevant scripts from [verification](docs/verification.md). Update the owning document when behavior changes; keep the index and links current. Report changed files, executed checks, failures, unverified boundaries, assumptions and next steps. Do not commit or push unless the task calls for it.
