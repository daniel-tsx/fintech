# H1 Fix 02 — B3.2 B.2-R2 D02-A R1: independent transport correction review

Status: **APPROVE_DORMANT_D02_A_CHECKPOINT**, independently reviewed **2026-10-19**. The original P1 D02-A-R01 is resolved: the unchanged reviewer regression retains the complete intermediate 503 body through the installed Stripe SDK's native retry path. No new blocking correctness finding was established.

Approval covers preservation of the isolated dormant D02-A checkpoint. It authorizes no runtime installation, production credential change, financial application, capture implementation, activation, deployment or live payment execution. No commit or push was performed. The original [independent review](h1-fix-02-b3-2-b2-r2-d02-a-independent-review.md), including its REQUEST_CHANGES verdict and failing-run evidence, remains unchanged.

## 1. Starting Git baseline and inspected diff

Checkout: `C:\Work\Learning Projects\learn-fintech`, branch `main`, HEAD **e38d30c851486c23ea4dfe09c48d65884b029b65**. The starting index was empty. The worktree contained **23 existing uncommitted deliverables: ten tracked modifications and thirteen untracked files**. A byte-hash inventory captured all 244 tracked/untracked files and 42 pre-existing ignored database/URL markers before review work.

Read all repository AGENTS/CLAUDE files, README, package scripts, agent reading matrix, verification, ledger/database/concurrency/security and Stripe boundary owners. Review authority is the [approved R2 design](h1-fix-02-b3-2-b2-r2-financial-application-design.md), [independent design review](h1-fix-02-b3-2-b2-r2-design-review.md) and [H01–H12 decisions](h1-fix-02-b3-2-human-decisions.md). Read the [original D02 implementation](h1-fix-02-b3-2-b2-r2-d02-a-provider-observations.md), original independent review above and [R1 correction record](h1-fix-02-b3-2-b2-r2-d02-a-r1-transport-correction.md).

Inspection covered the complete tracked diff and every untracked implementation, SQL, test and audit file:

- [Observed transport](../../apps/api/src/payment-provider/observed-stripe-transport.ts), [producer](../../apps/api/src/payment-provider/trusted-provider-observations.ts), [restricted database composition](../../apps/api/src/payment-provider/provider-observation-database.ts), existing Stripe adapter and provider port.
- Every statement of [migration 0009](../../apps/api/drizzle/0009_provider_observation_sources.sql), its journal entry and five schema mappings; the existing 0006 proof/source contract and 0007/0008 admission, revision and conflict predicates.
- [Original reviewer native regressions](../../apps/api/test/integration/provider-observation-review.spec.ts), [reviewer SQL regressions](../../apps/api/test/integration/provider-observation-sql-review.spec.ts), [native correction cases](../../apps/api/test/integration/provider-observation-native-transport.spec.ts), [author observation cases](../../apps/api/test/integration/provider-observations.spec.ts), [migration cases](../../apps/api/test/integration/provider-observation-migration.spec.ts) and [observation harness](../../apps/api/test/support/provider-observation-harness.ts).
- All seven existing test/harness migration-count updates, documentation changes, actual runtime symbol references and installed SDK implementation/public transport declarations.

The saved pre-correction inventory independently compares equal for 239 of 242 original files. Only transport, strengthened author retry assertions and navigation differ among those existing files; the native correction suite and correction record are additions. SQL0009, producer, restricted composition, schema/journal, both reviewer suites and original review are unchanged by the correction. SQL0009 SHA-256 is `540acefde9ed573712f64d35f44cb332c4c2e12c1210cdbb551ff368d916e00d`.

All migrations 0000–0008 compare equal with HEAD after Windows newline normalization; the first nine journal entries remain intact. Financial policies, historical audit records, existing runtime modules/configuration, package/lockfile and F01 source are preserved. This review changes only this record and one additive [navigation](../README.md) entry. No implementation or test assertion was corrected during review.

## 2. Original P1 and unchanged reproduction

The exact original regression is “retains the original HTTP error body even when the SDK retries before JSON handling” in the original reviewer native suite, starting at line 68. Its assertion at line 79 still requires the original body, COMPLETE and HTTP503 together. The entire file retains starting SHA-256 `e145f2fea42a45cdd625b3053cb39c650486eef4d14b1b46293d5ff7f2a4aa0a`; neither assertions nor the historical red-test comment changed.

