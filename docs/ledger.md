# Double-entry ledger

Status: current.

Operational records answer “what is the workflow doing?” The ledger answers “what financial obligations and assets changed?” Payment status may be corrected after reconciliation; a posted journal is never rewritten.

## Account model

| Account | Type | Normal balance | Scope |
| --- | --- | --- | --- |
| `PSP_CLEARING` | asset | debit | platform/currency |
| `PLATFORM_CASH` | asset | debit | platform/currency |
| `MERCHANT_PENDING` | liability | credit | merchant/currency |
| `MERCHANT_AVAILABLE` | liability | credit | merchant/currency |
| `PLATFORM_FEE_REVENUE` | revenue | credit | platform/currency |
| `PLATFORM_FEE_REFUNDS` | expense | debit | platform/currency |
| `PAYOUT_CLEARING` | liability | credit | merchant/currency |
| `DISPUTE_CLEARING` | liability | credit | merchant/currency |

For a USD 100.00 capture with a USD 3.00 fee:

| Entry | Debit | Credit |
| --- | ---: | ---: |
| PSP clearing | 10000 | — |
| Merchant pending | — | 9700 |
| Platform fee revenue | — | 300 |

Settlement posts two balanced legs in one journal: debit cash/credit PSP clearing for gross, and debit merchant pending/credit merchant available for merchant net. A payout reservation debits merchant available and credits payout clearing; payout completion debits payout clearing and credits cash.

Refund fee allocation uses cumulative proportional allocation. The fee attributed to refund `n` is `floor(totalFee * cumulativeRefund / captured) - alreadyRefundedFee`, so the last refund absorbs rounding and cumulative allocations remain exact.

Corrections require new compensating journals; database triggers make posted journals and entries immutable. The schema includes `reversal_of_id` and a foreign key, but no general reversal command/API is implemented. Refund and dispute workflows post their own compensating business journals.

## Posting and sealing

Construct a journal as `DRAFT`, insert its entries, then update it to `POSTED` in the same database transaction. The INSERT trigger from [migration 0002](../apps/api/drizzle/0002_seal_posted_ledger.sql) requires a DRAFT parent and performs a same-value parent UPDATE. This acquires the posting write lock and changes the parent row version, so competing inserts/posting serialize and a stale repeatable-read posting transaction aborts rather than validating an old entry snapshot. Deferred balance/currency checks still run before a successful commit.

After posting, the header rejects UPDATE/DELETE and entries reject INSERT/UPDATE/DELETE. Ledger-table TRUNCATE is also rejected. A correction uses a new balanced journal; its `reversal_of_id` may reference the sealed original without changing it. See the [F02 fix record](audits/h1-fix-01-posted-ledger-immutability.md) for before/after PostgreSQL evidence and migration limitations.

[Migration 0003](../apps/api/drizzle/0003_pin_ledger_function_context.sql) qualifies persistent ledger tables and the ledger status type, and fixes the ledger trigger functions' search path to `pg_catalog, pg_temp`. Balance validation therefore resolves the same financial objects regardless of the session search path. The functions retain invoker privileges, existing grants and deferred trigger bindings.
