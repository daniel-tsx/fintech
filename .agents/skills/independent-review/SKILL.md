---
name: independent-review
description: Run an independent review of the current task branch or a design with a fresh Opus 5.5 reviewer at high effort, then triage its findings. Use when AGENTS.md requires an independent reviewer (T2 diffs and designs, CI or guard changes) or when the user asks for one; not for self-review of T0/T1 work.
---

# Independent review

A fresh reviewer that never saw the implementation reviews; you (the implementer) prepare the brief, run it, and triage. The reviewer never edits files.

The reviewer is the project agent `.claude/agents/independent-reviewer.md`: model `claude-opus-5-5`, effort `high`, its own context every time, and no file-writing tools. It keeps Bash for `git` and tests, so "no repository writes" rests on its instructions, not on a sandbox; run it from a session that is not in a bypass permission mode. Do not substitute another model, a lower effort, a fork of your own context, or your own re-read.

Inside `engineering-workflow`, use only this reviewer; that skill's own review package (BASE, staged, unstaged and untracked diff, its `.tmp/agent-workflows/<task-slug>/` paths and evidence files) and its blocked-review rule replace steps 1–3 below.

## 1. Prepare
- Work is committed on your task branch inside your worktree: review a commit, not a dirty tree.
- `git fetch origin`; rebase onto `origin/main` if it moved. Record the reviewed SHA (`git rev-parse HEAD`) and the brief's hash (`sha256sum .tmp/<task-slug>/epic.md`); both go at the top of the review file, so `ship-pr` can confirm the acceptance criteria did not change after review.
- Use the task's `.tmp/<task-slug>/epic.md` as the brief (see `ship-pr`, *Task reports*); create it if missing: problem, goal, scope and non-goals, task size, invariants and boundaries touched, numbered acceptance criteria. Facts only: no claims that the change is correct, minimal or safe.

## 2. Run (read-only, from the worktree root)
The task's `.tmp/<task-slug>/` lives in the main checkout, not in the worktree, so pass absolute paths: `T="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.tmp/<task-slug>"`.

Send the reviewer only: the absolute brief path (`$T/epic.md`), the reviewed SHA, the worktree path, and what to review. Code: "the changes on this branch against origin/main". Design (no diff yet): "the design in `$T/plan.md`". No summary of your changes and no conclusions.

- **Claude Code (default):** run the `independent-reviewer` subagent (`@agent-independent-reviewer`, or the Agent tool with that agent type) in the foreground and wait for its report.
- **Separate session** (bash; on Windows use Git Bash; from a shell, e.g. when another tool is the host, or for process isolation). Print mode denies commands that need approval, so the reviewer can read files and run read-only `git` but not tests; prefer the subagent when the review needs to run checks. `--` ends the variadic `--disallowedTools` list before the prompt:
  ```sh
  T="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.tmp/<task-slug>"
  f="$T/review-<n>.md"   # a new number; never reuse one
  { echo "Reviewed SHA: $(git rev-parse HEAD)"
    echo "Brief: $(sha256sum "$T/epic.md")"
    echo "Reviewer: independent-reviewer (claude-opus-5-5, high), separate session"; echo
    claude -p --agent independent-reviewer --model claude-opus-5-5 --effort high \
      --disallowedTools "Edit,Write,NotebookEdit" \
      -- "Brief: $T/epic.md. Worktree: $(pwd). Reviewed SHA: $(git rev-parse HEAD). Review the changes on this branch against origin/main."
  } > "$f"
  ```
  If the command fails, the file holds only the header: report the error (step 3) and use a new number for the next run.

Save a subagent's report the same way: `$T/review-<n>.md` under the same three header lines, with `subagent` as the run mode. Never overwrite an earlier review file.

## 3. If the reviewer cannot run
Model unavailable, usage limit, permission or environment error: report the error once and do not loop. The review stays required: the task waits (inside `engineering-workflow`, follow its blocked-review rule: `pause <task> REVIEW_CAPACITY`, or `BLOCKED` with the handoff). Do not fall back to another model, a lower effort or your own review unless the user explicitly names the substitute; record that as "Reviewer substituted by user: <reviewer, reason>" in `evidence.md`.

## 4. Triage every finding
- **Accept**: reproduce it (a failing test where feasible), then fix.
- **Reject**: cite code or test evidence (file:line) showing why it does not apply.
- **Human decision**: policy, product or financial-semantics questions go to the user; do not resolve them by changing requirements.

Fix accepted findings in one wave, rerun the affected checks, and review the new SHA again with a new reviewer run. At most two correction rounds; then stop and hand the remaining findings to the user.

## 5. Report (PR Review section)
Reviewer and how it ran, reviewed SHA and `epic.md` hash, a findings table with severity and disposition, and open human decisions. This goes into the task's `evidence.md`.