The fixture replaces only native `https.request`. The installed Stripe RequestSender, NodeHttpClient and NodeHttpClientResponse run their actual code. A complete Node IncomingMessage supplies the 73-byte error body, followed by an HTTP200 refund object. `maxNetworkRetries=1` causes the SDK itself to select and perform its second attempt. No handwritten response class bypasses that decision and no provider endpoint is contacted.

The independent focused run passed **21/21 across two suites, zero skipped**, including **all four unchanged original reviewer cases** and 17 native correction cases. The full matrix repeated both suites successfully. These repeated executions are not summed as distinct coverage.

## 3. Verified SDK transport mechanism

Installed/lockfile-resolved Stripe is **22.6.2**. Inspected `cjs/RequestSender.js`, `cjs/net/NodeHttpClient.js`, `cjs/net/HttpClient.js` and their public declarations. RequestSender calls the configured client's `makeRequest`, then chooses `_shouldRetry` before JSON handling. NodeHttpClient resolves at response headers; its response's supported `toStream` returns the original IncomingMessage.

The corrected [makeRequest](../../apps/api/src/payment-provider/observed-stripe-transport.ts), lines47–52, awaits `CapturedResponse.retainBody()` before returning to RequestSender. Every actual HTTP attempt gets its own exchange before dispatch. Lines69–86 consume original Buffer chunks, copy at most 1 MiB, check native HTTP completeness and retain any available prefix on read failure. Nothing is reconstructed from a parsed SDK object, mirror or later lookup.

`toJSON`, lines88–100, lazily caches decoding or the saved SDK `makeResponseBodyError`. Malformed intermediate content therefore does not preempt status/header retry selection. A final selected response still passes through the SDK's JSON/error handler and existing Stripe adapter. Underlying timeout codes survive the body-error wrapper. The native socket timeout remains armed during acquisition; retry timing now includes body consumption, while rules, header overrides, counts and backoff remain SDK-owned.

The implementation extends public `Stripe.HttpClient`/`Stripe.HttpClientResponse`, uses `Stripe.createNodeHttpClient`, `toStream` and `makeResponseBodyError`, and does not patch private SDK code. Its supported scope is Node JSON operations; streaming downloads and Fetch transport are intentionally unsupported.

Six additional independent direct-SDK assertion probes verified HTTP400→StripeInvalidRequestError, malformed HTTP200→StripeAPIError, truncated HTTP200→StripeAPIError, body timeout→StripeConnectionError with ETIMEDOUT, zero-byte partial HTTP200, and successful JSON whose UTF-8 character crosses native stream chunks. All passed with one HTTP attempt, correct request ID and exact retained bytes. These ignored probes supplement the permanent tests; they are not additional PostgreSQL or unit-suite counts.

## 4. Before/after committed evidence and SHA-256

Before evidence below is the preserved original review's committed-state record, not a new run of old implementation code. After evidence was independently queried from committed PostgreSQL rows after the unchanged regression ran.

| Original reproduction | Before correction, original independent review | After correction, this independent run |
| --- | --- | --- |
| First HTTP attempt |503 / req_review_1 |503 / req_review_1 |
| Available error body |73 bytes supplied by complete native message |Same exact 73-byte fixture |
| Stored body/completeness |NULL / ABSENT |**73 bytes / COMPLETE** |
| Stored interpretation |UNKNOWN_OUTCOME / OUTCOME_UNCONFIRMED |**RETURNED_ERROR / RETRYABLE_TRANSPORT_FAILURE** |
| Admission disposition |AWAITING_CONFIRMATION |**AWAITING_CONFIRMATION** |
| Second attempt |200 / COMPLETE 472-byte success |200 / COMPLETE 472-byte success |
| Financial effect of intermediate503 |None |**None; zero projections for this source** |

Focused-run database: `fintech_r1_signed_edd154fd154e4be3bfca92b9b2faf480`. The exact retry reproduction committed:

| Source / ordering | Execution / source key | Status, bytes, hash and admission |
| --- | --- | --- |
| `b6f1d8d6-8e9a-46b8-9f94-2e38c8846c9f`, source_order 4, no predecessor |`a88b0bf1-a14a-4e08-8954-aa6d1bcdd0e8`, suffix`:1` |503;73/COMPLETE; SHA-256 **8bb3bc9196c2bc84721e06143d98d6c18363b28954390790b43256f1cae46882**; AWAITING_CONFIRMATION; scope/intake revision 1; zero projections |
| `4b6766b0-731f-402d-a85a-52fea7a43fb1`, source_order 5, predecessor is the503 source |Same execution, suffix`:2` |200;472/COMPLETE; SHA-256 **0b6a5c3ef291defa3ef5278cc91538fcdda66b16f6579a1d1a8ddf1900c17c30**; AWAITING_APPLICATION; revisions 2; one result projection |

