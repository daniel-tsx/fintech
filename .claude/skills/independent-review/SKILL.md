---
name: independent-review
description: Run an independent review of the current task branch or a design with a fresh Opus 5.5 reviewer at high effort, then triage its findings. Use when AGENTS.md requires an independent reviewer (T2 diffs and designs, CI or guard changes) or when the user asks for one; not for self-review of T0/T1 work.
---

# Independent review

A fresh reviewer that never saw the implementation reviews; you (the implementer) prepare the brief, run it, and triage. The reviewer never edits files.

The reviewer is the project agent `.claude/agents/independent-reviewer.md`: model `claude-opus-5-5`, effort `high`, read-only tools, its own context every time. Do not substitute another model, a lower effort, a fork of your own context, or your own re-read.

## 1. Prepare
- Work is committed on your task branch inside your worktree: review a commit, not a dirty tree.
- `git fetch origin`; rebase onto `origin/main` if it moved. Record the reviewed SHA (`git rev-parse HEAD`) and the brief's hash (`sha256sum .tmp/<task-slug>/epic.md`); both go at the top of the review file, so `ship-pr` can confirm the acceptance criteria did not change after review.
- Use the task's `.tmp/<task-slug>/epic.md` as the brief (see `ship-pr`, *Task reports*); create it if missing: problem, goal, scope and non-goals, task size, invariants and boundaries touched, numbered acceptance criteria. Facts only: no claims that the change is correct, minimal or safe.

## 2. Run (read-only, from the worktree root)
Send the reviewer only: the brief path, the reviewed SHA, the worktree path, and what to review. Code: "the changes on this branch against origin/main". Design (no diff yet): "the design in `.tmp/<task-slug>/plan.md`". No summary of your changes and no conclusions.

- **Claude Code (default):** run the `independent-reviewer` subagent (`@agent-independent-reviewer`, or the Agent tool with that agent type) in the foreground and wait for its report.
- **Separate session** (from a shell, e.g. when Codex or another tool is the host, or for process isolation):
  ```sh
  claude -p --agent independent-reviewer --model claude-opus-5-5 --effort high \
    --disallowedTools "Edit,Write,NotebookEdit" \
    "Brief: .tmp/<task-slug>/epic.md. Reviewed SHA: <sha>. Review the changes on this branch against origin/main." \
    > .tmp/<task-slug>/review-<n>.md
  ```

Save the reviewer's report to `.tmp/<task-slug>/review-<n>.md` under a header: reviewed SHA, `epic.md` hash, `Reviewer: independent-reviewer (claude-opus-5-5, high), <subagent | separate session>`. Never overwrite an earlier review file.

## 3. If the reviewer cannot run
Model unavailable, usage limit, permission or environment error: report the error once and do not loop. Do not fall back silently to another model or to your own review. Ask the user to wait and retry, choose another reviewer, or accept proceeding without one; record that choice as "Accepted by user: <reason>" in `evidence.md`.

## 4. Triage every finding
- **Accept**: reproduce it (a failing test where feasible), then fix.
- **Reject**: cite code or test evidence (file:line) showing why it does not apply.
- **Human decision**: policy, product or financial-semantics questions go to the user; do not resolve them by changing requirements.

Fix accepted findings in one wave, rerun the affected checks, and review the new SHA again with a new reviewer run. At most two correction rounds; then stop and hand the remaining findings to the user.

## 5. Report (PR Review section)
Reviewer and how it ran, reviewed SHA and `epic.md` hash, a findings table with severity and disposition, and open human decisions. This goes into the task's `evidence.md`.
