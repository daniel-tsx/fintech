# Final gate and human acceptance

## Deterministic gates

- Freeze scope and revision (BASE + commit SHA when committed + staged/unstaged diff fingerprint + untracked file inventory). If files changed after review, invalidate and rerun applicable checks/review.
- Confirm independently approved plan and implementation (unless explicit DESIGN_ONLY), exact acceptance assertions, required passing checks, relevant DB/upgrade/concurrency tests, source/permission invariants, and complete accounted skip/failure list.
- A check marked `NOT_RUN`, `BLOCKED_ENVIRONMENT` or `AUTHOR_REPORTED` does not satisfy a mandatory gate. Hosted CI is a separate gate from local Docker/Postgres; do not claim success without its result for the exact SHA. Workflows do not push, so at `FINAL_GATE` hosted CI is reported as `NOT_RUN`: it is not a mandatory gate for `READY_FOR_HUMAN_APPROVAL`, but it must pass on the PR before merge.
- Inspect dirty worktree and ensure generated/temp/secret files are not staged. Keep review artifacts in existing `.tmp/agent-workflows/<task>/` and preserve significant tests in version control. Only durable design/contracts/operations belong in canonical docs.

## Verdicts and permissions

- `READY_FOR_HUMAN_APPROVAL`: all in-scope mandatory gates completed on the reviewed revision; not equivalent to commit/merge/deploy permission.
- `BLOCKED`: unresolved P0/P1, acceptance-blocking P2, policy decision, review independence unavailable, exceeded correction limit, or required tests missing.
- `DESIGN_READY_FOR_HUMAN_APPROVAL`: design-only plan independently approved; implementation NOT authorized by this verdict.

The human receives a short, actionable summary with all open questions. No unattended push, PR creation, merge, database production mutation, financial-scope activation, provider call or deployment. If the user later authorizes one action, that authorization does not silently extend to the others.

## Resume integrity gate

Before presenting final approval, run `node scripts/engineering-workflow-state.mjs resume <task-slug>`, inspect `state.json`, and confirm both its **current source fingerprint** and each recorded ignored artifact digest still match. Record `FINAL_GATE PASSED` only with real evidence, matching independent plan/code review, checks performed on the current revision and an accepted zero-blocker disposition. A paused stage, stale/missing artifact, changed source, or exhausted correction budget cannot become `READY_FOR_HUMAN_APPROVAL` through replay of a summary. See [resume.md](resume.md).
