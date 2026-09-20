# Database design

Status: current. The executable schema is in `apps/api/src/database/schema.ts`; the checked-in SQL migration is authoritative for constraints and triggers.

## Aggregate tables

- `merchants`, `users`, `api_keys`, `customers`
- `payments`, `payment_attempts`, `provider_transactions`
- `refunds`, `disputes`, `settlements`, `settlement_items`, `payouts`
- `ledger_accounts`, `ledger_transactions`, `ledger_entries`
- `webhook_events`, `idempotency_keys`, `outbox_events`
- `reconciliation_runs`, `reconciliation_issues`, `audit_logs`
- `mock_psp_profiles`

Every externally visible record uses UUIDs. Money columns are signed `bigint` minor units with a three-letter currency check. Cross-currency journals are forbidden. Foreign keys always include the owning merchant where practical, and service queries always scope by merchant.

## Database-enforced invariants

- One idempotency row per `(merchant_id, operation, key)` and request hash comparison on replay.
- One webhook inbox row per `(provider, provider_event_id)`.
- One provider operation per provider idempotency key.
- Captured/refunded amounts cannot be negative and cannot exceed the payment amount/captured amount.
- Ledger entries are positive, one-sided debit or credit rows.
- Deferred constraint trigger rejects posted ledger transactions whose debits and credits differ, have fewer than two entries, or mix currencies.
- Triggers reject updates/deletes of posted ledger transactions, ledger entries, processed webhook payloads, and audit logs.
- Settlement and payout item references are unique.

Balance snapshots are deliberately not the source of truth. Current balances are calculated from ledger accounts and entries. A production system may maintain an asynchronously verified projection for scale.
