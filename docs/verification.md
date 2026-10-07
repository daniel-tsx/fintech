# Setup and verification

Status: current. Owner: local setup, CI coverage and executed verification evidence.

## Runtime and infrastructure

- `package.json` requires Node.js ≥22 and pins pnpm `10.26.0`. CI targets Node 22 and 24; local evidence below uses Node 24.19.0.
- [Compose](../docker-compose.yml) supplies PostgreSQL 17 and Redis 7.4. Install/build/unit tests need neither.
- The HTTP API and seeded dashboard need PostgreSQL only. Redis is needed by `dev:worker`. Provider-command relay/consumer additionally need RabbitMQ, which Compose does not provision.
- The existing integration suite constructs services directly and uses only PostgreSQL. No Redis, broker, running HTTP server, seed or Stripe credentials are required.
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
| PostgreSQL integration | Five scenarios listed below using checked-in migrations | Every financial race or full lifecycle |
| Seeded HTTP/browser smoke | Local API/UI render fixture evidence | Actual authorization/capture at a PSP |

The web `test` script prints a notice; no automated browser test suite is configured.

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

[CI](../.github/workflows/ci.yml) runs on pushes, pull requests and manual dispatch:

- Node 22/24 jobs: frozen install, lint, unit/default tests, build, typecheck.
- Node 24 integration job: fresh PostgreSQL 17 service container, frozen install, migrations and `RUN_DB_TESTS=1` integration suite. No seed, Redis or RabbitMQ is needed.

Jobs have read-only repository permissions and use no repository/service secrets. The workflow follows the official [PostgreSQL service-container guide](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers) and [pnpm action setup](https://github.com/pnpm/action-setup).

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

## Remaining verification gaps

- Live Stripe calls, test-account multicapture availability, customer authentication and webhook forwarding.
- Live RabbitMQ publisher confirms, crash/redelivery behavior, reconnects and DLQ replay; Redis/BullMQ scheduling.
- Complete authorization matrix, journal immutability/currency edge tests, stale inbox leases, all out-of-order success/failure combinations, settlement races, payout versus refund/dispute races.
- Provider settlement/report ingestion, real payouts, automated financial repair and missing-reference discovery.
- Automated browser accessibility/responsive regression coverage and hosted CI results.

These gaps are follow-up audits, not claims of failed financial invariants or an invitation to change semantics during repository polish.