Node's SHA-256 of the original 73 bytes equals PostgreSQL `sha256(response_body)`; SQL byte equality also passes. Both rows retain COMMAND_RESULT, the same account/provider key, the restricted publisher principal, SDK 22.6.2 and their correct individual request IDs. The full-matrix reproduction independently committed the same error hash in `fintech_r1_signed_0bf0fb2fb731450da30fb152e1dc38da`, execution `25f17516-162a-43c4-b394-294054cff5ce`, ordered suffixes`:1`/`:2`. The 200 body/hash differs between runs because fixture UUIDs differ.

Earlier incorrect immutable rows are not backfilled. Publication source order represents retained order; execution UUID plus one-based attempt keys and predecessor links distinguish attempts. A new same-key provider invocation has a new execution, while exact publication replay returns its original source without another obligation/revision.

## 5. Expanded transport and financial outcome checks

All requested families were executed through the permanent suites:

| Family | Independent observed result |
| --- | --- |
| A. 503 then success |Exact complete bodies, hashes, IDs, ordered attempts and stable key; only final owned result awaits application |
| B. 503 retry exhaustion |Both error bodies retained; two unconfirmed obligations; no object projection or financial finality |
| C. Multiple retries |Distinct503/500/200 bodies and hashes under one execution; ordered keys and unchanged provider request identity |
| D. Complete success |Exact bytes/status and safe request/version headers retained |
| E. Empty HTTP error |Zero-length non-NULL body, COMPLETE and empty-body hash; remains unconfirmed |
| F. Connection failure |NULL body/status/hash, ABSENT; no invented provider response |
| G. Partial/truncated response |Exact prefix/PARTIAL for drop, timeout and premature close; oversized response retains at most 1 MiB/PARTIAL; partial503 still follows SDK retry selection |
| H. Timeout/unknown |Absent pre-header timeout and partial body timeout remain unknown/unconfirmed; no release or definitive failure |
| I. Publication rollback/retry |All attempt sources, obligations, projections and revisions roll back together; retained handle republishes without another HTTPS request |
| J. Concurrency/duplicates |Exact replay, separate invocations, redelivery during publication, two-order conflicting/result/lookup/receipt/reader schedules and PostgreSQL lock waits pass |

Native cases also exercise stripe-should-retry true/false, malformed intermediate UTF-8 and the SDK's one closed-socket retry with maxNetworkRetries 0. No intermediate retry independently posts a journal. Tests compare committed payment/refund/attempt, journal/entry and lot fingerprints, not merely returned errors. A successful provider object still does not finalize workflow or money.

Complete empty, absent, partial-empty and partial-prefix evidence remain distinguishable. Fatal UTF-8 decoding refuses an authoritative parsed object while preserving original bytes. Retained header allowlists exclude Authorization, API keys and cookies; safe account/key/version/request identifiers stay associated with the correct exchange. Full provider bodies remain protected private evidence and may contain sensitive provider fields: production encryption, access/retention operations and a deployed credential audit are outside this local approval.

## 6. Financial and SQL compatibility

Migration 0009 was inspected completely but **was not modified by the correction or review**. No historical migration was regenerated. Fresh/repeated install and populated upgrade passed. The existing R0/R0.2 reader predicates and account→advisory→scope lock order remain, with only D02 obligation checks added by the original D02 migration.

