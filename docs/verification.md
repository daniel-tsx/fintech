# Setup and verification

Status: current. Owner: local setup, CI coverage and executed verification evidence.

## Runtime and infrastructure

- `package.json` requires Node.js ≥22 and pins pnpm `10.26.0`. CI targets Node 22 and 24; local evidence below uses Node 24.19.0.
- [Compose](../docker-compose.yml) supplies PostgreSQL 17 and Redis 7.4. Install/build/unit tests need neither.
- The HTTP API and seeded dashboard need PostgreSQL only. Redis is needed by `dev:worker`. Provider-command relay/consumer additionally need RabbitMQ, which Compose does not provision.
- Integration suites construct services directly; R1 additionally starts its own isolated Nest HTTP servers on loopback with SDK-generated fixture signatures. PostgreSQL and permission to bind local test ports are required. No Redis, broker, separately running API server, seed or real Stripe credentials are required.
- Stripe secrets remain placeholders for local study. Consumers and reconciliation call external APIs if run; no external calls are required by the verification layers below.

Use a disposable local database. Integration tests append UUID fixtures; immutable ledger/audit history is intentionally not deleted. Do not point test/migration/seed commands at a shared or production database.

## Install and configuration

From the repository root, with Node and pnpm available:

```bash
pnpm install --frozen-lockfile
cp .env.example apps/api/.env
docker compose up -d --wait
pnpm db:migrate
pnpm db:seed
```

On Windows Command Prompt, replace the copy command with:

```cmd
copy .env.example apps\api\.env
```

Package scripts run from their package directories. API ConfigModule and the migration/seed `dotenv/config` import read `apps/api/.env`; a root-only `.env` is not their configuration file. Exported shell variables override dotenv values.

The web defaults match the seeded demo. To override them, create `apps/web/.env.local` with just:

```dotenv
API_BASE_URL=http://localhost:4000/api/v1
DEMO_API_KEY=fl_test_demo_6f414a845fe04eb4
```

These are public local fixtures, not private service credentials. The web fetch helper uses `API_BASE_URL` on the server; `NEXT_PUBLIC_API_BASE_URL` in the template is currently unused. Keep private values out of tracked files.

Run in separate terminals for seeded inspection:

```bash
pnpm dev:api
pnpm dev:web
```

