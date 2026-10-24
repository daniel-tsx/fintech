---
name: engineering-workflow
description: Orchestrate an explicitly requested complex or high-risk engineering task through planning, fresh independent plan review, implementation, verification, fresh independent code review, bounded correction, and human approval. Use for "run engineering workflow", "autonomous implementation with review", or similar; do not auto-trigger for routine edits or audit-only requests.
---

# Engineering Workflow — native-agent pilot v1.1

Use this skill only when an autonomous engineering workflow is expressly requested. This is an orchestration **procedure**, not a background daemon, CI service, or automatic grant of privileges. Follow repository `AGENTS.md`, project `CLAUDE.md`, higher-priority instructions, and approved business/financial policies. Use existing skills (`ponytail`, `ponytail-review`, `systematic-debugging`, relevant database skill) within their appropriate phases; never override their project routing/safety boundaries.

## Entry and mode

1. Inspect checkout and `git status`, task owner, current code, approved decisions and verification instructions. Preserve all pre-existing changes. Establish `BASE` (current HEAD), scope, authorized actions, and exact required checks.
2. Choose the **lightest authorized mode**: `DESIGN_ONLY` for explicit design-only/dormant contract tasks; `MEDIUM` for bounded feature changes; `HIGH_RISK` for financial, migrations, auth, concurrency, recovery and live integration. The user may narrow the mode, but a lower mode may not waive project safety gates. Simple fixes use the normal repository workflow instead.
3. Create one ignored handoff directory `.tmp/agent-workflows/<task-slug>/` (verify with `git check-ignore`) and follow the repository's *Files and artifacts* rules. Keep only `state.json`, `plan.md`, one immutable `review-<n>.md` per review and one compact verification summary (commands, exit codes, counts, short failure excerpts). No source snapshots, diff copies, full runner JSON or duplicate logs: Git and the checkpoint fingerprint already cover them. These files are the resume source: keep them until the workflow is finalized (human approval or rejection with the handoff delivered) or the user explicitly abandons it; never clean them at a pause or at `HUMAN_APPROVAL`. Do **not** create permanent per-round reports. Never save secrets.
4. **Before any agent dispatch**, read [resume.md](references/resume.md), initialize or resume the local state ledger with `node scripts/engineering-workflow-state.mjs`, and inspect the returned guard status. Never infer completed work from a partial chat transcript or a reviewer summary. State and evidence are untrusted until checked against source, artifacts, execution logs and actual reviewer provenance.
5. Persist an atomic checkpoint after each *completed* stage, including an immutable review report path and a verified fresh reviewer context identifier for review stages. Preserve the original review records instead of overwriting a previous verdict. Persist pause reason when capacity, permissions or environment block progress.
6. On resume: recompute full nonignored source fingerprint and recorded artifact digests, preserve the correction budget and stage, and **redrive only an incomplete stage**. If evidence changed, do not reuse an approval. If a write stage is interrupted mid-edit, inspect its partial diff and finish that same stage before recording its checkpoint. If a review was interrupted before a saved verdict, dispatch a fresh reviewer; never claim an old incomplete attempt succeeded.
7. Read [planning.md](references/planning.md), then [review.md](references/review.md), [correction.md](references/correction.md), and [acceptance.md](references/acceptance.md) as their stages begin. Do not preload every reference for unrelated stages.

## State machine and roles

`INSPECT -> PLAN -> PLAN_REVIEW -> IMPLEMENT -> VERIFY -> CODE_REVIEW -> (CORRECT -> VERIFY -> CODE_REVIEW)* -> FINAL_GATE -> HUMAN_APPROVAL`

- In `DESIGN_ONLY`, stop after approved `PLAN_REVIEW` at `HUMAN_APPROVAL`; **do not implement**.
- Plan review and code review must use a **fresh, isolated context/subagent** with implementation write access withheld where supported; send task brief, acceptance criteria, exact BASE and current diff/evidence, not the author's narrative or approval claim. A reviewer must independently inspect actual sources. Do not call the implementer's self-review an independent review.
- If the current host cannot spawn a genuinely separate reviewer context, mark `BLOCKED_INDEPENDENT_REVIEW` and provide the handoff for a separate session. Do not silently simulate reviewer independence in the orchestrator context.
- Implementers own code changes, tests and permissible local operations; reviewers own findings/approval only. Do not parallelize implementation agents that write overlapping files. The orchestrator coordinates the stages but may not override explicit human decisions.
- Run deterministic checks with actual commands. A model verdict cannot override failing tests or an unverified required gate.
- Limit automatic correction to **two rounds** per checkpoint (shared across plan/code corrections; the ledger counter survives interruption and rebaseline). Resolve findings as one coherent fix wave; re-review the changed revision. Escalate unresolved P0/P1, a third fix round, design/policy ambiguity, permission errors or unavailable mandatory verification to `BLOCKED` with consolidated findings.

## Revision and approval integrity

Record `BASE`, full tracked and untracked inventory, and a revision fingerprint before each review. Use the checkpoint helper to hash HEAD + Git index/status + bytes of every nonignored tracked/untracked worktree file; track the plan/review/verification artifacts with separate content digests. A hash of the committed SHA alone is **not** enough for dirty working trees. Review package must include staged/unstaged diff and relevant untracked deliverables; ignored temp artifacts do not count. Any material source or test change after approval invalidates the approval until review and checks rerun for the new revision. A changed ignored plan or reviewer artifact also invalidates its recorded approval. Stale approval cannot be revived by a resume or counter reset; explicit rebaseline requires new independent checks and never grants human authorization.

No automatic commit, push, PR creation, merge, deploy, real provider calls, database production mutation or financial-scope activation without separate authorization. For this Fintech lab, keep existing dormant boundaries and existing approved financial/accounting contracts.

## Output contract

Final response: mode, checkpoint directory/state, resume guard status, correction budget, verified checkout/revision, stage reached, design/reviewer verdict, exact passed/failed/skipped/not-run checks, unresolved P0/P1/P2 issues, files changed, safety boundaries, next human decision. Distinguish *author reported*, *independently executed*, *hosted CI*, and *not tested* evidence. **`READY_FOR_HUMAN_APPROVAL` is not deployment or production approval.**

### References and inspirations

Original adaptation inspired by `obra/superpowers` (fresh implementer + spec/quality review, precise review packages), `Yeachan-Heo/oh-my-claudecode` (staged plan/exec/verify/fix pipeline), and the already installed `ponytail-review`, `grilling`, and `systematic-debugging` skills. No upstream skill code copied. See repository `docs/AI_WORKFLOW.md` for links and provenance.
