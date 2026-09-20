# Concurrency

Status: current.

| Race | Protection |
| --- | --- |
| Two payment creates with one key | unique idempotency constraint; same transaction as create |
| Two captures | `SELECT … FOR UPDATE` payment lock plus remaining-authorized check |
| Two refunds of remaining amount | payment row lock plus sum of accepted refunds |
| Two payouts | merchant/currency advisory transaction lock plus ledger-derived balance |
| Duplicate webhook workers | inbox lease/lock plus unique business references |
| Duplicate outbox/BullMQ execution | outbox claim lease plus provider idempotency key |
| Duplicate settlement generation | unique settlement item per capture/reference |
| Unbalanced journal | deferred PostgreSQL constraint trigger |

Application `if` checks explain the domain error, but locks and constraints make the invariant true. Queue job IDs and Redis locks are operational optimizations only.
