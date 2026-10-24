---
name: codex-review
description: Run an independent cross-model review with Codex on the current task branch or design, then triage its findings. Use when AGENTS.md requires an independent reviewer (T2, CI or guard changes) or when the user asks for a Codex review; not for self-review of T0/T1 work.
---

# Codex review

Codex reviews; you (the implementer) prepare the package, run it, and triage. Codex never edits files.

## 1. Prepare
- Work is committed on your task branch inside your worktree: review a commit, not a dirty tree.
- `git fetch origin`; rebase onto `origin/main` if it moved. Record the reviewed SHA: `git rev-parse HEAD`.
- Write a short brief in `.tmp/<task-slug>/review-brief.md`: goal, non-goals, task size, invariants and boundaries touched, acceptance criteria. Facts only: no claims that the change is correct, minimal or safe.

## 2. Run (read-only, from the worktree root)
Code:
```sh
codex exec -s read-only -c model_reasoning_effort="high" "$(cat .tmp/<task-slug>/review-brief.md)

You are an independent reviewer of the changes on this branch against origin/main (git diff origin/main...HEAD). Follow AGENTS.md: its Review rules, task-size table and financial invariants. Read the code and tests yourself; trust no summary. Check correctness, regressions, security, tenant isolation, concurrency, idempotency, migrations and test adequacy as relevant. Report findings only, ordered by severity, each with: P0/P1/P2, file:line, a concrete failing scenario, actual versus required behavior. Say explicitly if you found nothing blocking. Do not modify files."
```
Design (no diff yet): same command, but replace the diff sentence with "review this design for the repository" and append the design text or its `.tmp` path.

Save Codex's final message to `.tmp/<task-slug>/review-<n>.md` (redirect stdout, or `--output-last-message` where supported). Never overwrite an earlier review file.

## 3. If Codex cannot run
Not installed, config or sandbox error, usage limit: report the error once, do not loop. Fall back to a fresh read-only subagent (or a fresh session) given the same brief and SHA, and label the reviewer as fallback. Your own re-read is not an independent review.

## 4. Triage every finding
- **Accept**: reproduce it (a failing test where feasible), then fix.
- **Reject**: cite code or test evidence (file:line) showing why it does not apply.
- **Human decision**: policy, product or financial-semantics questions go to the user; do not resolve them by changing requirements.

Fix accepted findings in one wave, rerun the affected checks, and review the new SHA again. At most two correction rounds; then stop and hand the remaining findings to the user.

## 5. Report (PR Review section)
Reviewer (Codex, model and effort, or fallback), reviewed SHA, a findings table with disposition, and open human decisions.
