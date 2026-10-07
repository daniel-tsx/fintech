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

Application `if` checks explain the domain error, but locks and constraints make the invariant true. Queue job IDs and Redis locks are operational optimizations only.

The [PostgreSQL suite](../apps/api/test/integration/financial-concurrency.spec.ts) executes the two-payout race, two-refund race, concurrent inbox receipt, capture completion and deferred ledger rejection. Other rows describe inspected protections, not an exhaustive race proof. In particular, stale inbox leases, settlement races and payout versus refund/dispute balance consumption need dedicated verification; the payout advisory lock alone does not serialize writers that do not take it.
