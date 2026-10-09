# Concurrency

Status: current.

| Race | Protection |
| --- | --- |
| Two payment creates with one key | unique idempotency constraint; same transaction as create |
| Two captures | `SELECT … FOR UPDATE` payment lock plus remaining-authorized check |
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

New allocation writes serialize through the refund/dispute intent parent and a real `allocation_revision` UPDATE on the shared capture lot. Hold effects also lock their OPEN dispute allocation before the lot. Deferred whole-intent, principal and funded-entitlement checks run against the completed transaction. Competing allocations cannot safely rely on only the unique refund/lot pair. Tests observe lock blocking and rejection under both READ COMMITTED and REPEATABLE READ; stale snapshots must abort rather than over-allocate.

Foundation candidate writes version/lock their batch parent before aggregate sum validation. Foundation finalization and exception creation version the shared merchant/currency scope. An earlier uncommitted exception blocks a competing finalizer, which then rejects after the exception commits. These are new-table tests, not live settlement/payout concurrency proof. Same-value parent writes create tuple versions without changing amount/timestamps; the current refund/dispute tables have no automatic timestamp/version triggers. Future triggers must preserve this protocol deliberately.

B2 must acquire the common admission lock and scope first, then all required payment/intent/batch parents, then allocation rows/lots in a deterministic order, then new journals. Prelock every affected parent before inserting allocation rows: row UPDATE already locks its target, so relying on AFTER/BEFORE triggers alone can invert locks across multi-row operations. In particular, do not mix lot→batch callers with batch→lot callers, or intent→scope callers with scope→intent callers. Any deadlock/serialization failure aborts the whole operation and requires a complete transaction retry with stable business/provider keys. This caller protocol and all integrated writers require B3 verification; F04 remains open.