- [Dashboard](http://localhost:3000)
- [API health](http://localhost:4000/api/v1/health), [Swagger](http://localhost:4000/docs), [metrics](http://localhost:4000/api/v1/metrics)
- [Seeded capture trace](http://localhost:3000/payments/44444444-4444-4444-8444-444444444444)

`pnpm dev` starts API and web together; it does not start infrastructure or workers.

For studying the full process topology, the additional scripts are `pnpm dev:worker`, `pnpm dev:relay` and `pnpm dev:payment-consumer`. The scheduled worker runs reconciliation periodically, which queries Stripe for known capture references. The placeholder seed IDs are not real Stripe objects. Running these processes is not an offline end-to-end payment demo; see [provider limits](real-psp-stripe.md) and [broker setup boundary](outbox-rabbitmq.md#local-execution-and-tests).

## Migrations and seed

`pnpm db:migrate` applies checked-in Drizzle SQL in journal order. `pnpm db:seed` inserts a fixed local merchant, demo users/key and a USD 100.00 captured payment with a USD 3.00 fee and balanced capture journal. Those success records are fixtures, not provider execution evidence.

`pnpm db:generate` is only for intentional schema work followed by review of a forward migration. Do not destructively regenerate the initial SQL, which contains deferred balance and immutability triggers and functional uniqueness not represented completely by Drizzle. No schema push is part of setup.

## Node checks

```bash
pnpm lint
pnpm test
pnpm build
pnpm typecheck
```

Build precedes standalone typecheck on a fresh checkout because the tracked Next `next-env.d.ts` references generated `.next/types/routes.d.ts`. On an already built checkout, typecheck can run independently.

| Layer | What it establishes | What it does not establish |
| --- | --- | --- |
| Frozen install | Lockfile/package manifest resolution | Clean native dependency installation on every host |
| Lint/typecheck | Static source checks across API/web | Runtime financial outcomes |
| `pnpm test` | API unit suite; database suite skipped unless opted in | Browser behavior or database invariants |
| `test:unit` | State transitions, journal validation/rounding, Stripe mapping/signature/normalization, capture handler, relay, ACK/retry/key reuse, reconciliation mocks | Real locks, broker deliveries or provider API behavior |
| Build | Nest compilation and Next production build | Running workers, successful API requests or a browser journey |
| PostgreSQL integration | Five financial concurrency scenarios plus 17 F02 sealing/function-context regressions using checked-in migrations | Every financial race or full lifecycle |
| Seeded HTTP/browser smoke | Local API/UI render fixture evidence | Actual authorization/capture at a PSP |

The web `test` script runs `node:test` unit tests for pure display logic (`apps/web/lib/*.test.ts`, using Node's built-in TypeScript stripping); no automated browser test suite is configured.

### Windows sandbox permissions

Jest may report `EPERM` while atomically renaming transform-cache files inside a Codex sandbox's temporary directory. Use a fresh writable ignored workspace cache for ordinary verification:

```cmd
pnpm --filter @fintech-lab/api test:unit --cacheDirectory ../../.tmp/jest-local
```

The same cache option applies to API default and integration commands. In the installed Jest 29.7.0, `--no-cache` still writes transformed code/source maps, so it alone does not resolve this failure. R2-A.2 verification reproduced failed renames in a new sandbox-temp directory and successful renames in `.tmp` and the ordinary host temp directory; no ACL change or cache deletion was needed.

A localhost PostgreSQL connection returning `EACCES` before SQL may also be an execution-sandbox restriction. Compare connectivity through the supported Codex execution-approval mechanism before changing database configuration. The R2-A.2 restoration reached its native disposable PostgreSQL 18 server only with approved host execution; Compose's separate port 5432 was not listening. Database/HTTP integration tests still require the disposable local admin setup below. This does not authorize migration of a shared database or bypassing a denied execution request.

## Risk-based verification

Choose verification with the task's invariant during planning, then review the resulting evidence before completion.

| Change | Required evidence |
| --- | --- |
| Migrations, PostgreSQL queries/transactions/locks or durable financial effects | Focused unit checks plus the relevant real PostgreSQL integration/migration cases in an isolated Docker database |
| Redis/BullMQ, message brokers or interactions between runtime services | Focused unit checks plus Docker-backed integration across the affected real boundary |
| UI, documentation or pure logic sufficiently covered by units | Relevant static/unit/browser checks; Docker is optional |

Report each planned command as **PASS**, **FAIL** or **NOT RUN**, including scope, passed/failed/skipped counts where available, and the reason for failure or omission. A configured CI job, healthy container or mocked adapter is not a passing integration test. If Docker/Compose or approved host access is unavailable, report NOT RUN and continue unrelated work; do not claim the affected integration risk is closed.

### Isolated Docker PostgreSQL command

From the repository root, with dependencies installed and Docker running:

```cmd
pnpm test:verification
pnpm test:integration:docker
```

`test:verification` runs the migration-history guard's regression tests and regression checks for the runner's isolation (including the existing dotenv loader), failure handling and evidence reporting; it does not start Docker. `test:integration:docker` reuses [development Compose](../docker-compose.yml) with a [verification-only port override](../docker-compose.integration.yml). The override requires [Compose 2.24.4+](https://docs.docker.com/reference/compose-file/merge/#replace-value). Development ports/volumes remain unchanged.

The runner generates a fresh `fintech-verify-<UUID>` project, starts only PostgreSQL on a dynamically allocated **127.0.0.1** port, and rejects shared/external volumes, bind mounts and explicit container names. It overrides inherited database/admin URLs with the run's disposable fixture URLs and neutralizes inherited dotenv file/override/vault settings using a run-owned empty file. It enables database/migration tests, runs existing `pnpm db:migrate` followed by `pnpm test:integration`, and saves Jest JSON/cache under ignored `.tmp/<project>/`. After the run it moves the specs' staged-migration and evidence byproducts (new `.tmp/` root entries with a UUID suffix, `-db.txt` or `-committed.json`) into that directory, deletes the directory after a passing run and keeps it after a failure. Task directories, worktrees and other verification projects are never touched. The root `test:integration` command delegates to the existing API script; existing Jest options and native database commands below remain available.

Normal completion, failed startup/migrations/tests, and handled interruption attempt `compose down --volumes` for **that generated project only**. Cleanup failure is FAIL even if tests passed. Docker/Compose unavailability is NOT RUN with nonzero exit status; zero executed tests cannot produce PASS. If forcibly killed or cleanup fails, use the printed project ID to retry only its cleanup from this repository:

```cmd
docker compose -p fintech-verify-<UUID> -f docker-compose.yml -f docker-compose.integration.yml down --volumes
```

Use only the ID printed by that test run. Never point this command at a development project, attach an existing volume, run the runner against an existing database, or use global `docker system/volume/container prune`. Test database histories are retained within their run until the run-owned volume is removed; no development or production history is deleted. No workers, external reconciliation or real provider consumers are started, and provider credentials are fixed test placeholders.

This command covers the existing **PostgreSQL** suite. It does not verify Redis/BullMQ or RabbitMQ application boundaries: those are currently mocked, and Compose supplies no broker. Changes to those boundaries require targeted integration tests with isolated services; report NOT RUN with the missing coverage until such checks exist. A Redis PING or broker startup alone is not application integration evidence. Extend the existing suite/Compose conventions only when a task needs that coverage, without starting workers that could call a real PSP.

CI retains its job-owned PostgreSQL service container and uses the same `pnpm db:migrate` / `pnpm test:integration` commands. Do not start a second Compose stack inside that job. Its existing conservative integration gate remains unchanged for PRs and `main`; risk-based local verification does not remove that gate.

## Database integration tests

With a disposable database already migrated (override `DATABASE_URL` if needed):

```bash
RUN_DB_TESTS=1 pnpm --filter @fintech-lab/api test:integration
```

Windows Command Prompt:

```cmd
set RUN_DB_TESTS=1
pnpm --filter @fintech-lab/api test:integration
set RUN_DB_TESTS=
```

PowerShell:

```powershell
$env:RUN_DB_TESTS='1'
pnpm --filter @fintech-lab/api test:integration
Remove-Item Env:RUN_DB_TESTS
```

[The suite](../apps/api/test/integration/financial-concurrency.spec.ts) executes:

1. Unbalanced posted journal rejection at commit by a deferred PostgreSQL trigger.
2. Only one of two payouts reserves the same available balance.
3. Concurrent refunds cannot exceed captured funds.
4. Two simultaneous signed webhook receipts deduplicate by external event ID.
5. Signed Stripe test-event processing completes capture and posts one journal.

Stripe signatures are generated and verified locally with the SDK. No Stripe call is made.

The [F02 ledger suite](../apps/api/test/integration/posted-ledger-immutability.spec.ts) adds 17 regressions covering posted inserts, entry/header mutation, TRUNCATE, concurrent posting, stale repeatable-read snapshots, valid DRAFT construction, duplicate service posting, deferred rejection and separate correction journals. Two cases also verify balanced posting and unbalanced rejection with `public` excluded from the session search path. Run it explicitly with:

```bash
RUN_DB_TESTS=1 pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/posted-ledger-immutability.spec.ts
```

The same Windows environment setup above applies. This suite uses only the disposable PostgreSQL database.

### B2.1 capture integration tests

With RUN_DB_TESTS=1, [capture integration](../apps/api/test/integration/capture-accounting-integration.spec.ts) exercises real WebhookBusinessService transactions, concurrent signed inbox processing, atomic journal/lot rollback, frozen original evidence/eligibility and dormant legacy compatibility. Run it against a disposable database with migrations 0000–0004:

```powershell
$env:RUN_DB_TESTS='1'
pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-integration.spec.ts --cacheDirectory ../../.tmp/jest-h1b21
Remove-Item Env:RUN_DB_TESTS
```

No provider/broker calls are required. New capture lots do not activate settlement/refund/dispute allocations or resolve F01. The existing pending suite below remains deliberately red.

### B1 allocation and migration tests

Migration 0004 installs a **dormant** allocation foundation; current financial writers remain legacy. With `RUN_DB_TESTS=1`, the [foundation suite](../apps/api/test/integration/capture-accounting-foundation.spec.ts) exercises scoped evidence, capacity/lifecycle, rollback, zero effects and targeted locking. The [migration suite](../apps/api/test/integration/capture-accounting-migration.spec.ts) additionally requires `RUN_MIGRATION_TESTS=1` and `MIGRATION_ADMIN_URL` for a disposable **localhost** cluster with CREATE DATABASE permission. It creates and retains fresh UUID-named databases, never drops history or accepts remote admin hosts.

```powershell
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts --cacheDirectory ../../.tmp/jest-h1b1
Remove-Item Env:RUN_DB_TESTS,Env:RUN_MIGRATION_TESTS
```

Set DATABASE_URL to a migrated disposable database and MIGRATION_ADMIN_URL to its disposable local cluster separately; do not print private URLs. Default tests skip database fixtures. CI's integration job now explicitly enables RUN_MIGRATION_TESTS and supplies its disposable service admin URL; local migration CREATE DATABASE fixtures still require those opt-ins. Hosted execution is unverified.

The [pending F01 suite](../apps/api/test/integration/settlement-f01.pending.spec.ts) additionally requires `RUN_F01_PENDING=1`. Its six correct-behavior assertions still target legacy runtime and intentionally fail until coordinated cutover, so exclude it from the green foundation command and report failed/expected legacy evidence distinctly:

```powershell
$env:RUN_DB_TESTS='1'
$env:RUN_F01_PENDING='1'
pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-h1b1
Remove-Item Env:RUN_DB_TESTS,Env:RUN_F01_PENDING
```

### B2.4 settlement integration tests

For [B2.4's separate dormant settlement suite](../apps/api/test/integration/settlement-accounting-integration.spec.ts), use a disposable database with migrations 0000–0005 and RUN_DB_TESTS=1:

```powershell
$env:RUN_DB_TESTS='1'
pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-accounting-integration.spec.ts --cacheDirectory ../../.tmp/jest-h1b24
Remove-Item Env:RUN_DB_TESTS
```

These are direct service tests with test-only dormant admission. Production settlement routes/jobs remain legacy, no scope becomes ACTIVE, and the six opt-in F01 reproductions remain separate red evidence. The suite uses actual dormant refund/dispute methods and two actual WebhookBusinessService capture cases; it does not establish full signed new-policy routing, scheduler/receipt races, real provider settlement or F04 closure.

### B3.1 integrated financial tests

[B3.1](audits/h1-fix-02-b3-1-integrated-verification.md) uses actual capture API/business transactions, dormant refund/dispute/settlement admission fixtures and current payout services. Use a disposable migrated localhost database; set DATABASE_URL as above and RUN_DB_TESTS=1, then run the new suite separately:

```powershell
pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/integrated-accounting-verification.spec.ts --cacheDirectory ../../.tmp/jest-h1b31
```

The 44 cases cover all eight accounts, lifecycle attribution, observed cross-writer blocking, rollback/replay and two explicitly reproduced admission gaps. Run the existing eight green financial suites and six opt-in legacy F01 failures separately using the exact commands in the record. Signature/authorization confirmations are fixtures in the new suite; existing signed capture processor tests remain separate. Test overrides do not activate scope or dispatch. PostgreSQL17/hosted CI and live provider/broker execution remain unverified.

## Offline demo commands

With the API and seeded database running, inspect the fixture and balance:

```bash
curl http://localhost:4000/api/v1/payments/44444444-4444-4444-8444-444444444444 \
  -H "x-api-key: fl_test_demo_6f414a845fe04eb4"
curl http://localhost:4000/api/v1/balances \
  -H "x-api-key: fl_test_demo_6f414a845fe04eb4"
```

Create local intent only (`confirm:false` does not enqueue authorization); repeat the same request to inspect `idempotency-replayed:true`:

```bash
curl -i -X POST http://localhost:4000/api/v1/payments \
  -H "x-api-key: fl_test_demo_6f414a845fe04eb4" \
  -H "Idempotency-Key: case-study-intent-001" \
  -H "Content-Type: application/json" \
  -d '{"amount":10000,"currency":"USD","paymentMethodToken":"pm_test_placeholder","captureMethod":"MANUAL","confirm":false}'
```

The multiline curl examples use Bash quoting; use `curl.exe` or `Invoke-RestMethod` with the same headers/body on Windows. Local settlement can be studied with `POST /settlements/generate` then `POST /settlements/:id/complete` using the demo API key. This changes lab accounting only and is not Stripe settlement.

For failure simulation run `pnpm --filter @fintech-lab/api test:unit` and use the [test map](failure-recovery.md).

## CI coverage

[CI](../.github/workflows/ci.yml) runs on pull requests, pushes to `main` and manual dispatch:

- Node 22/24 jobs: `node scripts/sync-agent-skills.mjs --check` before dependency installation, then frozen install, `pnpm test:verification`, lint, unit/default tests, build, typecheck.
- Node 24 integration job: fresh PostgreSQL 17 service container, frozen install, `pnpm db:migrate` and `pnpm test:integration` with `RUN_DB_TESTS=1`, `RUN_MIGRATION_TESTS=1` and `MIGRATION_ADMIN_URL` pointing only to that service. Its fixture admin can create databases/roles; publisher/worker assertions use restricted non-owner roles. Suites close connections and retain immutable fixture history locally; CI service disposal removes the job's isolated databases/roles. No seed, Redis or RabbitMQ is needed.
- Pull-request review signals (`node scripts/check-pr-review-signals.mjs <base> HEAD`): lists T2-area files and CI/guard changes in the job summary and syncs the `t2-area` and `guard-change` labels; lists removed test cases, net assertion removals, weak matchers and every `// allow-skip: <reason>` skip as warnings; and fails on added `.only`/`fit`/`fdescribe` or new skips that are neither the exact env-gated suite alias nor annotated. Its regression tests run in `pnpm test:verification`.
- Pull-request migration guard (`node scripts/check-migration-history.mjs <base> HEAD`): fails when an existing SQL migration or snapshot is modified, renamed or deleted, or an existing journal entry is changed, removed or reordered; appended migrations, snapshots and journal entries pass. Its regression tests run in `pnpm test:verification`.

The workflow default is `contents: read`, and every job uses only that except *Review signals*, which adds `issues: write` and `pull-requests: write` at job level so `gh` can create the `t2-area` and `guard-change` labels (labels are an issues API) and add or remove it on the PR. That job checks out with `persist-credentials: false`, passes the token only to the label step, and skips labelling for fork PRs, whose tokens are read-only. No job uses repository or service secrets. The workflow follows the official [PostgreSQL service-container guide](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers) and [pnpm action setup](https://github.com/pnpm/action-setup).

Configured CI is not executed CI evidence. No hosted run was triggered during this local pass.

## Verification record

Executed on **2026-10-07**, current `outbox-rabbitmq` checkout based on `5b6ebd1`, including existing dashboard edits. Node `24.19.0`, pnpm `10.26.0`, Windows; isolated PostgreSQL **18** at `127.0.0.1:55432/fintech_verification`.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; lockfile unchanged. pnpm warned that dependency build scripts were ignored. |
| `pnpm lint` | Passed |
| `pnpm typecheck` | Passed on the existing generated Next types |
| `pnpm test` | 11 suites / 34 tests passed; 1 database suite / 5 tests skipped as intended |
| `pnpm build` | Nest and Next production builds passed |
| `pnpm db:migrate`, `pnpm db:seed` | Passed on isolated PostgreSQL 18 |
| `RUN_DB_TESTS=1 pnpm --filter @fintech-lab/api test:integration` | 1 suite / 5 tests passed on isolated PostgreSQL 18; repeated successfully against fresh `fintech_ci_verification` with migrations and no seed, matching CI's database setup flow |

Environment failures were retried explicitly: Corepack's initial sandbox bootstrap hit `ENOTFOUND registry.npmjs.org`; install succeeded outside that sandbox. Jest first failed before test execution with a temporary-cache `EPERM`; rerunning `pnpm test` with `TEMP` and `TMP` pointing to the ignored workspace `.tmp` passed. Sandbox access to the isolated database returned `EACCES`; migrations/tests succeeded with localhost access permitted. Docker is unavailable, so Compose/PostgreSQL 17 containers and hosted Node 22/24 CI remain unexecuted here.

Additional local verification:

- Built API/web started against the isolated seeded database. Health returned `ok`; the seeded capture returned three journal lines and USD 97.00 pending balance.
- Intent create/replay returned `202`, the same resource and semantic response, and `idempotency-replayed:true`. Reuse with a changed amount returned `422`. JSONB replay can reorder object properties, so byte-for-byte JSON text equality is not claimed.
- Manual local settlement generation/completion moved the seeded USD 97.00 from pending to available. No provider command consumer, scheduled worker or external reconciliation was started.
- The seeded capture page was visually inspected at 1440 × 1000 and 390 × 844 CSS viewports. At mobile width, document scroll width was 390px; wide tables scroll within their panes. One [desktop screenshot](assets/payment-trace.png) was retained with fixture provenance. Other routes and full accessibility behavior were not exhaustively checked.
- All 26 Markdown files were checked: 139 relative links/anchors resolved. All 12 Mermaid blocks parsed with Mermaid 11 in the browser. CI YAML parsed with installed `js-yaml` and its triggers, matrix, commands and PostgreSQL service configuration were checked structurally; hosted workflow execution remains unverified.
- `git diff --check` passed. Targeted credential-pattern scanning found no live Stripe keys, private-key blocks or common GitHub/AWS access-key patterns in the changed documentation/configuration. Demo values remain explicitly labeled; this is not a repository-history secret audit.

### F02 verification follow-up

On 2026-10-07, [H1 Fix 01](audits/h1-fix-01-posted-ledger-immutability.md) added and verified PostgreSQL journal sealing. Lint, typecheck, 34 unit tests and API/web builds passed. The full integration suite passed 20 tests on a fresh unseeded PostgreSQL 18.6 database; all 15 F02 tests also passed explicitly on an upgraded database with a balanced existing journal. The migration refused intentionally corrupted posted history. Seed/reseed and catalog checks passed. These are local results; hosted CI/PostgreSQL 17 remain unexecuted.

On 2026-10-08, defensive function-context review added forward migration 0003 and two ordinary functional cases. Both new cases failed before hardening because the unqualified `ledger_status` type depended on the session search path. After migration, the fresh unseeded PostgreSQL 18.6 database passed all 22 integration tests; the upgraded database passed all 17 F02 cases. Fresh install, valid upgrade and refusal of retained invalid history were checked, including unchanged historical rows, function identities/grants and deferred trigger bindings. Lint, typecheck, 34 unit tests and API/web builds passed. The first build hit sandbox `EPERM` creating Next output; the permitted retry passed. No interrupted review experiment was rerun. Hosted CI/PostgreSQL 17 remain unexecuted.

[B1 checkpoint evidence](audits/h1-fix-02-b1-allocation-foundation.md) records 2026-10-09 local results: 49 default unit tests, 19 foundation + 3 migration + 17 F02 + 5 existing PostgreSQL cases (44 total), API/web lint/typecheck/build, and six expected F01 failures. Fresh installation, seeded 0000–0003 upgrade, repeated migrator no-op and unscoped legacy refusal were exercised without changing immutable history. This verifies the dormant foundation; live F01 behavior and B2/B3 cutover remain unimplemented.

[B1.1 correction evidence](audits/h1-fix-02-b1-allocation-foundation.md#b11-independent-review-corrections-2026-10-09) retains the independent REQUEST CHANGES findings and their regression fixes. Migration 0004, amended during B1.1 before commit, rejects unknown legacy ownership and partial finalization, and uses an exact numeric integer quotient. Local verification passed 50 unit tests and 30 foundation + 4 migration + 17 F02 + 5 existing PostgreSQL cases (56 total); all six unchanged F01 assertions still fail as expected. This updates foundation evidence without activating financial writers or resolving F01.

[B2.1 capture evidence](audits/h1-fix-02-b2-1-capture-integration.md) records 2026-10-09 local Node24.19.0/pnpm10.26.0/PostgreSQL18.6 verification from clean committed B1. Lint/typecheck, 50 unit tests and API/web builds passed; the initial build required a permitted retry after sandbox EPERM. The combined PostgreSQL command passed 80 cases (24 capture + 30 foundation + 4 migration + 17 F02 + 5 existing financial concurrency), including fresh 0000–0004 installation, valid legacy upgrade and unchanged migration refusal checks. All six unchanged F01 settlement assertions were executed separately and failed as expected; no scope is ACTIVE. Exact commands, environment/test-fixture corrections and remaining cutover limits are in the checkpoint. No hosted CI or live provider/broker verification is claimed.

[B2.2 refund evidence](audits/h1-fix-02-b2-2-refund-integration.md) records the separate dormant service and isolated PostgreSQL harness, forward inbox-status migration and exact commands. Local lint/typecheck, 50 unit tests and API/web builds passed. All 130 PostgreSQL cases passed: 46 refund, 27 capture, 30 foundation, 5 migration, 17 F02 and 5 existing concurrency tests. No scope is ACTIVE, runtime refund dispatch remains legacy, and all six F01 settlement assertions were executed and failed as expected. Direct service-path evidence does not establish full signed refund inbox dispatch, financial cutover, live Stripe compatibility or F04 closure.

[B2.2.1 correction](audits/h1-fix-02-b2-2-refund-integration.md#b221-independent-review-and-provider-identity-correction) follows the independent P1 review: a known mirror PaymentIntent must match frozen capture identity even when omitted by the event. Seventeen new identity/provenance/exception/rollback cases passed after a retained failing baseline; the complete PostgreSQL run passed 147 cases (63 refund plus the unchanged 84 capture/foundation/migration/F02/concurrency cases), none skipped. Lint/typecheck, 50 unit tests and API/web builds were rerun and passed. All six F01 assertions were rerun and remain red. No schema/lock/runtime activation change or live provider/dispatcher verification is claimed.

[B2.3 dispute evidence](audits/h1-fix-02-b2-3-dispute-integration.md) records 2026-10-10 local Node24.19.0/pnpm10.26.0/PostgreSQL18.6 checks against a fresh 0000–0005 database. Final lint/typecheck, 50 unit tests and API/web builds passed. All seven financial PostgreSQL suites passed **205 cases**, none skipped: 58 dispute, 63 refund, 27 capture, 30 foundation, 5 migration, 17 F02 and 5 existing concurrency. The six unchanged opt-in F01 settlement assertions failed as expected; no active accounting scope or runtime registration was added. Account-level, rollback, provider-identity, hold-adjustment and observed lock schedules verify the dormant checkpoint only. Exact commands, corrected initial fixture/static failures and B2.4/B3 limits are in the record. No hosted CI, live provider/broker or full signed dispute dispatch verification is claimed.

[B2.3.1 prerequisite correction](audits/h1-fix-02-b2-3-dispute-integration.md#b231-independent-review-and-prerequisite-correction) preserves the independent P1 finding: trusted close-before-open must retry before payment-state admission, including during a later pending capture, while untrusted provider relationships still require accounting review. Twelve permanent PostgreSQL cases ran against the old service (5 failed / 7 passed) and then passed after correction. The complete rerun passed **217 cases**, none skipped: 70 dispute plus the unchanged 147 refund/capture/foundation/migration/F02/concurrency cases. Lint/typecheck, 50 unit tests and API/web builds passed; Corepack was rerun with its installed offline cache after a sandbox lookup failure, and the build required a permitted retry after sandbox EPERM. All six F01 assertions were rerun and remain red. Scope activation, migrations, financial policy and legacy runtime dispatch remain unchanged. Tests retain original inbox evidence through service-level prerequisite/rollback and replay; scheduler backoff/dead-letter and full signed dispute routing remain unverified. Exact commands and prior review evidence remain in the checkpoint.

[B2.4 settlement evidence](audits/h1-fix-02-b2-4-settlement-integration.md) records 2026-10-10 implementation from accepted clean `main` at c44b488. Final lint/typecheck, 50 unit tests and API/web builds passed; the build required a permitted retry after sandbox EPERM creating Next output. Eight PostgreSQL suites passed **290 cases**, none skipped: 73 settlement plus all 217 accepted dispute/refund/capture/foundation/migration/F02/concurrency cases. New cases assert actual accounts, candidate estimates/final amounts, source ownership, zero effects, saved replay, rollback, deferred evidence and 22 observed service lock schedules. The six unchanged legacy F01 assertions ran before and after implementation and failed on the same accounting results. No migration, runtime registration, activation or financial policy change occurred. Exact commands, initial assertion/static failures and B3/F01/F04 limits are in the checkpoint; hosted CI/live Stripe/broker/Redis and full signed new-policy dispatch remain unverified.

[B3.1 integrated evidence](audits/h1-fix-02-b3-1-integrated-verification.md) records 2026-10-10 verification from clean accepted `main` at a9321d8. The eight existing PostgreSQL18.6 suites reran **290 green cases**; the separate new actual-capture lifecycle suite passed **44**, none skipped, for **334 permanent green PostgreSQL cases**. The seven ignored ordinary reviewer cases also reran successfully and now have equivalent permanent actual-capture coverage. All six unchanged legacy F01 assertions ran explicitly and remain red. Final lint/typecheck, 50 unit tests and API/web build passed; default tests skipped 340 database cases, executed separately. The build needed a permitted retry after sandbox EPERM. Ten new controlled schedules supplement the 22 settlement schedules. Late receipt during settlement and payout despite OPEN exception are reproduced admission gaps; no runtime source/migration/activation/policy changed. PostgreSQL17 binaries were unavailable, hosted CI/live provider/broker/Redis were not run, and F01/F04 remain open. This checkpoint supplies B3.2 design evidence, not cutover authorization.

[B3.2 B.1 trusted evidence](audits/h1-fix-02-b3-2-b1-trusted-evidence-schema.md) records the 2026-10-18 dormant forward-schema checkpoint at approved commit b8658f4. Lint/typecheck,50 unit tests and API/web builds passed; all **404 PostgreSQL cases** passed with zero skips (334 accepted +64 evidence +6 migration). The separate six unchanged F01 cases remain expected-red. Default unit execution skips410 database cases, all green/red opt-ins executed separately. The new evidence suite retains a private database so its deliberately PENDING receipts do not contaminate other suites' legacy global pollers. A before/after regression proves the receipt-parent row-version correction rejects a stale repeatable-read header writer.

For the new suites, RUN_DB_TESTS=1 uses only a disposable localhost PostgreSQL cluster with CREATEDB/CREATEROLE/function-ownership authority for migration/test setup; supply local MIGRATION_ADMIN_URL, or DATABASE_URL as the evidence suite's administrative fallback. RUN_MIGRATION_TESTS=1 additionally enables migration cases. Ordinary runtime credentials must not gain those setup privileges. Execute with the same pnpm integration command pattern above and paths `test/integration/trusted-financial-evidence.spec.ts` and `test/integration/trusted-evidence-migration.spec.ts`; the record contains the exact combined command. Restricted publisher/worker operations run under non-owner roles. No runtime producers, policy dispatch or activation are verified by SQL tests; new-contract financial references remain structurally closed. PostgreSQL17/hosted/provider/broker/Redis remain NOT RUN.

[B3.2 B.2-R0 admission evidence](audits/h1-fix-02-b3-2-b2-r0-admission-foundation.md) records the dormant0007 forward schema at baseline cdbad57, preserving the R1 preflight. Final PostgreSQL18.6 verification passed **460 cases**, none skipped:404 accepted +50 admission +6 migration. Separate unchanged F01 execution retains six expected financial failures. Lint/typecheck,50 unit tests and API/web build passed; default test execution skips466 DB opt-ins, run separately. A permitted build retry resolved sandbox EPERM; typecheck passed sequentially after build regenerated Next types. Original SQL0000–0006, runtime handlers, existing financial assertions and the preflight report are preserved. Catalog checks confirm zero ACTIVE scopes, closed UNINSTALLED/financial gates, exact migration hash, four storage models and restricted non-login function rights. SQL receipt/reader waits are not live settlement/payout evidence. Actual signed HTTP/publisher, coordinated R1/R2 dispatch, PostgreSQL17, hosted CI and provider/broker/Redis remain NOT RUN. The record contains exact commands, initial failures, pending Option A treatment and completion limits.

[R0.1 corrective evidence](audits/h1-fix-02-b3-2-b2-r0-admission-foundation.md#13-r01-author-correction--admission-classification-2026-10-18) records the independently reproduced pending-classification defect (two original failures/one control), retained-receipt/blocking-review correction and CI admin/migration opt-ins. Local PostgreSQL18.6 final matrix: **491 passed /14 suites /0 skips**, including31 classification cases and all original460. The six separate F01 cases retain their original financial failures. Lint/typecheck,50 units and API/web builds pass; default tests skip497 DB opt-ins, exercised separately. Local empty database/owner cleanup was executed without deleting financial test histories. All inspected scopes remain dormant; original review REQUEST_CHANGES awaits a fresh independent gate. PostgreSQL17/hosted Actions and R1/R2/external boundaries remain NOT RUN.

[R0.2 conflicting-delivery evidence](audits/h1-fix-02-b3-2-b2-r0-2-conflicting-delivery.md) records the dormant0008 extension at baseline5c8b1e0. Final local PostgreSQL18.6 execution passed **553 tests /16 suites /0 skips**: the accepted491 plus56 delivery and6 migration cases. The separate six unchanged F01 assertions ran and retain their baseline financial failures. Targeted new suites passed62; normal lint/typecheck,50 unit tests and API/web builds passed. Default tests skip559 DB opt-ins, all exercised separately. The build required a permitted retry after sandbox EPERM; the final typecheck ran after build. Fresh/repeated installation, populated0007 upgrade, preserved historical fingerprints, late rollback, DDL waiting, exact deferred barrier rejection, restricted capabilities, both conflict/reader orders and pooled cross-account scope blocking were executed. The first full run exposed one stale eight-migration assertion; updating it to the current nine-migration count yielded the complete green rerun. Initial SQL0000–0007, journal entries and both R1 preflight records are preserved. Catalog checks show zero ACTIVE scopes, all accounts UNINSTALLED and financial proof gates closed. No live routing or publisher login grant changed. Exact commands, initial test/approval/build failures and R1/R2 limits are in the record. R0.2 hosted CI/PostgreSQL17, signed HTTP, real provider/broker/Redis, runtime financial admission and conflict recovery remain NOT RUN; prior R0 hosted success does not verify0008.

Final R0.2 documentation checks used `node .tmp/validate-docs.cjs`:46 Markdown files,574 relative links/anchors, zero errors and CI YAML structure checked. The19 Mermaid blocks were extracted, without rerunning a Mermaid parser or renderer. `git diff --check` and whitespace checks for new files passed. Generated validators/logs, disposable database artifacts and build/cache output remain ignored; no commit or push was performed.

[R1 isolated signed receipt integration](audits/h1-fix-02-b3-2-b2-r1-signed-receipt-integration.md) records local Node24.19.0/pnpm10.26.0/PostgreSQL18.6 verification at clean approved R0.2 baseline8c332fb. The65 new permanent cases passed:31 receipt/HTTP/provenance,20 correlation, ten observed lock schedules and four injected abort/retry cases. Both complete matrix executions passed **618 tests /17 suites /0 skips**, including all553 accepted cases; the second used final explicitly qualified capability queries. Separate six unchanged F01 assertions failed with baseline-identical financial differences. Lint/typecheck,50 units and API/web builds passed; default tests skip624 DB opt-ins exercised separately. Initial cold HTTP setup exceeded Jest's default five seconds; the suite now uses a bounded15-second timeout. Initial Supertest typing/lint errors were corrected without disabling checks. Next build required the permitted sandbox EPERM retry; subsequent API rebuild and typecheck cover final source. Exact commands and initial failures are in the record.

New HTTP tests run their own raw-body Nest application on loopback; SDK signatures/secrets are explicit local fixtures. Each R1 suite creates a private database and real limited publisher/correlator LOGIN pools, without owner-role substitution or existing runtime credential changes. They test valid/invalid/modified bytes, refreshed duplicates, first-publication rollback, later-conflict retention failure/retry, unknown/known blockers, immutable correlation, proof/binding partial progress, legacy-only409 boundaries and reader/revision serialization. Successful local HTTP does not establish real Stripe, live routing or production credential isolation. No migration/schema/journal or existing runtime source changes; D02 producers, R2 financial application/recovery, new-diff hosted CI/PostgreSQL17/Node22 and operational cutover remain NOT RUN.

Final R1 preservation checks confirm all nine historical migrations, schema/journal, existing runtime/tests and previous audit records are byte-preserved; only six current documentation owners and six new deliverables differ from the clean baseline. Read-only catalogs checked89 isolated databases (77 with0008): zero ACTIVE scopes/enabled accounts and all financial proof gates closed. Documentation validation passed48 Markdown files/596 relative links and anchors, plus CI YAML structure;19 existing Mermaid blocks were extracted, without parser/render execution. `git diff --check` and all twelve deliverables' newline/trailing-whitespace checks passed. No staging/commit/push occurred; temporary artifacts remain ignored and financial histories retained.

[R2-A final dormant acceptance](audits/h1-fix-02-b3-2-b2-r2-a-financial-application-foundation.md#25-final-independent-dormant-acceptance-and-hosted-source-verification) records the independent APPROVE_DORMANT_R2_A_CHECKPOINT verdict and directly inspected [hosted run39378314646](https://github.com/daniel-tsx/fintech/actions/runs/39378314646) at source commit `088a945`, which includes correction `4b2e2df`. Node22 and24 checks passed; PostgreSQL17.11 passed **828 cases /28 suites**, with the six historical F01 cases intentionally skipped in hosted CI. Independent local PostgreSQL18 ran those six separately and preserved their baseline failures. Dormant foundation acceptance does not open operation-specific financial application, repair F01/F04/F05/F06 or resolve the known reconciliation42601 defect. Earlier hosted-not-run statements remain the evidence boundaries of their original runs; this pinned hosted result does not verify future runtime/cutover changes.

### Risk-based Docker verification (2026-10-20)

Executed on Windows with Node 24.19.0, pnpm 10.26.0, Docker Engine 29.9.1 and Compose 5.6.0. Docker access required approved host execution; the sandbox alone could not reach the engine.

| Check | Result |
| --- | --- |
| `pnpm test:verification` | **PASS** — 10 runner regressions, including unavailable Docker, unsafe resources, failure cleanup, zero-test rejection and protection against inherited dotenv overrides using the installed loader |
| `pnpm test:integration:docker` | **PASS** — fresh PostgreSQL 17 migration chain, 28 suites / 828 tests passed; the 6 historical F01 cases remain intentionally skipped. Final Jest evidence: `.tmp/fintech-verify-f1efa1c2-5431-4ba9-bd94-8e985816d7bd/jest.json` |
| Run-owned cleanup | **PASS** — both executed test projects left no containers, volumes or networks. The five pre-existing volumes and existing custom network remained present; there were no existing containers |
| Exact network-ID inventory comparison | **FAIL** — Docker's built-in `bridge` ID changed after the baseline; other existing network IDs remained. The cause was not established, so unchanged whole-engine network identity is not claimed |
| Node syntax, CI YAML/preserved service and gates, skill synchronization, diff whitespace | **PASS** — financial rules, Claude import, seven vendored skills, development Compose and application/dependency files preserved; independent review found no remaining findings |
| Hosted CI for this change, Node 22 execution, real interruption handling, Redis/BullMQ and RabbitMQ integration | **NOT RUN** — local Node 24 verification only; no relevant live service tests currently exist for Redis/broker boundaries. Failure handling is covered by runner regressions; actual signal interruption was not exercised |

### R2-B1 pre-lot evidence (2026-10-20)

[B1 implementation record](audits/h1-fix-02-b3-2-b2-r2-b1-payment-operation-evidence.md) records the dormant0011 evidence/classifier/reader/binding checkpoint. The final `pnpm test:integration:docker` run passed **895 cases /30 suites**, with the six unchanged historical F01 cases intentionally skipped there. A separate fresh Docker run executed those six and retained their expected financial assertion failures. The60-case focused proof/migration matrix is included in895, not additional coverage. Existing50 unit tests, API/web lint/typecheck/build, ten verification-runner regressions and documentation checks passed. All SQL0000–0010 and both approved design documents retain their starting bytes.

Tests use genuine SDK transport/signature fixtures and authenticated restricted LOGINs in fresh run-owned PostgreSQL17 Docker resources. They inspect zero-effect proof state, source/owner/amount refusal, immutable/versioned history, rollback, both publication/sealing/binding race orders, populated upgrades and DDL waits. No actual Stripe API, provider consumer, production dispatch, financial application, scope activation or deployed credential/fence was exercised. Hosted CI, Node22, native PostgreSQL18 and external broker/Redis/provider evidence remain NOT RUN for this diff. Exact commands, initial failures/corrections, artifact paths, preservation and review priorities are in the record.

### R2-B1.1 source consistency correction (2026-10-21)

The [B1.1 correction record](audits/h1-fix-02-b3-2-b2-r2-b1-1-contradictory-evidence-correction.md) preserves the independent four-failure baseline and records corrected SQL, unchanged reviewer results, supplemental committed-state tests and current execution limitations. Final PostgreSQL17.11 execution passed **932 cases /32 passing suites**, with six intentional F01 skips; separate F01 execution preserved all six exact historical financial failures. The final focused run passed97 cases with zero skips, including all nine unchanged reviewer cases and28 supplements; these97 overlap the932. Final lint/typecheck and50 units pass. The recursive build failed with sandbox EPERM creating Next.js output and was stopped without a permission workaround. All nine runner cleanup commands passed; an optional independent Docker inventory script was blocked by PowerShell execution policy and stopped without bypass. This correction adds no financial writer or activation; the original B1 result above remains historical evidence.

### R2-B1.2 independent findings correction (2026-10-21)

The appended [B1.2 correction section](audits/h1-fix-02-b3-2-b2-r2-b1-1-contradictory-evidence-correction.md#r2-b12-independent-review-findings-correction) records the unchanged reviewer baseline, exact three findings, new SQLSTATE/committed-state coverage and final verification. PostgreSQL17.11 passed **965 cases /34 passing suites**, with six intentional F01 skips; separate execution retained their exact six financial failures. Both unchanged reviewer suites pass9/9, and24 new acceptance cases pass. The130-case focused run overlaps the965. Units50, lint, typecheck, API/web build, documentation and diff checks pass. All nine run-owned projects were cleaned; direct label-filtered inventory found no remaining resources. This appends to preserved B1/B1.1 history and independent adverse verdicts; it does not verify external provider availability or authorize B2/activation.

### R2-B1 finalization (2026-10-22)

The [final independent acceptance](audits/h1-fix-02-b3-2-b2-r2-b1-1-contradictory-evidence-correction.md#final-independent-dormant-acceptance-2026-10-22) accepts the dormant B1/B1.1/B1.2 foundation. Finalization independently matched the approved source fingerprints, both unchanged nine-case reviewer suites, all eleven historical SQL files and the original eleven migration-journal entries. Migration0011 remains SHA-256 `84a88d8cf8118211b29adf8bd5e3bc419b3a39d57c22e8febfad514cd9d4cec5`; finalization changes no SQL semantics or financial/runtime handler.

Fresh checks use Node24.19.0, pinned pnpm10.26.0 and run-owned disposable Docker PostgreSQL17.11 databases, with the repository runner's isolated ports, credentials, dotenv and cleanup. The ignored selection helper reuses that runner without changing installation or isolation behavior. No shared/production database or real provider/consumer is used.

| Command / scope | Fresh finalization result |
| --- | --- |
| `node .tmp/b1-finalize-verify.mjs full` (unchanged `pnpm test:integration:docker` selection) | **PASS:965 tests /34 passing suites /0 failures /6 intentional F01 skips**. Includes B1 evidence56/migration4, reviewer9+9, B1.1 supplements28, B1.2 acceptance24, R1/D02, R2-A ownership/permits,21 legacy comparisons and the full historical financial matrix |
| `node .tmp/b1-finalize-verify.mjs focused` | **PASS:130 tests /6 suites /0 failures /0 skips**, overlapping the full run; both reviewer suites remain byte-identical |
| `node .tmp/b1-finalize-verify.mjs f01`, RUN_F01_PENDING=1 | **Expected FAIL:0 passed /6 historical financial failures /0 skips**, separately executed; exact names/statuses/financial assertion messages match the accepted original baseline |
| `pnpm --filter @fintech-lab/api test:unit --cacheDirectory ../../.tmp/jest-b1-finalize-unit --json --outputFile ../../.tmp/b1-finalize-unit.json` | **PASS:50 tests /12 suites /0 failures /0 skips** |
| `pnpm lint`; `pnpm build`; post-build `pnpm typecheck` | **PASS:API and web**, using the existing pinned Corepack cache |
| `pnpm test:verification`; `node scripts/sync-agent-skills.mjs --check` | **PASS:ten runner safeguards and synchronized vendored skills** |
| Documentation links/anchors and CI YAML; `git diff --check`; approved-source/history preservation | **PASS:64 Markdown files /1,107 relative links and anchors /0 errors**;19 existing Mermaid blocks inventoried, not rendered;393 source/history files byte-preserved, with only three documentation files updated during finalization |
| B1 committed fixture state and run-owned cleanup | **PASS:**zero ACTIVE scopes, contracts, enrollments, applications, permits, dispositions, journals and lots in both full/focused B1 summaries; direct Docker label inventory reports zero containers/volumes/networks for all three finalization projects |

Hosted verification must be checked against the exact published source commit, including Node22/24, PostgreSQL17 installation of0011 and both permanent reviewer suites. It is distinct from these local results; the publication handoff supplies its run URL, SHA and confirmed status. B2 accounting, source clearance and financial scope activation remain closed. Existing F01 defects, unsupported subsequent shared-PI captures, real provider delivery/entitlement and deployed operational boundaries remain separate.

## Remaining verification gaps

- Live Stripe calls, test-account multicapture availability, customer authentication and webhook forwarding.
- Live RabbitMQ publisher confirms, crash/redelivery behavior, reconnects and DLQ replay; Redis/BullMQ scheduling.
- Complete authorization matrix, account currency/ownership semantics, stale inbox leases, all out-of-order success/failure combinations, settlement races, payout versus refund/dispute races. The F02 journal/header sealing cases are covered separately by the [fix record](audits/h1-fix-01-posted-ledger-immutability.md).
- Provider settlement/report ingestion, real payouts, automated financial repair and missing-reference discovery.
- Automated browser accessibility/responsive regression coverage and hosted evidence for future runtime/cutover changes beyond the pinned R2-A source run above.

These gaps are follow-up audits, not claims of failed financial invariants or an invitation to change semantics during repository polish.
