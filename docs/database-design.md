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
