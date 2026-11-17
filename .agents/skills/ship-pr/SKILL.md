---
name: ship-pr
description: Prepare a finished task branch for a pull request (rebase, guards, pre-PR checks, review prerequisites, final verification, PR description built from the task reports) and push or open the PR only after explicit user authorization. Use when a T1/T2 task is done; T0 changes may use it too.
---

# Ship a PR

Never push, open or merge a PR without the user's explicit go-ahead in this session. Merging is always the human's.

## Task reports
T1/T2 tasks keep four short reports in `.tmp/<task-slug>/`. They become the PR description, which is the durable record; they are never committed. T0 needs none: the PR states what and why, and the checks.
- `epic.md`, written when the task starts: problem, goal, scope and non-goals, task size, invariants or boundaries touched, and numbered acceptance criteria (AC1, AC2…). It is also the `codex-review` brief.
- `todo.md`, kept current while working (three to five lines is fine): the steps and ACs as a checklist, open blocking items, and follow-ups left for later PRs.
- `output.md`, at the end: what was delivered, by area and with its files; behavior, API, schema or config changes; docs updated; what was deliberately not done.
- `evidence.md`, at final verification: for each AC, the proof on the final SHA (command and result, test names, screenshots) or NOT VERIFIED with the reason; every check as PASS, FAIL or NOT RUN; reviews with findings and their disposition; unverified boundaries.

Facts only: every claim points to a command, test, file or review. Keep each report short; evidence may be the longest, at most 150 lines.

After an `engineering-workflow` run, build the reports from its artifacts instead of keeping a second set: its `plan.md` gives the epic and todo; its reviewer reports, `verification.json` and `final-checks.json` give the evidence. The `plan.md` digest recorded in its `state.json` at plan approval stands in for the `epic.md` hash in step 5; carry its numbered ACs over unchanged.

## 1. Bring the branch up to date
- In the task worktree, the tree is clean and everything is committed.
- `git fetch origin && git rebase origin/main`. On a conflict in migrations, financial code or anything you cannot resolve with certainty, stop and report.

## 2. Guards
- New migrations: the number follows the latest on `origin/main`, the journal entry is appended with a newer `when`. Run `node scripts/check-migration-history.mjs origin/main HEAD`.
- `node scripts/check-pr-review-signals.mjs origin/main HEAD`. If it lists T2-area files but the task was classified lower, reclassify and meet the T2 obligations before continuing. Treat a CI or guard change as needing an independent review. If it lists *Docs to check*, update the owning document or put "Docs: no change — <reason>" in the PR's *What and why*.

## 3. Checks
Run the checks AGENTS.md *Verification commands* requires for what changed: the full pre-PR set when application code changed, otherwise the rows for the touched scope (docs, agent skills or workflow files), plus any size-specific checks. Any FAIL stops here. Report every planned check as PASS, FAIL or NOT RUN with the reason.

## 4. Review prerequisites
- T1: `ponytail-review` of your own diff.
- T2, CI or guard changes: `codex-review` on the current HEAD. If commits landed after that review, review again.
- Auth, tenancy, billing/payments or secrets: also run `/security-review` in Claude Code.

## 5. Final verification
After the last change, on the commit you will push:
1. The tree is clean and rebased on `origin/main`. Record `git rev-parse HEAD` as the final SHA.
2. The guards (step 2) and checks (step 3) ran on the final SHA. Rerun any that ran on an earlier commit.
3. Every AC in `epic.md` has evidence on the final SHA. For T2, `epic.md` is still the reviewed and approved version: its SHA-256 matches the hash `codex-review` recorded; if it changed since, review it and get approval again.
4. Every file in `git diff --name-only origin/main...HEAD` is accounted for in `output.md`. Remove or explain anything else: debug code, stray files, unrelated edits.
5. `todo.md` has no open blocking item.
6. The required reviews (step 4) ran on the final SHA.

Verdict: **NOT READY** if any of these holds, naming each:
- a required check is FAIL or NOT RUN;
- an AC is not verified;
- a P0 or P1 review finding is unresolved;
- `todo.md` has an open blocking item;
- the diff has unexplained files;
- (T2) `epic.md` changed after its review or approval.

An unverified AC or a required check that cannot run passes only when the user explicitly accepts it in this session; record "Accepted by user: <reason>" in `evidence.md`. Not blocking, but listed in `evidence.md`: optional checks NOT RUN, P2 findings handed to the user, and follow-ups.

Otherwise **READY**. NOT READY stops here: fix, commit, and run this step again.

## 6. PR description
Write `.tmp/<task-slug>/pr.md` from `.github/pull_request_template.md`: what and why (from the epic), the review guide, the final verification verdict with its SHA, then the four reports in their collapsible sections. Hosted CI is NOT RUN until the PR exists. Title: a Conventional Commit line.

## 7. Ask, then ship
Show the user the branch, title, verdict and a three-line summary, and ask to push and open the PR. Only after a yes:
```sh
git push -u origin <type>/<slug>        # always an explicit branch, never a bare push
gh pr create --base main --head <type>/<slug> --title "<title>" --body-file .tmp/<task-slug>/pr.md
```
(or the host's GitHub tools; where GraphQL is unavailable, use the REST API: `gh api repos/{owner}/{repo}/pulls -f title=… -f head=… -f base=main -F body=@.tmp/<task-slug>/pr.md`). Report the PR URL. Watch checks (`gh pr checks`) only if asked; never merge.

## 8. After the merge
When the user confirms the merge:
- Offer to open a GitHub issue for each follow-up in `todo.md` (they are also in the PR description).
- Remove only this task's own work, from the main checkout. Stop and ask the user if any check fails or any command errors:
  1. The PR merged into `main` at this branch's tip: `gh api "repos/{owner}/{repo}/pulls/<n>" --jq '[.merged_at, .base.ref, .head.sha]'` shows a merge time and `main`; `.head.sha` equals `git rev-parse <type>/<slug>` and `git -C <worktree> rev-parse HEAD`, and `git worktree list --porcelain` shows `branch refs/heads/<type>/<slug>` for that worktree (not detached, not mid-rebase).
  2. The worktree holds nothing to keep: `git -C <worktree> -c status.showUntrackedFiles=all status --porcelain --ignored=matching --untracked-files=all` lists only regenerable output (`node_modules`, `.next`, `dist`, `build`, `coverage`, `.turbo`, `*.tsbuildinfo`); `git -C <worktree> ls-files -v` shows no lowercase or `S` tags (hidden edits); `git worktree list --porcelain` does not mark it `locked`.
  3. `git worktree remove <worktree>`; confirm the directory is gone. Then `git update-ref -d refs/heads/<type>/<slug> <head.sha>` (refuses if the branch moved), then delete `.tmp/<task-slug>/`.
- Run `pnpm cleanup` and report anything else it lists as DONE or REVIEW. It deletes nothing; other tasks' work and remote branches are removed only by the user or with their approval (GitHub deletes merged head branches itself when "Automatically delete head branches" is on).
