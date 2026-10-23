# Independent code review

## Review package

- Task brief and approved acceptance criteria; BASE and current target revision; complete diff with context (including staged, unstaged and listed untracked files); related callers, schema/SQL, tests and exact verification logs.
- Reviewer works in a fresh context, read-only against implementation files. When repro tests are needed, use a separate disposable worktree/database and keep them out of the author's working tree until reviewed.
- Reviewer should verify **spec compliance first**, then correctness/safety/test quality. Use `ponytail-review` as the quality lens and relevant domain guidance as needed; don't launch a repo-wide `ponytail-audit` by default.

## Required checks

Trace real inputs, business identity, SQL ownership and externally visible effects. Challenge missing/contradictory evidence, replay, cancellation/rollback, lock ordering, stale state, privilege checks and migrations as relevant. Reproduce material findings. Report command/execution provenance and whether cases are newly executed or read from author logs.

## Findings and verdict

Each finding: severity (P0/P1/P2/observation), file/location, concrete scenario and actual-versus-required behavior, impacted invariant and reproducible assertion or reason not executable. Duplicate/inapplicable findings should be ruled with evidence, not counted as blockers indefinitely.

`REVIEW_APPROVED` means no P0/P1 or acceptance-blocking P2 **for the reviewed revision only**. `REVIEW_REQUEST_CHANGES` includes an ordered consolidated fix list. A passing test count alone cannot establish approval; later code edits invalidate the verdict. Security/policy questions must not be silently fixed by changing requirements.

## Interrupted reviewers and checkpoint evidence

A reviewer invoked before a usage-limit interruption is **not approved** unless its independent verdict and evidence were successfully checkpointed. On resume, rerun the unfinished review in a fresh context. Record each reviewer response under a distinct ignored filename, include its actual reviewer/session identity, and verify reviewed source fingerprint before accepting the verdict. The ledger only stores claimed identity; real provenance must be checked in host execution history. See [resume.md](resume.md).
