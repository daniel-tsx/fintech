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

Corrections use a reversal journal whose `reversal_of_id` references the original transaction. Database triggers make posted journals and entries immutable.