| Invariant | Review conclusion and executed evidence |
| --- | --- |
| Accepted command ownership |Prospective same-TX child/outbox acceptance, full envelope comparison and SQL-derived inputs unchanged; forged AUTHORIZE/CAPTURE/REFUND/VOID commands rejected before HTTP |
| Account/mode/key |Server configuration and immutable authority remain authoritative; original key survives SDK retries/redelivery and23-hour replay guard; no replacement-key recovery |
| Source immutability/conflicts |Five append-only structures reject UPDATE/DELETE/TRUNCATE; changed source-key or contradictory outcomes append independent blockers and preserve originals |
| Mandatory admission |Source, obligation, revision and required exact projection commit atomically; deferred omission rejects; eight reviewer BEFORE/AFTER SQL-stage aborts verify rollback and later republication |
| Restricted capabilities |Actual separate LOGIN sessions run prepare/publish; owner/elevated sessions, direct table/column writes, acceptance and ledger writes are rejected. The local cluster uses trust authentication; this tests SQL role separation, not production password authentication |
| Function safety |Six relevant SECURITY DEFINER routines retain pinned pg_catalog/pg_temp paths, no PUBLIC EXECUTE, narrow NOLOGIN owners and no ledger writes/schema CREATE |
| R1/B.1/R0/R0.2 |Signed receipt identity, sealed proof 1 interpretation, conflicting-delivery barriers and scoped/account admission remain compatible across the complete regression matrix |
| Unknown outcomes |Timeout, absent/partial/malformed/error evidence cannot become SUCCESS, FAILED or no-effect without operation evidence; pending-only approved neutrality remains |
| Financial gate |No new financial writer, ACTIVE scope, financial permit, capture projection/lot/application or operational publisher registration |

The 29-case original reviewer SQL suite includes 11 observed lock schedules, plus the author concurrency cases. These are real PostgreSQL sessions with observed blocking, not timing-only promises. No provider call occurs under financial locks. Controlled interruption/COMMIT-acknowledgment probes remain transaction-boundary injection, not OS process-kill or database-wire-loss experiments.

Read-only final catalogs inspected **34 fully installed D02 databases**, checking all six functions and observation-owner privileges. A separate scope scan covered **37 databases / 775 scopes: zero ACTIVE**. All inspected D02 accounts remain UNINSTALLED. Earlier migration-stage databases without D02 were included in the scope count where their scope table exists.

## 7. Exact independent verification

Local environment: **Node 24.19.0, pnpm 10.26.0, PostgreSQL 18.6, Stripe 22.6.2**, Windows/MSVC19.44.35228. A fresh disposable localhost cluster on 55435 was initialized for this review. Primary shared matrix database: `fintech_d02_r1_review_1792419913587`; sensitive credentials/environment values were not loaded or printed. HTTP tests use fixture keys and intercepted HTTPS or isolated signed-receipt loopback servers; no real Stripe request, broker or Redis is required.

| Check | Passed | Failed | Skipped / notes |
| --- | --- | --- | --- |
| Focused original reviewer + native correction |**21 / 2 suites** |0 |0;39.639s; original4 assertions unchanged |
| Complete PostgreSQL matrix |**736 / 23 suites** |**0** |**0**;178.233s |
| Separate unchanged F01 |0 |**6 expected financial failures / 1 suite** |0;16.861s; assertion names/statuses/failure messages exactly match prior correction baseline |
| Root pnpm test |**50 / 12 unit suites** |0 |742 DB tests / 24 suites skipped by default; all executed separately above;792 discovered;69.02s |
| pnpm lint; pnpm typecheck |PASS API/web |0 |Typecheck ran after build |
| pnpm build |PASS Nest API/Next web |0 |Production build only; no deployment |
| Six direct installed-SDK probes |**6** |0 |Supplementary ignored assertions; no DB/coverage inflation |
| Documentation, whitespace and preservation |PASS |0 |Final completion details below |

The 736 distinct PostgreSQL cases comprise 334 accepted accounting/concurrency/migration cases, 70 B.1 cases, 87 R0/classification cases, 62 R0.2 cases, 80 R1 cases and 103 D02 cases. D02 comprises 51 author observations, 2 migration, 4 original native reviewer, 29 reviewer SQL and 17 native correction cases. Repeated focused/native runs are included in the full count, not added to it. The six F01 failures remain separate and open.

Exact primary commands, from `apps/api`, with explicit disposable DATABASE_URL/MIGRATION_ADMIN_URL and workspace TEMP/TMP:

```powershell
# RUN_DB_TESTS=1; installed SDK/native fixtures, no external provider:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/provider-observation-review.spec.ts test/integration/provider-observation-native-transport.spec.ts --cacheDirectory ../../.tmp/jest-d02-r1-independent --json --outputFile ../../.tmp/d02-r1-review-native.json
# Also RUN_MIGRATION_TESTS=1:
node node_modules/jest/bin/jest.js --runInBand test/integration --testPathIgnorePatterns settlement-f01.pending --cacheDirectory ../../.tmp/jest-d02-r1-independent --json --outputFile ../../.tmp/d02-r1-review-matrix.json
# Separate invocation, also RUN_F01_PENDING=1:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-d02-r1-independent --json --outputFile ../../.tmp/d02-r1-review-f01.json
```

