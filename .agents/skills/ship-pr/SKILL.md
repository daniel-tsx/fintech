---
name: ship-pr
description: Prepare a finished task branch for a pull request (rebase, guards, pre-PR checks, review prerequisites, PR description from the template) and push or open the PR only after explicit user authorization. Use when a T1/T2 task is done; T0 changes may use it too.
---

# Ship a PR

Never push, open or merge a PR without the user's explicit go-ahead in this session. Merging is always the human's.

## 1. Bring the branch up to date
- In the task worktree, the tree is clean and everything is committed.
- `git fetch origin && git rebase origin/main`. On a conflict in migrations, financial code or anything you cannot resolve with certainty, stop and report.

## 2. Guards
- New migrations: the number follows the latest on `origin/main`, the journal entry is appended with a newer `when`. Run `node scripts/check-migration-history.mjs origin/main HEAD`.
- `node scripts/check-pr-review-signals.mjs origin/main HEAD`. If it lists T2-area files but the task was classified lower, reclassify and meet the T2 obligations before continuing. Treat a CI or guard change as needing an independent review.

## 3. Checks
Run the pre-PR set and any size-specific checks from AGENTS.md *Verification commands*. Any FAIL stops here. Report every planned check as PASS, FAIL or NOT RUN with the reason.

## 4. Review prerequisites
- T1: `ponytail-review` of your own diff.
- T2, CI or guard changes: `codex-review` on the current HEAD. If commits landed after that review, review again.
- Auth, tenancy, billing/payments or secrets: also run `/security-review` in Claude Code.

## 5. PR description
Write `.tmp/<task-slug>/pr.md` from `.github/pull_request_template.md`, including the review guide. Use only evidence from commands you actually ran; hosted CI is NOT RUN until the PR exists. Title: a Conventional Commit line.

## 6. Ask, then ship
Show the user the branch, title and a three-line summary, and ask to push and open the PR. Only after a yes:
```sh
git push -u origin <type>/<slug>        # always an explicit branch, never a bare push
gh pr create --base main --head <type>/<slug> --title "<title>" --body-file .tmp/<task-slug>/pr.md
```
(or the host's GitHub tools). Report the PR URL. Watch checks (`gh pr checks`) only if asked; never merge.

## 7. After the merge
When the user confirms the merge: remove the worktree with `git worktree remove`, delete the local branch, and delete the task's `.tmp` files.
