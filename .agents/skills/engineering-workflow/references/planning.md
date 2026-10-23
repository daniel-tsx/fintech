# Planning and plan review

## Planner

1. Establish the current source-of-truth: repo instructions, git state, approved decisions, actual call paths, database constraints and existing tests. Do not treat an older proposal as present behavior.
2. Write a compact task brief: goal, risk tier, explicit non-goals, affected invariants, files/code entry points, dependencies, acceptance checks, known unknowns and expected human gates.
3. Split tightly coupled work into **sequential** checkpoints. Avoid speculative interfaces, a full-repo audit and an oversized all-at-once implementation. Reuse the current skill routing: `grilling` only for consequential unsettled choices, `ponytail` for bounded implementation.
4. For HIGH_RISK financial work, name the transaction owner, source of money truth, ownership/currency checks, failure/retry model, concurrency participants, DB test matrix and prohibited activation. Mark unimplemented prerequisites as blockers; do not invent synthetic production authority.
5. List tests that actually prove acceptance, and the checks possible in the environment; mocks do not prove Postgres concurrency or COMMIT semantics.

## Fresh independent plan reviewer

Pass the brief and source-entry points; do not hand over author conclusions as facts. Verify plan against real code/SQL; challenge scope, invariants, missing rollback/replay edges, lock order, migration upgrades, auth, source trust and test feasibility. Return `PLAN_APPROVED` or `PLAN_REQUEST_CHANGES` with P0/P1/P2 findings, exact evidence and smallest correction. The planner may revise the plan in at most two rounds; material policy or human-choice conflicts become `BLOCKED_HUMAN_DECISION`.

In `DESIGN_ONLY`, approved design is the terminal output pending human acceptance. Do **not** begin the first implementation checkpoint. Design-only review may not be reinterpreted as code or deployment authorization.

## Checkpoint handoff

After the plan is complete, save it under the task's ignored workspace and record `PLAN READY` with `--artifact` in the v1.1 state ledger. If a reviewer requests changes, preserve the original reviewer report and write the corrected plan as a new version of the plan file; the current digest is updated only after correction actually completes. Do not reset the task slug or correction counter when a session is interrupted; use [resume.md](resume.md).
