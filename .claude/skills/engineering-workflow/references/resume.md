# Checkpoint and resume protocol (v1.1)

This protocol makes native-agent workflows **recoverable**, not asynchronous. The host must still execute an actual agent turn when resumed. An API/model usage limit cannot be automatically bypassed; no background timer or polling is implied.

## Local authoritative handoff

Use one ignored workspace **per task**, for example `.tmp/agent-workflows/r2-b2-design-pilot/`. Preserve existing task workspace files; do not overwrite old reviewer evidence. The checkpoint ledger `state.json` is a recovery hint that must be verified, **not** approval or proof that an agent actually ran. Keep required independent reviewer reports, plan, snapshots and test logs in that workspace; include no secrets or real provider payloads.

The helper lives at `scripts/engineering-workflow-state.mjs` and needs only Node 22+ and Git. Always run at the repository root. Example:

```sh
node scripts/engineering-workflow-state.mjs init r2-b2-design-pilot DESIGN_ONLY
node scripts/engineering-workflow-state.mjs resume r2-b2-design-pilot
```

`init` **refuses** to reset an existing task, preventing accidental loss of the correction budget. The helper checks the task directory is gitignored and captures HEAD, Git index, working tree, and every nonignored tracked/untracked file by content. Each mutation takes an exclusive short-lived `.checkpoint.lock` to reject concurrent writers; after an abrupt process crash a stale lock must be inspected and cleared manually only after verifying no writer remains. Ignored plan/review/log artifacts receive separate SHA-256 digests when recorded. This is local integrity detection, not a cryptographic attestation of reviewer identity.

## Completed-stage checkpoints

Only record a checkpoint **after** the stage has actually completed. Maintain the single task `state.json` instead of creating a new permanent Markdown report on each round.

```sh
# Stage begins at INSPECT
node scripts/engineering-workflow-state.mjs advance r2-b2-design-pilot READY
# Now PLAN, then PLAN_REVIEW
node scripts/engineering-workflow-state.mjs advance r2-b2-design-pilot READY --artifact .tmp/agent-workflows/r2-b2-design-pilot/plan.md
# Fresh external subagent review: never substitute an orchestrator self-review
node scripts/engineering-workflow-state.mjs advance r2-b2-design-pilot PLAN_REQUEST_CHANGES --artifact .tmp/agent-workflows/r2-b2-design-pilot/plan-review-1.md --reviewer-id codex-reviewer-1
# CORRECT_DESIGN (uses one of two total correction rounds)
node scripts/engineering-workflow-state.mjs advance r2-b2-design-pilot READY --artifact .tmp/agent-workflows/r2-b2-design-pilot/plan.md
# PLAN_REVIEW again, with a genuinely fresh context and a NEW report filename
node scripts/engineering-workflow-state.mjs advance r2-b2-design-pilot PLAN_APPROVED --artifact .tmp/agent-workflows/r2-b2-design-pilot/plan-review-2.md --reviewer-id codex-reviewer-2
# DESIGN_ONLY -> FINAL_GATE -> HUMAN_APPROVAL
node scripts/engineering-workflow-state.mjs advance r2-b2-design-pilot PASSED --artifact .tmp/agent-workflows/r2-b2-design-pilot/final-checks.json
```

The helper validates allowed state transitions and reviewer/artifact presence. It does **not** autonomously run tests or prove reviewer independence. The orchestrator must inspect actual logs, returned agent identities, approved source/plan, and required exit codes before recording `VERIFIED`, `PLAN_APPROVED`, `REVIEW_APPROVED` or `PASSED`. In `MEDIUM`/`HIGH_RISK`, expected stages after plan approval are `IMPLEMENT -> VERIFY -> CODE_REVIEW -> FINAL_GATE`; `VERIFY VERIFIED` requires a real ignored verification artifact; independent code review requires a new report and actual reviewer identifier.

## Pause and interruption

If the host interrupts a stage, record a pause if execution permissions still allow it:

```sh
node scripts/engineering-workflow-state.mjs pause r2-b2-design-pilot USAGE_LIMIT
node scripts/engineering-workflow-state.mjs resume r2-b2-design-pilot
```

Supported reasons: `USAGE_LIMIT`, `REVIEW_CAPACITY`, `PERMISSION`, `ENVIRONMENT`, `INTERRUPTED`. If tools are unavailable and pause cannot be recorded, the last *completed* checkpoint is still authoritative. Do not create a synthetic reviewer verdict.

- `READY`: fingerprint and artifacts match. Resume the **reported current stage**, not from `INSPECT`.
- `IN_PROGRESS_EDIT`: a partial diff exists in `PLAN`, `CORRECT_DESIGN`, `IMPLEMENT` or `CORRECT`. Inspect that diff; continue the same writer stage. Its previous approval cannot cover the changed implementation. Do not discard partial work.
- `BLOCKED_REVISION_CHANGED`: a revision changed while a nonwriting stage was pending. Stop; inspect the change. Do not silently reuse review or verification approval.
- `BLOCKED_EVIDENCE_CHANGED`: a recorded review/plan/check artifact was modified, deleted, or moved. Stop; preserve review history. Never convert a missing report into `APPROVED`.
- `HUMAN_APPROVAL`: terminal human gate. Resume never commits, pushes or authorizes implementation/deployment.

If an independent reviewer invocation was interrupted **before** a completed stage checkpoint, that attempt has **no approved verdict**. Re-dispatch to a fresh reviewer context, retaining the prior incomplete evidence separately. On recovery from a usage limit, the human may need to press Continue or start a new session with this task slug; this is not unattended scheduled execution.

## Source changes and explicit rebaseline

When revision/evidence integrity checks fail, first inspect `git status`, complete diff, reviewer artifacts and source fingerprints. Unplanned changes during review invalidate that review. If source truly changed and re-review is required, an authorized agent may explicitly rebaseline:

```sh
node scripts/engineering-workflow-state.mjs rebaseline r2-b2-design-pilot PLAN --reason "Source changed; re-review required"
```

For implementation mode, an approved operator may choose `PLAN` or `VERIFY` depending on the source change. `PLAN` must record the current plan again and then obtain fresh independent approval. `VERIFY` is allowed only when an unchanged approved plan still applies, and it preserves plan approval while invalidating code review and test verification; inspect this assumption explicitly before choosing it. **Rebaseline clears stale approvals and verification as appropriate, retains the used correction count and full history, and never permits HUMAN_APPROVAL to be bypassed.** Prior reviewer artifacts must remain byte-for-byte unchanged; rebaseline is not a way to erase adverse findings. If the original plan has materially changed, record the updated plan explicitly before the new review and do not treat its old approval as valid. Where the root problem is ambiguous policy, production authority or restricted execution, stop for human action rather than rebaseline.

## Final checkpoint invariants

1. Reviewer identities must be verified from real fresh subagent/session execution; an ID string in JSON alone is not proof.
2. Accepted review applies only to the reviewed revision and plan artifact. Implementation changes require verification and a fresh code-review approval.
3. Test artifacts must contain independently checked commands, environment, exit codes, skip/fail accounting, and applicable final database state. `AUTHOR_REPORTED` and `NOT_RUN` cannot satisfy mandatory gates.
4. Correction budget is two total automatic fix waves per task; `init` and `rebaseline` do not reset it.
5. Any failure to validate state, files, gitignored boundaries, recorded hashes, or permissions **fails closed** and must not advance the workflow.
6. Do not serialize secrets or large customer payloads; keep temporary artifacts gitignored and clean them only after the required handoff is preserved.
