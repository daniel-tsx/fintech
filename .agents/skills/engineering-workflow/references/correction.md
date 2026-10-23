# Bounded correction

- Read reviewer findings and reproduce each accepted blocker against unchanged reviewer tests before changing implementation. Use `systematic-debugging` for unclear root causes; avoid symptom-level fixes.
- One correction agent receives the **whole actionable findings set**, plus frozen acceptance contract, exact affected code and necessary tests. Keep each wave surgical and sequential. Preserve unrelated work, original adverse reviewer assertions and historical failing baselines.
- Add permanent regression cases for real correctness defects. Do not edit the review test to force green; if reviewer test is mistaken, produce a source-backed explanation for independent adjudication.
- Re-run scoped checks plus all impacted integration suites. A correction may expose a *different* case; classify its relation to the requested contract instead of growing an unbounded whole-repo audit.
- Revision fingerprint changes after every correction. Dispatch a fresh reviewer against the **new full revision** (or a scoped fix diff plus a full baseline review package); old approval does not carry over.
- Automatic correction budget = 2 waves. P0, unapproved financial/business semantics, restricted execution, repeated P1 after two waves or mandatory missing test environment -> `BLOCKED`, with one consolidated handoff to the human. Never retry the same failure without new evidence.

## Correction rounds across resumes

Count a correction wave when a review/verification verdict enters `CORRECT_DESIGN` or `CORRECT`, not when the agent is relaunched. The two-round budget spans design/code work within the same checkpoint and **must survive restarts or explicit rebaseline**. An interrupted writer may continue its partial diff after inspection; do not create a new correction wave or mark the stage done merely because the tool stopped. Record the completed writer stage and re-dispatch a fresh reviewer after verification. See [resume.md](resume.md).
