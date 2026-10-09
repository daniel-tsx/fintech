# Database design

Status: current. The executable schema is in `apps/api/src/database/schema.ts`; the checked-in SQL migration is authoritative for constraints and triggers.

## Aggregate tables

- `merchants`, `users`, `api_keys`, `customers`
- `payments`, `payment_attempts`, `provider_transactions`
- `refunds`, `disputes`, `settlements`, `settlement_items`, `payouts`
- `ledger_accounts`, `ledger_transactions`, `ledger_entries`
- `webhook_events`, `idempotency_keys`, `outbox_events`
- `reconciliation_runs`, `reconciliation_issues`, `audit_logs`

`provider_transactions` stores local Stripe command references and last-known state. It is a cache/mirror, not the provider source of truth. Multiple command rows may reference the same PaymentIntent; provider idempotency keys, not provider object IDs, are unique per command.

Records use UUIDs; provider object references use provider-issued strings. Money columns use `bigint` minor units; the payment currency has a three-letter check. The deferred trigger checks journal/entry currency consistency. Foreign keys preserve record references, but are generally not composite tenant-ownership constraints; services must validate merchant ownership explicitly.

## Database-enforced invariants

- One idempotency row per `(merchant_id, operation, key)` and request hash comparison on replay.
- One webhook inbox row per `(provider, provider_event_id)`.
- One provider operation per provider idempotency key.
- Captured/refunded amounts cannot be negative and cannot exceed the payment amount/captured amount.
- Ledger entries are positive, one-sided debit or credit rows.
- Deferred constraint trigger rejects posted ledger transactions whose debits and credits differ, have fewer than two entries, or mix currencies.
- Entry INSERT requires a DRAFT parent and updates that parent without changing its status. This serializes entry construction against posting and invalidates stale repeatable-read posting snapshots. [Migration 0002](../apps/api/drizzle/0002_seal_posted_ledger.sql) also refuses installation over existing invalid posted journals and blocks ledger-table TRUNCATE.
- Triggers reject updates/deletes of posted ledger transactions, ledger entries and audit logs. A separate trigger protects webhook provider/event/type/signature/payload fields on updates.
- Each capture attempt can appear in only one settlement item. Payout journals use unique ledger business references.

Balance snapshots are deliberately not the source of truth. Current balances are calculated from ledger accounts and entries. A production system may maintain an asynchronously verified projection for scale.

Ledger sealing, deferred balance checks, immutable-row triggers, functional account uniqueness and hand-authored foreign keys are SQL guarantees beyond the Drizzle table definitions. Keep the checked-in forward migrations; generating a table schema does not reproduce these triggers. The [F02 fix record](audits/h1-fix-01-posted-ledger-immutability.md) owns the change's migration and verification evidence.

[Migration 0003](../apps/api/drizzle/0003_pin_ledger_function_context.sql) replaces the balance function in place with explicit `public` table/type references and pins all four ledger trigger functions to `pg_catalog, pg_temp` with `SECURITY INVOKER`. Ownership, execution grants and trigger identities are preserved. Its transactional preflight again refuses invalid POSTED history. Drain financial writers before applying: header/entry `SHARE ROW EXCLUSIVE` locks block writes during the scan and function replacement; ordinary reads remain possible.

## Installed B1 foundation, dormant at runtime

[Migration 0004](../apps/api/drizzle/0004_capture_accounting_foundation.sql) adds `capture_accounting_scopes`, `capture_accounting_lots`, `refund_capture_allocations`, `dispute_capture_allocations`, `dispute_hold_effects`, `accounting_exceptions` and `accounting_exception_lots`. These are evidence/allocation records, not balance snapshots. No current financial service consumes them. The scope gate permits only `FOUNDATION_ONLY` or `REVIEW_REQUIRED`; there is no ACTIVE state in B1.

Composite ownership keys connect new lots, intentions, exceptions and journals by payment/merchant/currency. Deferred checks enforce whole-intent allocation, aggregate principal/funding capacity and journal amounts; terminal allocations/effects and original capture values are immutable. Persistent SQL references are qualified and all eight new functions use invoker privileges with `pg_catalog, pg_temp`. This does not repair ownership constraints in unrelated legacy tables.

Nullable settlement/item columns distinguish policy, estimates, revisions, final asset transfer/release, restricted hold, final journal and explicit ZERO_EFFECT evidence. Legacy gross/fee/net fields retain their meanings; legacy writers leave all new fields null. Historical migrations and F02 functions/triggers are preserved.

The live `capture_accounting_legacy_inventory` and `capture_accounting_orphan_inventory` views support inspection, not activation. Installation backfills only canonical, unadjusted, unsettled original captures, with legacy eligibility left null. Adjusted/settled/invalid captures and scoped orphan journals create review exceptions without fabricated allocations. Unscoped CAPTURE evidence makes migration 0004 refuse atomically. Drain writers before applying: the transactional maintenance locks and added unique/FK constraints can block writes and reads. The [B1 record](audits/h1-fix-02-b1-allocation-foundation.md) owns migration tests, recovery precautions and B2 cutover prerequisites.
