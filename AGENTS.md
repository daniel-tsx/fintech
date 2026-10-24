# Agent guide — Fintech Lab

This is a portfolio/reference payment platform. Financial correctness takes priority over convenience. Read [docs/AGENT_START_HERE.md](docs/AGENT_START_HERE.md) and the task's documents before editing behavior.

## Start here

1. Confirm the checkout and inspect `git status`. Preserve existing work.
2. Read `README.md`, `CLAUDE.md`, `docs/README.md` and `package.json`.
3. Use the reading matrix in `docs/AGENT_START_HERE.md` and the [reading budget](#files-and-artifacts). Verify documents against code.
4. State the intended change and verification. Keep the diff surgical.

## Repository context

- Repository slug: `fintech`. Workspace/application name: `fintech-lab`; package filters use `@fintech-lab/api` and `@fintech-lab/web`.
- NestJS modular monolith in `apps/api`; Next.js inspection dashboard in `apps/web`.
- Current provider is `StripePaymentProvider`. The deterministic Mock PSP exists in Git history, not the current runtime.
- Provider commands: PostgreSQL outbox → relay → RabbitMQ → consumer → `PaymentProvider`.
- BullMQ schedules inbox, internal settlement/payout and reconciliation work. PostgreSQL owns durable internal effects.
- [Verification](docs/verification.md) owns setup, environment placement, commands and evidence. Node ≥22; pnpm is pinned in `packageManager`.

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

- **Temporary files** live only in one ignored directory per task: `.tmp/<task-slug>/` (`engineering-workflow` uses `.tmp/agent-workflows/<task-slug>/`). Never write to the `.tmp/` root or to tracked paths. Keep at most `plan.md`, one `review-<n>.md` per review and one compact verification summary (commands, exit codes, pass/fail counts, short failure excerpts). Do not save full test-runner JSON, duplicate logs, source snapshots or diff copies; Git already holds them. Overwrite your own working files instead of versioning them; only reviewer reports stay immutable.
- **Cleanup:** at the end of the task, list what remains in its `.tmp` directory and delete it once the handoff is delivered; if deletion is blocked, say so. Never read or reuse another task's `.tmp` directory unless asked.
- **Permanent docs:** create a new Markdown file only when the user asks or a new subsystem has no owning document; otherwise edit the owning document. No per-round, per-review or per-checkpoint reports in `docs/`, and no run logs appended to `docs/verification.md` (it owns commands). A durable human decision gets one short entry in `docs/decisions/` (context, decision, consequences; one page at most).
- **Size limits:** plan ≤200 lines; review = findings only, ≤150 lines; decision entry ≤1 page. Needing more is a signal to split the task.
- **Reading budget:** read *Start here* plus the task's row in the reading matrix, then only what the code leads you to. `docs/audits/` and `docs/archive/` are historical: open a file there only when the task names it. Never read whole folders "for context".
- **Finish report** lists every file created, kept or deleted, including temporary ones.

## Agent Workflow & Skill Routing

Use skills conditionally and in proportion to the task. Load only the relevant entry point and supporting references as needed; prefer one primary skill per activity, adding another only for distinct value. This routing and explicit user requests determine activation; upstream "always", "any task" or session-wide language does not extend activation to unrelated activities. Once selected, follow the skill's procedure and confirmation gates. Repository safety rules, financial invariants and task-specific review requirements take precedence over code-minimalism heuristics. This section owns shared routing; [AI workflow](docs/AI_WORKFLOW.md) owns the existing work loop and payment review questions.

For vendored skills, load the repository copy from `.agents/skills/<name>/SKILL.md` in Codex or `.claude/skills/<name>/SKILL.md` in Claude Code. Same-name global skills can coexist or take precedence in a host's selector; read the local file explicitly when necessary. Do not combine competing versions. Codex uses `$skill-name`; Claude Code uses `/skill-name`.

- **Autonomous orchestration (explicit requests only):** For a requested end-to-end, reviewed high-risk workflow, use local `engineering-workflow` (`$engineering-workflow` in Codex, `/engineering-workflow` in Claude Code). It coordinates planning, fresh independent review, verification, bounded corrections and human approval. Follow all financial/sandbox rules above. Do not auto-trigger it for routine tasks or allow it to auto-commit/push/activate money movement. Its temporary handoffs belong under ignored `.tmp/agent-workflows/`.
- **Planning:** Inspect the repository and relevant documentation first. For complex, ambiguous or high-risk tasks, use `grilling` when important design decisions or trade-offs remain unresolved. Ask focused questions with recommendations; discover facts independently. Record agreed decisions and acceptance criteria in the task's owning document or plan. Obtain approval before implementing unresolved high-risk decisions. Skip grilling and unnecessary planning for trivial or well-specified tasks. `grill-me` remains an explicit interview entry point; once an interview begins, follow its confirmation gate.
- **Implementation:** For non-trivial code changes, apply `ponytail`. Reuse existing components, utilities, services and conventions; choose the smallest complete implementation without speculative abstractions or unnecessary dependencies. Preserve correctness, security, validation, error handling and domain invariants. Check affected callers and integrations; add focused tests for meaningful new logic. Its session mode does not make trivial tasks require extra ceremony.
- **Debugging:** Use `systematic-debugging` when non-trivial bugs, recurring failures, unexpected behavior or difficult test failures require investigation: reproduce, gather evidence, test hypotheses, then verify the root-cause fix with a regression. Skip it for trivial fixes with an established cause.
- **Database work:** Use `supabase-postgres-best-practices` for PostgreSQL queries, indexes, schema design, transactions, concurrency, locking, connections or performance. Read only relevant rules, apply PostgreSQL-general guidance, and never assume Supabase infrastructure or APIs. Preserve the financial/database invariants above.
- **Review:** For non-trivial changes, apply `ponytail-review` as an additional quality review, alongside applicable domain-specific review skills and the existing payment checklist. Trace the complete affected flow, including correctness, regressions, security, concurrency, performance, tests and unnecessary complexity. Prefer an independent reviewer or isolated review context when available. Report concrete findings before fixing them; the review itself changes no code.
- **Audit:** Use `ponytail-audit` for explicit repository-wide audits or major audit tasks. Do not run a whole-repository audit for each implementation.
- **Verification:** Select relevant tests, lint and type checks by risk during planning. Require Docker-backed integration tests for migrations, PostgreSQL/Redis integrations, brokers or multi-service runtime changes; Docker is optional for UI, documentation and logic sufficiently covered by unit tests. Reuse the [verification commands](docs/verification.md#risk-based-verification) with fresh run-owned resources and free ports; never reuse existing databases, volumes or containers, or run global Docker cleanup. Report each planned check as PASS, FAIL or NOT RUN with its command, scope and reason. Unavailable Docker leaves affected boundaries unverified without blocking unrelated work. Resolve blocking findings and record valuable lessons in existing owning documents or casebook conventions.

Skill provenance, synchronization and discovery checks are documented in [AI workflow](docs/AI_WORKFLOW.md#portable-agent-skills).

## Frontend Skill Routing

The two frontend skills below are optional environment-provided capabilities. Use them only when available; otherwise follow existing conventions and use available verification tools, reporting material verification gaps. Do not install or vendor them automatically.

### React and Next.js

Use `vercel-react-best-practices` for non-trivial React or Next.js tasks involving component behavior, data fetching, rendering, performance, or refactoring.

Load only relevant guidance. Skip for trivial styling or content changes.

### Browser Verification

Use `agent-browser` when browser interaction provides meaningful verification of a web-facing change.

Prioritize:

- Critical user journeys
- Interactive UI behavior
- Responsive layout and visual regressions
- Bug fixes requiring browser reproduction

Prefer local or isolated test environments. Do not access or modify production data without authorization.

Do not run browser automation for backend-only, documentation-only, or otherwise irrelevant tasks.

### Efficiency

Do not invoke multiple overlapping skills without a concrete reason. Reuse existing verification evidence when it is fresh and sufficient.

## Finish

Run relevant scripts from [verification](docs/verification.md). Before completing a task, assess whether architecture, API contracts, database schemas, business behavior or operational procedures changed; update the owning document when needed and keep the index and links current. Avoid documentation churn for trivial implementation details. Report changed files, executed checks, failures, unverified boundaries, assumptions and next steps. Do not commit or push unless the task calls for it.