Root checks were `pnpm.cmd lint`, `pnpm.cmd test`, `pnpm.cmd build`, then `pnpm.cmd typecheck`, `node .tmp/validate-docs.cjs` and `git diff --check`. The existing offline Corepack cache was selected explicitly; no dependency download, install or upgrade occurred. Ignored `.tmp/d02-r1-review-*` holds logs, JSON, hash/catalog evidence and supplementary probes; permanent suites remain the executable regression owners.

Initial environment attempts did not establish product failures: a cmd attachment read/pg_ctl option quoting failed; sandbox loopback access returned EACCES, the first connection preceded readiness, and the sandboxed focused attempt was interrupted without a result. Sandboxed retained-cluster startup did not persist, and its permitted recovery exceeded pg_ctl's wait. A sandboxed fresh-init attempt was interrupted while probing settings; a separately named permitted fresh cluster initialized successfully. All reported PostgreSQL results are the subsequent completed permitted runs. Root pnpm initially attempted an unavailable default Corepack cache/network lookup; selecting the installed cache resolved it. No automatic approval rejection occurred, and no failed application assertion was silently repaired.

## 8. Remaining operational limitations

NOT RUN: hosted PostgreSQL 17/Node 22 CI; real Stripe API/TLS/account/multicapture or forwarded webhook validation; live RabbitMQ/ACK/retry/DLQ or Redis/BullMQ; actual worker kill/database wire-loss; production ACL/default grants, encryption/retention or credential provisioning; deployed writer fencing, D03 cohort certification, maintenance/drain, activation or financial application. Configured CI is not executed hosted evidence for this diff.

Raw evidence currently survives SQL publication failure only while the pending handle remains in memory. Process loss cannot reconstruct a missing historical response. The original-key safe window and explicitly sourced owned lookup/review remain conservative recovery boundaries. SQL trusts the restricted attesting producer; it does not independently authenticate Stripe TLS or a stolen publisher credential.

Capture aggregate results still require attributable pre-lot proof and a later independently reviewed application contract. R2 permits/manifests, capture application, subsequent writer integration/recovery, F05/F06 corrections, active-path F04 evidence and legacy F01 closure remain separate work. No dependent implementation starts under this review.

## 9. Confirmed findings and verdict

**D02-A-R01, original P1: RESOLVED by the reviewed correction.** The exact original regression passes unchanged; genuine response bytes survive internal SDK retries, retain exact SHA-256/provenance and do not create an unintended financial effect or terminal/no-effect disposition. No new confirmed P0/P1 or acceptance-blocking P2 finding remains in the isolated scope. Previous D02-A ownership, idempotency, immutable evidence, restricted publication, admission, rollback and concurrency guarantees remain intact within their stated local evidence limits.

**APPROVE_DORMANT_D02_A_CHECKPOINT**

Recommend preserving the complete D02-A checkpoint with commit message:

```text
feat(accounting): add dormant trusted provider observations
```

This is a recommendation only. No staging, commit or push occurred. Approval authorizes an isolated dormant checkpoint, not production activation or live payment execution. Do not start capture financial application from this approval.

Completion checks passed: documentation validation covered **55 Markdown files /811 relative links and anchors**, with CI YAML structure checked and 19 existing Mermaid blocks inventoried; no diagram parser/rendering was run. `git diff --check` and final-newline/trailing-whitespace checks passed for the new record and navigation.

The final preservation helper checked all 244 starting files: 243 are byte-for-byte identical, and the index equals its starting bytes after removing exactly the one new review link. Both original reviewer suites, the original adverse review, policies, historical reviews, SQL 0000–0009, schema/journal and all implementation/test files retain their starting bytes. HEAD is unchanged, index empty, and the final 24 uncommitted deliverables are the original 23 plus this report. Saved current suite identities separately and restored all 42 starting ignored database/URL markers.

Both the retained test cluster and fresh review cluster completed graceful shutdown; no postmaster remains for either data directory. Fixture databases and immutable histories are retained. No implementation correction, runtime registration, production credential change, financial application, scope activation, staging, commit or push occurred.
