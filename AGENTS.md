# Agent guide — Fintech Lab

A portfolio/reference payment platform. Financial correctness beats convenience. This file holds the rules every task needs; skills hold their own procedures.

## Start here

1. Work in your own task worktree (see [Git and PRs](#git-and-prs)) and preserve existing work. If the worktree's `AGENTS.md` or `CLAUDE.md` differs from the copy loaded at session start, the worktree copy wins.
2. Classify the task with [Task size](#task-size) and say which size you chose. The size is the highest row any changed file or behavior matches; reclassify upward as soon as the change reaches a T2 area.
3. For T1/T2, the [reading matrix](docs/AGENT_START_HERE.md) says what to read. Before implementing, write `.tmp/<slug>/epic.md` with numbered acceptance criteria and keep `todo.md` current (the task reports in `ship-pr`). Verify documents against code and keep the diff surgical.

## Task size

| Size | What counts | Read | Verify | Review |
| --- | --- | --- | --- | --- |
| **T0 trivial** | Copy, typo, label/style, comment or doc wording; no behavior change | This file and the touched files | Cheapest relevant check | Re-read the diff |
| **T1 standard** | Bug fix, UI change, small feature or refactor outside T2 areas | T0 + `package.json`, the matrix row's code entry points, the one document owning the behavior | [Verification commands](#verification-commands) for the touched package | `ponytail-review` of your own diff |
| **T2 high-risk** | Money movement, ledger, settlement/refund/dispute/payout, migrations/schema, auth/tenancy, concurrency/locks, idempotency/retries, outbox/inbox/workers, runtime module wiring, provider integration, data deletion, security | T1 + `README.md`, every document in the matrix row, and any [approved decision record](docs/AGENT_START_HERE.md#approved-decision-records) whose invariants the change could affect | T1 + Docker integration when database, queue or transaction behavior changes | Independent reviewer (`codex-review`) |

Skill text saying "non-trivial" means T1 or T2. A bug with an unknown cause takes the size of its area. Verification follows the boundary actually touched: a T2-area change that alters no database, queue or transaction behavior still gets T2 reading and review, but not Docker.

## Verification commands

Run from the root of your worktree; [verification](docs/verification.md) owns setup and failure details.

| Scope | Commands |
| --- | --- |
| Docs only | `git diff --check`; if links changed, confirm relative links and anchors resolve |
| API code | `pnpm --filter @fintech-lab/api lint`, `... typecheck`, `... test` |
| Web UI | `pnpm --filter @fintech-lab/web lint`, then `build`, then `typecheck` (build generates route types) |
| PostgreSQL, migrations, durable financial effects | API checks + `pnpm test:verification` + `pnpm test:integration:docker` |
| Redis/BullMQ, RabbitMQ, cross-service runtime | No isolated suite yet: run unit checks and report the boundary NOT RUN |
| Agent skills or workflow files | `node scripts/sync-agent-skills.mjs --check`, `node scripts/check-engineering-workflow.mjs` |
| Before a PR that changes application code | `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm typecheck` |

Report each check as PASS, FAIL or NOT RUN with command, scope, counts and reason. Local runs are not hosted CI. Docker runs only through `pnpm test:integration:docker`, which uses fresh run-owned resources; never reuse existing databases, volumes or containers, and never run global Docker cleanup.

## Repository context

- Slug `fintech`, workspace `fintech-lab`; package filters `@fintech-lab/api` (NestJS modular monolith) and `@fintech-lab/web` (Next.js inspection dashboard). Node ≥22; pnpm pinned in `packageManager`.
- Provider is `StripePaymentProvider`; the Mock PSP exists only in Git history. Provider commands: PostgreSQL outbox → relay → RabbitMQ → consumer → `PaymentProvider`.
- BullMQ schedules inbox, internal settlement/payout and reconciliation work. PostgreSQL owns durable internal effects.

## Financial invariants

- Workflow, provider and ledger state are separate. Provider success does not itself finalize a local capture or post a journal.
- Preserve API idempotency scope, payload comparison and replayed status/body. Local intent, outbox, audit and replay response commit atomically.
- Preserve provider keys across retries and redelivery. Never generate a new key to work around an unknown outcome.
- Delivery is at-least-once. Queue IDs, Redis locks and broker ACKs are not financial uniqueness guarantees.
- Ledger postings stay balanced, currency-isolated, immutable and unique by business reference. Corrections use compensating journals.
- Captured ≠ settled ≠ paid out. Settlement and payout are internal lab accounting, not bank transfers.
- Do not change ledger semantics, fee/refund rounding, lock order or balance reservation casually: name the affected invariant and verify it explicitly.
- `apps/api/drizzle/0000_cheerful_sunset_bain.sql` holds hand-written constraints and triggers. Never replace it with generated SQL, use schema push or regenerate migration history.
- Schema changes need a reviewed forward migration that preserves deferred balance checks, immutability, evidence protections and uniqueness.
- Unit mocks cannot prove locks or commit-time constraints. Concurrency-sensitive changes need PostgreSQL verification, or the missing evidence is reported.

## Scope and safety

- Never print or commit private environment values. Checked-in demo identities and placeholder keys are local fixtures.
- No production data or migrations, real payments, live webhooks, deployment, cloud provisioning, or push without explicit authorization in the session.
- Builds and tests use mocked Stripe and broker boundaries. Never start provider consumers or call reconciliation with real credentials to verify something.
- Preserve the modular monolith and provider port. No speculative financial or product features.
- Documentation claims point to code or executed checks; separate implemented, inspected, tested and externally verified. No fabricated users, metrics, testimonials, compliance claims or readiness guarantees. License choice belongs to the owner.

## Skills

Load a skill only when its row applies; it then owns the procedure. Claude Code reads `.claude/skills/<name>/SKILL.md`, Codex `.agents/skills/<name>/SKILL.md`; prefer these repository copies over same-name global skills. This repository's rules and financial invariants win over any skill's minimalism heuristics or "always" language. [AI workflow](docs/AI_WORKFLOW.md) owns the work loop, payment review questions and skill provenance.

| Skill | Use when |
| --- | --- |
| `ponytail` | Implementing any T1/T2 code change |
| `ponytail-review` | Reviewing your own T1/T2 diff |
| `systematic-debugging` | A bug, failure or behavior whose cause is unknown |
| `grilling` | A T2 task, or a T1 product decision, still has unresolved design choices |
| `supabase-postgres-best-practices` | SQL, indexes, schema, transactions, locking or connections (PostgreSQL-general; never assume Supabase) |
| `codex-review` | Independent review: T2 diffs, T2 designs, CI or guard changes |
| `ship-pr` | A finished task branch: task reports, final verification, PR description, push after authorization, post-merge cleanup |
| `frontend-design` | Building new UI or reshaping it; stay within `docs/ui-signature.md` |
| `vercel-react-best-practices` | T1/T2 React/Next.js behavior, data fetching, rendering or performance; read only the needed `rules/` |
| `ponytail-audit` | An explicitly requested repository-wide audit |
| `engineering-workflow` | Only when the user asks for it |

- **T2 plans.** For T2 changes to schema, money semantics, locking or idempotency: write `.tmp/<slug>/plan.md` (≤200 lines: invariants, transaction boundaries, test matrix), run `codex-review` on it as a design, and get the user's approval before implementing. For a T2 task that spans several checkpoints, combines a migration with runtime changes or is likely to be interrupted, recommend `engineering-workflow` in one line and ask first.
- **Reviews.** Give the independent reviewer the task brief, acceptance criteria and the diff or design, not your conclusions. Changes touching auth, tenancy, billing/payments or secrets also get Claude Code's `/security-review`. Report findings before fixing them.
- **Browser checks.** When the host has a browser tool, check user-facing changes against `pnpm dev:web` on localhost; otherwise report browser verification NOT RUN.

## Files and artifacts

- Default to no new files. Plans, reviews and evidence go in the chat, commit messages or the PR description.
- Temporary files live only in the ignored `.tmp/<task-slug>/` of their task (`engineering-workflow`: `.tmp/agent-workflows/<task-slug>/`), never in `.tmp/` itself or tracked paths. The allowed files are the task reports and drafts listed in `ship-pr`, and `engineering-workflow`'s own set in its step 3. No full test-runner output, duplicate logs, source snapshots or diff copies.
- A task's `.tmp` files are its resume source: delete them only when it is finalized (merged, rejected, or explicitly abandoned), as `ship-pr` step 8 does. Never read or reuse another task's `.tmp` unless asked. At the end of a session, list what remains and why.
- Size limits: plan ≤200 lines, review report findings only and ≤150 lines, decision entry ≤1 page. Needing more means the task should be split.
- New Markdown files only when the user asks or a new subsystem has no owning document; otherwise edit the owning document. Nothing per-round or per-review goes into `docs/`, and no run logs go into `docs/verification.md`. A durable human decision gets one entry of at most a page in `docs/decisions/`.
- `docs/audits/` and `docs/archive/` are historical: read them only when the task names a file, or for the approved decision records T2 requires. Ripgrep-based search skips `docs/audits/` (`.rgignore`); search it by path when needed. Never read whole folders for context.

## Git and PRs

- One branch and worktree per task, from freshly fetched `origin/main` and without upstream tracking: `git fetch origin`, then `git worktree add --no-track -b <type>/<slug> .tmp/<slug>/worktree origin/main` (or a host-created `.claude/worktrees/` worktree). Types `feat/`, `fix/`, `chore/`, `docs/`; the slug does not repeat the type. If the branch exists, choose a new slug unless resuming that task. Never commit to `main`.
- Commit locally with Conventional Commits when a checkpoint passes its checks, unless the user said not to; `engineering-workflow` keeps its own no-commit rule.
- Every PR targets `main`. Do not stack PRs on other task branches: a PR merged into another branch never reaches `main`.
- Ship with `ship-pr`. Push, PR creation and merge need explicit authorization in the session; merging is always the human's (squash, after required checks pass). The PR description is the durable record.
- Never weaken or skip a test to make a check pass. CI labels T2 paths `t2-area` (overriding a smaller claimed size) and fails on focused tests and unapproved skips. Hosted CI counts only for the exact head SHA.
- Migrations are append-only (CI enforces it). Number a new one only after rebasing on the latest `main`, give its journal entry a `when` greater than every existing one (drizzle silently skips older ones), and rebase again if another PR adds a migration first.

## Finish

- Run the checks your size requires and report PASS, FAIL or NOT RUN for each.
- If architecture, API contracts, schemas, business behavior or operational procedures changed, update the owning document and its links in the same PR; skip doc churn for implementation details.
- Report changed files, checks, failures, unverified boundaries, assumptions, next steps, and every file created, kept or deleted, including temporary ones.

## Maintaining this file

Add a rule only after a real failure that a script, CI check or skill cannot catch; prefer enforcing it in tooling. A procedure belongs in its skill, a command detail in [verification](docs/verification.md). Keep this file at or below its current size (about 1,700 words) and remove rules agents follow without being told.
