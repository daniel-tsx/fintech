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

## Dormant capture allocation foundation

The capture webhook now writes one original accounting lot with each newly confirmed CAPTURE journal, attempt/payment transition and audit in the caller's transaction. It copies actual journal gross/fee/net and PostgreSQL `posted_at`, checks their agreement with the financial effect, and freezes eligibility. It refuses an incomplete attempt with a pre-existing journal instead of guessing historical terms. Already successful attempts do not create another journal or infer a historical lot. [B2.1](audits/h1-fix-02-b2-1-capture-integration.md) records this integration; lot state is not yet a current refund/settlement balance projection and no scope is ACTIVE.

The [B1 helper](../apps/api/src/ledger/capture-allocation.ts) implements the approved future capture-owned policy with BigInt minor units and exact epoch microsecond chronology, then capture-attempt ID ties. It subtracts confirmed refunds, reserved refunds, active/planned dispute principal and lost dispute principal from gross capacity. Replay returns frozen attribution rather than reassigning it to later captures.

For capture gross G and fee F, cumulative confirmed refund R returns `floor(F × R / G)`; each confirmation uses the difference from previously confirmed fee. Capture 1000/fee101 refunded 333,333,334 returns 33,34,34. Original capture fees, including fixed fees, are used without recalculating today's merchant terms. Intermediate multiplication is exact. Existing Number API/service money representation remains unchanged.

The helper is now used by [B2.2's dormant refund service](audits/h1-fix-02-b2-2-refund-integration.md), which remains disconnected from runtime. Exact arithmetic ends at an explicit safe-integer check before the existing Number ledger boundary. Confirmed refunds debit the affected lot's pending entitlement or available, plus fee refunds, and credit its unsettled clearing or finalized cash. Tests assert individual legs and balances, including mixed lots and signed available debt. Today's runtime refund fee formula remains payment-wide; settlement/refund/dispute behavior is not fixed by installing these tables or the dormant service. [The approved contract](audits/h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09) and [B1 evidence](audits/h1-fix-02-b1-allocation-foundation.md) distinguish the policy from current runtime behavior.

[B2.3's dormant dispute path](audits/h1-fix-02-b2-3-dispute-integration.md) reuses disjoint FIFO principal, separating gross exposure from funded clearing liability. Opening moves own pending/available into DISPUTE_CLEARING without an asset loss. Win restores current pending/available; loss credits capture-owned PSP/cash, debits remaining funded hold and normalized own claim, then records available debt for a shortfall while retaining original fees. A shared helper appends immutable reductions to other holds before a disjoint refund/loss, with cause/allocation/inbox/journal links. Original funding and exposure are initial evidence; current hold adds effect deltas. Mixed and full-gross account oracles are tested only through the dormant service and valid finalized fixtures, with legacy writers unchanged.
