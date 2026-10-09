# Concurrency

Status: current.

| Race | Protection |
| --- | --- |
| Two payment creates with one key | unique idempotency constraint; same transaction as create |
| Two captures | Payment write lock (`FOR UPDATE` for intent acceptance; `FOR NO KEY UPDATE` for confirmed success) plus remaining-authorized check |
| Two refunds of remaining amount | payment row lock plus sum of accepted refunds |
| Two payouts | merchant/currency advisory transaction lock plus ledger-derived balance |
| Duplicate webhook workers | inbox lease/lock plus unique business references |
| Duplicate provider-command execution | relay lease plus stable provider key; mirror provider/key uniqueness |
| Duplicate internal payout execution | payout row lock plus unique ledger business references |
| Duplicate settlement generation | unique settlement item per capture/reference |
| Unbalanced journal | deferred PostgreSQL constraint trigger |
| Entry insertion versus journal posting | DRAFT-only INSERT trigger updates/locks the parent; posting takes the same write lock |

Application `if` checks explain the domain error, but locks and constraints make the invariant true. Queue job IDs and Redis locks are operational optimizations only.

The [PostgreSQL suite](../apps/api/test/integration/financial-concurrency.spec.ts) executes the two-payout race, two-refund race, concurrent inbox receipt, capture completion and deferred ledger rejection. Other rows describe inspected protections, not an exhaustive race proof. In particular, stale inbox leases, settlement races and payout versus refund/dispute balance consumption need dedicated verification; the payout advisory lock alone does not serialize writers that do not take it.

The [F02 ledger suite](../apps/api/test/integration/posted-ledger-immutability.spec.ts) executes posted append rejection, posting versus an append after `SET CONSTRAINTS ALL IMMEDIATE`, and a stale repeatable-read posting snapshot. The INSERT trigger performs a real same-value UPDATE rather than only `SELECT FOR UPDATE`: under repeatable read, a previously taken snapshot must conflict with the parent version created by a later entry writer. The normal DRAFT → entries → POSTED flow and separate correction journals remain valid. Statement rejection, serialization failure or deferred commit rejection preserves the invariant; callers must retry an aborted transaction as a whole.

Function-context hardening in migration 0003 preserves this lock protocol and the deferred checks. LedgerService constructs and seals its own newly inserted header; duplicate business references return the existing journal without adding entries. Direct writers touching multiple DRAFT journals must use a consistent parent order. Drain financial writers before the migration's header-then-entry table locks; lock waits or deadlocks require rollback and whole-transaction retry.

## Dormant B1 allocation constraints

[B2.1 capture integration](audits/h1-fix-02-b2-1-capture-integration.md) moves confirmed capture success from attempt→payment to merchant/currency advisory→scope→provider mirror→payment→CAPTURE attempt→new journal→new lot→audit, inside the private inbox transaction. Scope identity is discovered without locking and revalidated under payment/attempt locks. The advisory key is the existing payout key and precedes mirror/child locks. The lot is new and private; its original-evidence trigger requires the journal and successful attempt first. Future operations on existing lots must lock them before new journals.

Capture success/replay takes payment FOR NO KEY UPDATE, then CAPTURE attempt FOR UPDATE. Legacy generation locks successful attempts, then inserts settlement items whose payment FK takes KEY SHARE. Independent review reproduced 40P01 when B2.1 used payment FOR UPDATE: replay waited for generation's attempt while generation waited for replay's payment. B2.1.1 changes only capture's payment mode. It permits the FK key-share lock because capture changes no referenced payment keys, while still conflicting with payment writers. Both controlled acquisition-order regressions now require generation and duplicate captures to commit without retries, with unchanged original evidence and valid item totals/references.

Authorization success still locks AUTHORIZE attempt→payment; capture explicitly selects only CAPTURE attempts. Failure/cancellation callbacks use payment→child. Refund success is refund→payment; dispute close is dispute→journal→payment. Capture does not lock those refund/dispute/authorization children or settlement headers. Provider bookkeeping is mirror→attempt/refund with no later payment/lot/advisory lock, and network execution precedes its transaction. No unrelated handler was reordered for the capture-only correction. Legacy ordering is not a completed common protocol: later writers must be reviewed together before activation, including generation's implicit FK locks.

New PostgreSQL schedules observe actual `pg_blocking_pids`: duplicate capture waits on the scope advisory lock, capture waits on the payout key before mirror mutation, and a payment-first writer can finish its child update while capture waits for the payment. The B2.1.1 schedules also cover settlement versus replay in both acquisition orders and actual refund success waiting on capture's non-key payment lock, preserving captured/refunded totals. Distinct signed inbox events also process concurrently with one journal/lot/audit. These cases do not establish every refund/dispute/settlement race, cross-scope account-creation order or F04 admission safety.

New allocation writes serialize through the refund/dispute intent parent and a real `allocation_revision` UPDATE on the shared capture lot. Hold effects also lock their OPEN dispute allocation before the lot. Deferred whole-intent, principal and funded-entitlement checks run against the completed transaction. Competing allocations cannot safely rely on only the unique refund/lot pair. Tests observe lock blocking and rejection under both READ COMMITTED and REPEATABLE READ; stale snapshots must abort rather than over-allocate.

Foundation candidate writes version/lock their batch parent before aggregate sum validation. Foundation finalization and exception creation version the shared merchant/currency scope. An earlier uncommitted exception blocks a competing finalizer, which then rejects after the exception commits. These are new-table tests, not live settlement/payout concurrency proof. Same-value parent writes create tuple versions without changing amount/timestamps; the current refund/dispute tables have no automatic timestamp/version triggers. Future triggers must preserve this protocol deliberately.

B2 must acquire the common admission lock and scope first, then all required payment/intent/batch parents, then allocation rows/lots in a deterministic order, then new journals. Prelock every affected parent before inserting allocation rows: row UPDATE already locks its target, so relying on AFTER/BEFORE triggers alone can invert locks across multi-row operations. In particular, do not mix lot→batch callers with batch→lot callers, or intent→scope callers with scope→intent callers. Any deadlock/serialization failure aborts the whole operation and requires a complete transaction retry with stable business/provider keys. This caller protocol and all integrated writers require B3 verification; F04 remains open.
