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
