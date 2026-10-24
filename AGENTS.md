# Agent guide — Fintech Lab

This is a portfolio/reference payment platform. Financial correctness takes priority over convenience. Classify the [task size](#task-size) first; T1/T2 tasks then use [docs/AGENT_START_HERE.md](docs/AGENT_START_HERE.md) before editing behavior.

## Start here

1. Inspect `git status` and preserve existing work. Work on a task branch (see [Git and PRs](#git-and-prs)).
2. Classify the task with [Task size](#task-size), state the size you chose, and read only what it requires. Reclassify upward as soon as the change reaches a T2 area.
3. Verify documents against code. State the intended change and its verification; keep the diff surgical.

## Task size

| Size | What counts | Read | Skills | Verify | Review |
| --- | --- | --- | --- | --- | --- |
| **T0 trivial** | Copy, typo, label/style, comment or doc wording; no behavior change | This file and the touched files | None | Cheapest relevant check for the touched package | Re-read the diff |
| **T1 standard** | Bug fix, UI change, small feature or refactor outside T2 areas | T0 + `package.json`, the code entry points of the [reading matrix](docs/AGENT_START_HERE.md) row, and the one document owning the behavior you change | `ponytail`; `systematic-debugging` when the cause is unknown | [Verification commands](#verification-commands) for the touched package | `ponytail-review` of your own diff |
| **T2 high-risk** | Money movement, ledger, settlement/refund/dispute/payout, migrations/schema, auth/tenancy, concurrency/locks, idempotency/retries, outbox/inbox/workers, provider integration, data deletion, security | T1 + `README.md`, every document in the matrix row and the [approved decision records](docs/AGENT_START_HERE.md#approved-decision-records) for that area | T1 skills, `grilling` for unresolved decisions, `supabase-postgres-best-practices` for SQL | T1 + Docker integration for the affected boundary | Independent reviewer (see Review below) |

Skill text saying "non-trivial" means T1 or T2. A bug with an unknown cause takes the size of the area it is in. `engineering-workflow` runs only when the user asks for it, normally for T2. `docs/README.md` is a navigation index, not required reading.

## Verification commands

Run from the repository root. Open [verification](docs/verification.md) only for setup, environment or failure details.

| Scope | Commands |
| --- | --- |
| API code | `pnpm --filter @fintech-lab/api lint`, `... typecheck`, `... test` |
| Web UI | `pnpm --filter @fintech-lab/web lint`, then `build`, then `typecheck` (build generates route types); no automated browser tests exist |
| PostgreSQL, migrations, durable financial effects | API checks + `pnpm test:verification` + `pnpm test:integration:docker` |
| Redis/BullMQ, RabbitMQ, cross-service runtime | No isolated suite yet: run unit checks and report the boundary as NOT RUN |
| Agent skills or workflow files | `node scripts/sync-agent-skills.mjs --check`, `node scripts/check-engineering-workflow.mjs` |
| Before opening a PR (T1/T2) | `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm typecheck` |

Report each check as PASS, FAIL or NOT RUN with command, scope, counts and reason. Local runs are not hosted CI.

## Repository context

- Repository slug: `fintech`. Workspace/application name: `fintech-lab`; package filters use `@fintech-lab/api` and `@fintech-lab/web`.
- NestJS modular monolith in `apps/api`; Next.js inspection dashboard in `apps/web`.
- Current provider is `StripePaymentProvider`. The deterministic Mock PSP exists in Git history, not the current runtime.
- Provider commands: PostgreSQL outbox → relay → RabbitMQ → consumer → `PaymentProvider`.
- BullMQ schedules inbox, internal settlement/payout and reconciliation work. PostgreSQL owns durable internal effects.
- [Verification](docs/verification.md) owns setup, environment placement and detailed verification procedures. Node ≥22; pnpm is pinned in `packageManager`.

## Financial invariants

- Workflow state, provider state and ledger state are separate. Provider success does not itself finalize a local capture or post a journal.
- Preserve API idempotency scope, payload comparison and replayed status/body. Local intent, outbox, audit and replay response must commit atomically.
- Preserve provider keys across retries/redelivery. Never generate a new key to work around an unknown outcome.
- At-least-once delivery is expected. Queue IDs, Redis locks and broker ACKs are not financial uniqueness guarantees.
- Ledger postings remain balanced, currency-isolated, immutable and unique by business reference. Corrections use compensating journals.
- Captured ≠ settled; settled ≠ paid out. Settlement/payout here are internal lab accounting, not external bank transfers.
- Do not change ledger semantics, fee/refund rounding, lock order or balance reservation casually. Explain the affected invariant and verify it explicitly.
- `apps/api/drizzle/0000_cheerful_sunset_bain.sql` contains hand-written financial constraints/triggers. Do not replace it with generated SQL, use schema push, or destructively regenerate migration history.
- Schema changes require a reviewed forward migration that preserves deferred balance checks, immutability, evidence protections and uniqueness.
- Concurrency-sensitive changes need relevant PostgreSQL verification; unit mocks cannot prove locks or commit-time constraints. If unavailable, report the missing evidence.

## Scope and safety

- Never print or commit private environment values. Checked-in demo identities and placeholder keys are local fixtures.
- Use a disposable local database for integration tests; they append rows and intentionally do not delete immutable history.
- No production data/migrations, real payments, live webhooks, deployment, cloud provisioning or remote push without explicit session authorization.
- Builds/tests use mocked Stripe and broker boundaries. Do not start provider consumers or call reconciliation with real credentials as a verification shortcut.
- Preserve the modular monolith and provider port. Avoid speculative financial/product features.
- Documentation claims must point to implementation or executed checks. Separate implemented, inspected, tested and externally verified.
- No fabricated users, metrics, testimonials, compliance claims or readiness guarantees. License choice belongs to the owner.

## Files and artifacts

Default to creating no new files. The deliverable is the code and tests the task needs; plans, reviews and evidence go in the chat, commit message or PR description.

- **Temporary files** live only in one ignored directory per task: `.tmp/<task-slug>/` (`engineering-workflow` uses `.tmp/agent-workflows/<task-slug>/`). Never write to the `.tmp/` root or to tracked paths. Keep at most `plan.md`, one `review-<n>.md` per review, one compact verification summary (commands, exit codes, pass/fail counts, short failure excerpts) and, for `engineering-workflow`, its `state.json`. A task worktree (`.tmp/<task-slug>/worktree`) is a checkout, not an artifact: remove it only with `git worktree remove` after its branch is merged or abandoned. Do not save full test-runner JSON, duplicate logs, source snapshots or diff copies; Git already holds them. Overwrite your own working files instead of versioning them; only reviewer reports stay immutable.
- **Cleanup:** a task's `.tmp` files are its resume source. Delete them only when the task is finalized (PR merged or rejected, or the human approved or rejected the result and the handoff is delivered) or the user explicitly abandons it. A paused or `HUMAN_APPROVAL` workflow is not finalized. At the end of each session, list what remains and why; if deletion is blocked, say so. Never read or reuse another task's `.tmp` directory unless asked; resuming a named workflow counts as asked.
- **Permanent docs:** create a new Markdown file only when the user asks or a new subsystem has no owning document; otherwise edit the owning document. No per-round, per-review or per-checkpoint reports in `docs/`, and no run logs appended to `docs/verification.md` (it owns commands). A durable human decision gets one short entry in `docs/decisions/` (context, decision, consequences; one page at most).
- **Size limits:** plan ≤200 lines; review = findings only, ≤150 lines; decision entry ≤1 page. Needing more is a signal to split the task.
- **Reading budget:** read what your [task size](#task-size) requires, then only what the code leads you to. `docs/audits/` and `docs/archive/` are historical and opt-in, except the [approved decision records](docs/AGENT_START_HERE.md#approved-decision-records): T2 work touching their invariants must read the relevant one. Do not browse the rest unless the task names a file. Never read whole folders "for context".
- **Finish report** lists every file created, kept or deleted, including temporary ones.

## Agent Workflow & Skill Routing

Use skills conditionally and in proportion to the task. Load only the relevant entry point and supporting references as needed; prefer one primary skill per activity, adding another only for distinct value. This routing and explicit user requests determine activation; upstream "always", "any task" or session-wide language does not extend activation to unrelated activities. Once selected, follow the skill's procedure and confirmation gates. Repository safety rules, financial invariants and task-specific review requirements take precedence over code-minimalism heuristics. This section owns shared routing; [AI workflow](docs/AI_WORKFLOW.md) owns the existing work loop and payment review questions.

For vendored skills, load the repository copy from `.agents/skills/<name>/SKILL.md` in Codex or `.claude/skills/<name>/SKILL.md` in Claude Code. Same-name global skills can coexist or take precedence in a host's selector; read the local file explicitly when necessary. Do not combine competing versions. Codex uses `$skill-name`; Claude Code uses `/skill-name`.

- **Autonomous orchestration (explicit requests only):** For a requested end-to-end, reviewed high-risk workflow, use local `engineering-workflow` (`$engineering-workflow` in Codex, `/engineering-workflow` in Claude Code). It coordinates planning, fresh independent review, verification, bounded corrections and human approval. Follow all financial/sandbox rules above. Do not auto-trigger it for routine tasks or allow it to auto-commit/push/activate money movement. Its temporary handoffs belong under ignored `.tmp/agent-workflows/`.
- **Planning:** Inspect the repository and relevant documentation first. For T2 tasks, or T1 tasks with unresolved product decisions, use `grilling` when important design decisions or trade-offs remain unresolved. Ask focused questions with recommendations; discover facts independently. Keep the plan and acceptance criteria in the chat or the task's `.tmp` directory; record durable decisions in `docs/decisions/` (see [Files and artifacts](#files-and-artifacts)). Obtain approval before implementing unresolved high-risk decisions. Skip grilling and unnecessary planning for trivial or well-specified tasks. `grill-me` remains an explicit interview entry point; once an interview begins, follow its confirmation gate.
- **Implementation:** For T1/T2 code changes, apply `ponytail`. Reuse existing components, utilities, services and conventions; choose the smallest complete implementation without speculative abstractions or unnecessary dependencies. Preserve correctness, security, validation, error handling and domain invariants. Check affected callers and integrations; add focused tests for meaningful new logic. Its session mode does not make trivial tasks require extra ceremony.
- **Debugging:** Use `systematic-debugging` when non-trivial bugs, recurring failures, unexpected behavior or difficult test failures require investigation: reproduce, gather evidence, test hypotheses, then verify the root-cause fix with a regression. Skip it for trivial fixes with an established cause.
- **Database work:** Use `supabase-postgres-best-practices` for PostgreSQL queries, indexes, schema design, transactions, concurrency, locking, connections or performance. Read only relevant rules, apply PostgreSQL-general guidance, and never assume Supabase infrastructure or APIs. Preserve the financial/database invariants above.
- **Review:** For T1/T2 changes, apply `ponytail-review` as an additional quality review, alongside applicable domain-specific review skills and the existing payment checklist. Trace the complete affected flow, including correctness, regressions, security, concurrency, performance, tests and unnecessary complexity. T2 requires an independent reviewer: the other model (`codex review --base main` after Claude Code implements; a fresh Claude Code session or read-only reviewer subagent after Codex implements) or, failing that, a fresh context. Put a findings summary in the PR. Report concrete findings before fixing them; the review itself changes no code.
- **Audit:** Use `ponytail-audit` for explicit repository-wide audits or major audit tasks. Do not run a whole-repository audit for each implementation.
- **Verification:** Select checks by task size from [Verification commands](#verification-commands) during planning. Require Docker-backed integration tests for migrations, PostgreSQL/Redis integrations, brokers or multi-service runtime changes; Docker is optional for UI, documentation and logic sufficiently covered by unit tests. Docker runs use fresh run-owned resources and free ports; never reuse existing databases, volumes or containers, or run global Docker cleanup. Report each planned check as PASS, FAIL or NOT RUN with its command, scope and reason. Unavailable Docker leaves affected boundaries unverified without blocking unrelated work. Resolve blocking findings and record valuable lessons in existing owning documents or casebook conventions.

Skill provenance, synchronization and discovery checks are documented in [AI workflow](docs/AI_WORKFLOW.md#portable-agent-skills).

## Frontend skills (optional)

When the host provides them, use `vercel-react-best-practices` for T1/T2 React/Next.js behavior, data-fetching, rendering or performance work, and `agent-browser` to verify user-facing interaction or layout changes against a local environment. They are not vendored here: when absent, follow existing conventions and report browser verification as NOT RUN. Do not install them automatically or touch production data.

## Git and PRs

- One branch per task from current `main`, named `type/short-slug` (`feat/`, `fix/`, `chore/`, `docs/`). Never commit to `main`. When another agent uses the main checkout, work in a separate worktree under `.tmp/<task-slug>/`.
- Commit locally on the task branch when a checkpoint passes its checks, using Conventional Commits. A user instruction not to commit overrides this, and `engineering-workflow` runs keep their own no-automatic-commit rule.
- Push, PR creation and merge need explicit user authorization in the session. Merging is always the human's decision: squash merge after required checks pass.
- Fill the PR description from the [template](.github/pull_request_template.md): size, invariants touched, checks with PASS/FAIL/NOT RUN, unverified boundaries, review and temporary files. Evidence lives there, not in `docs/`.
- Hosted CI counts only for the exact head SHA, read from the run (for example `gh pr checks`); never infer it from local runs. It is a merge gate, not a pre-PR gate: before a push it is reported as NOT RUN.
- Existing migrations are append-only: CI (`scripts/check-migration-history.mjs`) rejects PRs that modify, rename or delete an existing SQL migration or snapshot, or change, remove or reorder an existing journal entry. New migrations, snapshots and appended journal entries pass.

## Finish

Run the checks your [task size](#task-size) requires. Before completing a task, assess whether architecture, API contracts, database schemas, business behavior or operational procedures changed; update the owning document when needed and keep the index and links current. Avoid documentation churn for trivial implementation details. Report changed files, executed checks, failures, unverified boundaries, assumptions and next steps. Commit, push and PRs follow [Git and PRs](#git-and-prs).
