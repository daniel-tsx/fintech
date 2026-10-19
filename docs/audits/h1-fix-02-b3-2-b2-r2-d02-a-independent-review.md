# H1 Fix 02 — B3.2 B.2-R2 D02-A: independent provider observation review

Status: **REQUEST_CHANGES**, independently reviewed **2026-10-19**. One P1 transport defect blocks this dormant checkpoint. The installed SDK skips JSON handling for intermediate retry responses, so their available original bodies are never retained. SQL ownership, admission and the executed concurrency checks otherwise passed within the isolated boundary described below.

No implementation correction, financial application, capture integration, runtime registration, activation, commit or push is included. This review adds two permanent regression suites and this record, plus documentation navigation. The failing acceptance assertion is intentionally preserved.

## 1. Reviewed baseline and complete diff

Checkout: `C:\Work\Learning Projects\learn-fintech`, HEAD **e38d30c851486c23ea4dfe09c48d65884b029b65**, matching the requested approved-design baseline. The starting index was empty. The initial implementation comprised exactly **18 uncommitted files: ten tracked modifications and eight untracked additions**. Inspection included the complete tracked diff and every untracked deliverable, including all of SQL0009. No remote operation was performed.

The [author record](h1-fix-02-b3-2-b2-r2-d02-a-provider-observations.md) remains unchanged. Authority is [H01–H12](h1-fix-02-b3-2-human-decisions.md), [approved R2 design](h1-fix-02-b3-2-b2-r2-financial-application-design.md), and [independent design review](h1-fix-02-b3-2-b2-r2-design-review.md). Earlier B.1/R0/R0.1/R0.2/R1 implementation, adverse-review, correction, acceptance and stopped-preflight records retain their original meaning and history. In particular, R0's original pending-classification finding and both stopped R1 preflights are not superseded by this review.

## 2. Inspected files and source ownership

All paths in this table are repository-relative; links identify the actual reviewed files.

| Initial deliverable | Inspection |
| --- | --- |
| [0009_provider_observation_sources.sql](../../apps/api/drizzle/0009_provider_observation_sources.sql) | Every table, index, function, trigger, constraint and grant; no historical SQL regeneration |
| [Migration journal](../../apps/api/drizzle/meta/_journal.json), [schema](../../apps/api/src/database/schema.ts) | Appended migration entry and five prospective storage mappings; historical account mode stays NULL |
| [Observed transport](../../apps/api/src/payment-provider/observed-stripe-transport.ts) | Actual HTTP request/response boundary, safe headers, byte limit and JSON consumption |
| [Restricted database](../../apps/api/src/payment-provider/provider-observation-database.ts) | Authenticated LOGIN checks, table/column privileges, explicit READ COMMITTED pool |
| [Trusted producer](../../apps/api/src/payment-provider/trusted-provider-observations.ts) | Preparation, SQL-derived input, real adapter calls, retained-byte publication and typed lookup |
| [Provider tests](../../apps/api/test/integration/provider-observations.spec.ts), [migration tests](../../apps/api/test/integration/provider-observation-migration.spec.ts), [harness](../../apps/api/test/support/provider-observation-harness.ts) | All 53 new author cases and their transport/role/acceptance fixtures |
| [Capture migration](../../apps/api/test/integration/capture-accounting-migration.spec.ts), [integrated verification](../../apps/api/test/integration/integrated-accounting-verification.spec.ts), [receipt admission migration](../../apps/api/test/integration/receipt-admission-migration.spec.ts), [delivery migration](../../apps/api/test/integration/receipt-delivery-migration.spec.ts), [settlement integration](../../apps/api/test/integration/settlement-accounting-integration.spec.ts), [trusted evidence migration](../../apps/api/test/integration/trusted-evidence-migration.spec.ts), [receipt harness](../../apps/api/test/support/trusted-receipt-harness.ts) | Nine-to-ten migration count/title changes only; original financial assertions preserved |
| Author record and [index](../README.md) | Scope, implementation claims, evidence and navigation |

Related code inspected: existing Stripe adapter/provider types; payment command handler and broker envelope; reconciliation service; trusted signed-receipt service/database composition; SQL0006 source validation, builder/reader/sealer and ownership; SQL0007/0008 admission/revision/conflict predicates; migration metadata and runtime symbol references. Installed `stripe` is **22.6.2**; its `cjs/RequestSender.js`, `cjs/net/NodeHttpClient.js` and `cjs/net/HttpClient.js` were inspected directly.

Repository guidance and current owners consulted: AGENTS, CLAUDE, README, agent reading matrix, package scripts, [verification](../verification.md), [database design](../database-design.md), [concurrency](../concurrency.md), [security](../security.md), [Stripe boundary](../real-psp-stripe.md), [outbox](../outbox-rabbitmq.md), [reconciliation](../reconciliation.md) and [failure recovery](../failure-recovery.md). Prior accepted checkpoints supply policy context; their earlier test counts are not counted as this execution's results.

Reviewer-owned additions are [native transport regressions](../../apps/api/test/integration/provider-observation-review.spec.ts), **four cases**, and [SQL/recovery/concurrency regressions](../../apps/api/test/integration/provider-observation-sql-review.spec.ts), **29 cases**. No author runtime, migration, schema or test assertion was rewritten.

## 3. Accepted-command ownership

SQL0009 `accept_provider_command` (line113) validates prospective same-transaction outbox/child versions, event and aggregate kind, child operation, payment/merchant/currency, exact amount, child UUID and canonical key. It freezes account/mode, current LEGACY/epoch0 policy, payload and ownership. It is a separate capability, unavailable to the observation LOGIN. Existing committed historical commands cannot simply be enrolled by the producer.

`prepare_provider_execution` (line145) compares broker UUID/event/aggregate/full JSON payload with immutable authority and configured account/mode before committing the execution UUID. The producer constructs adapter input from returned SQL authority, rather than the broker object. Forged amounts were independently rejected before HTTP for **AUTHORIZE, CAPTURE, REFUND and VOID**; the author matrix separately rejects forged IDs, event, owner, amount, currency and key. Wrong configured accounts fail before dispatch.

`guard_provider_command_identity` (line85) protects financial fields while allowing outbox lease/status/attempt updates. Current acceptance represents only prospective LEGACY/epoch0 commands; it supplies no installed new-policy writer. Trusted acceptance code and migration administrators remain explicit trust assumptions. An arbitrary SQL owner can construct records; neither row-version checks nor source fingerprints authenticate an administrator's intent.

The authority holds the immutable exact command snapshot; the publication fingerprint binds the source request and command UUID. There is no separate command-snapshot hash column or complete pre-call HTTP request snapshot in the execution row. That is a representation difference from the proposed design, not a demonstrated ownership substitution: the protected authority and later retained request are joinable without trusting the mirror. Prepared execution alone never proves that a request occurred.

## 4. Original response-byte evidence

The wrapper uses Stripe's supported HTTP client/response interfaces. For responses actually consumed through `CapturedResponse.toJSON`, bytes come from the Node stream before UTF-8/JSON parsing. Complete body whitespace is preserved; partial prefixes remain partial. There is no `JSON.stringify(parsed SDK result)` reconstruction in the producer.

The independent fixture preserves the **installed NodeHttpClient and NodeHttpClientResponse** and replaces only native `https.request` with controlled `IncomingMessage` streams. It does not supply a handwritten Stripe response class or call Stripe. HTTP200 success, HTTP400 error and a dropped partial response all passed exact-byte/database assertions through that installed implementation.

The retry case failed: an intermediate complete HTTP503 body was stored as absent. This is confirmed finding D02-A-R01 in section14. The supported transport interface is usable; this particular lazy capture placement does not fulfill its contract.

The retained request/response header allowlists exclude Authorization and API secrets. The 1MiB limit applies to each request/retained response; partial/oversized/error bytes remain private evidence under restricted table access. A PaymentMethod ID is a reference, not PAN/CVV. Original provider responses may contain sensitive fields and require the protected access assumed by the design; this review does not certify production storage, encryption or retention operations. No secret-bearing environment file was read or printed.

## 5. SDK retries, errors and invocation attribution

`ObservedStripeTransport.makeRequest` checks HTTPS, api.stripe.com/443, server account and POST idempotency key before dispatch. AsyncLocalStorage separates invocations; each actual HTTP attempt has its own exchange/source key. SDK/API versions, HTTP status and selected request/response headers are retained. The returned body is bound to its execution and immutable account authority.

However, stripe-node22.6.2 `RequestSender.js`, lines454–455, checks `_shouldRetry` **before** invoking the JSON response handler. The wrapper only reads in `toJSON`, lines61–76. Intermediate retry bodies therefore bypass capture entirely. The existing author retry assertion proves two source rows and stable keys, but does not assert the first body's fidelity. No attempt row is silently merged, yet the first attempt's evidence is lost.

Ordinary HTTP errors, pending objects, malformed JSON/UTF-8, partial bodies and connection failures remain distinct from financial failure. The transport retains raw invalid bytes when consumed; SQL declines an authoritative object. A successful HTTP status is not monetary success, and an SDK response is not a signed receipt. See the [pinned SDK source](https://github.com/stripe/stripe-node/blob/v22.6.2/src/RequestSender.ts) and [Stripe SDK configuration](https://github.com/stripe/stripe-node).

## 6. Immutable SQL source and projection

SQL0009 adds append-only authority, execution, source, obligation and source-to-object projection relations. All five reject UPDATE/DELETE/TRUNCATE. Composite FKs bind executions/predecessors to the same command; financial owner/account fields live in immutable authority. Source order records retention order while `observed_at` retains observation time; lookup predecessors may explicitly identify an earlier source rather than the immediately preceding publication.

`provider_form_component`/`provider_form` (lines165/175) parse retained request form bytes; `provider_source_facts` (line185) derives object/status/actual amount/currency and conflicts from retained response bytes. Requested and returned amounts remain distinguishable. Exact source replay compares the complete fingerprint; changed publication under one key retains a separate SOURCE_KEY_CONFLICT witness. Terminal contradictions preserve the original source/projection and add review. Object ownership conflicts suppress the new projection and retain an account blocker.

Only owned supported refund objects project into existing `provider_financial_observations`. Authorization/void do not masquerade as captures, and capture aggregate results remain blocked pending attributable capture proof. Existing B.1 observations retain their old format and immutable fingerprints. Sources are new evidence, not retrospective certification of old mirrors or receipts.

## 7. Observation/admission atomicity

`publish_provider_observation` (line276) creates source → `admit_provider_observation` → optional protected object projection/link within one caller transaction. Admission derives scoped versus account-wide obligation and advances guarded revisions. `check_provider_source_complete` (line333), installed as three initially deferred constraint triggers, requires the mandatory matching obligation and exact required projection at COMMIT.

The author's explicit incomplete-source COMMIT case rejected and left no committed source. Independent BEFORE/AFTER INSERT failures at each of four stages—source, obligation, object observation and projection link—passed **eight rollback tests**. Each verifies committed source/obligation/projection counts and scope/intake revisions equal their pre-publication state, then republishes retained bytes without another HTTP call. No exception alone was counted as proof of rollback.

The replaced admission reader preserves R0/R0.2 predicates and additionally refuses unresolved D02 scoped/account blockers. Pending/unknown-only observations remain Option A neutral. Signed-receipt proof/application gates remain closed; an object observation or balanced journal cannot bypass them.

## 8. Restricted SQL capabilities

The migration creates a database-specific NOLOGIN/NOINHERIT observation owner, grants narrow source/projection insertion and required reads/locking, and delegates revisions/obligations through the existing admission owner. Six new SECURITY DEFINER routines pin `pg_catalog,pg_temp`; persistent table references are qualified and all new helper/publication capabilities revoke PUBLIC EXECUTE. The replacement reader retains its existing owner/grants. No producer LOGIN or production credential grant is installed by migration0009.

The actual observation pools authenticate dedicated LOGINs. The wrapper rejects owner/elevated/member/inherited sessions, schema CREATE and direct public table or column writes. The tests reject direct acceptance, source/execution insertion and ledger writes. Independent receipt/result races use a second actual limited receipt LOGIN with the existing R1 adapter. Temporary role passwords are generated in memory and used only in newly created disposable databases; none is configured as active application credentials.

Read-only catalogs inspected **eight fully installed D02 databases**, including retained author fixtures and this review's databases: **zero ACTIVE scopes, zero enabled accounts**; all six checked definer routines had pinned paths/no PUBLIC EXECUTE, and observation owners lacked LOGIN, schema CREATE and ledger table/column writes. Incomplete retained author-iteration databases were excluded after checking for the final projection relation.

These results establish the tested SQL boundary, not TLS authenticity. A stolen trusted publisher credential could attest invented bytes; ordinary callers lack that capability. Real credential provisioning, a complete deployed ACL/default-privilege audit and operational isolation remain future gates.

## 9. Unknown-outcome recovery and failure windows

| Scenario | Executed evidence / limit |
| --- | --- |
| A/B: confirmed success or definitive refund failure | Independent/author source, obligation, projection and unchanged financial-state assertions; no journal or reservation release |
| C: pending/requires_action | Two independent neutral admission cases; retained projection does not become confirmed money |
| D: complete HTTP error | Native HTTP400 exact bytes pass; intermediate SDK-retried HTTP503 fails fidelity |
| E: incomplete body | Native dropped response retains30 bytes/PARTIAL/unknown; author partial/oversize/malformed fixtures also pass |
| F: timeout after possible send | Unknown source, stable key and truthful later owned lookup; no definitive failure |
| G/I: provider response followed by failed SQL publication | Author rollback plus eight independent SQL-stage aborts; no partial source/admission/revision commits |
| H: interruption after preparation COMMIT, before call | Independent wrapper throws after actual preparation commit; execution survives with no HTTP/source, then stable-key retry succeeds |
| J: broker redelivery | Separate executions and same provider key; controlled redelivery waits behind publication and retains two sources |
| Publication COMMIT acknowledgment lost | Independent wrapper throws after actual successful COMMIT; republishing returns the durable result without another revision/source |

Interruption and acknowledgment-loss tests inject failures at service/transaction boundaries. They do **not** kill an OS worker or drop a real database connection mid-COMMIT. There is no live dormant worker registration to certify. The committed-state checks distinguish rollback from committed-but-unacknowledged publication without claiming that external operational exercise.

Automatic POST retries stop conservatively23 hours after earliest preparation, checked in SQL and before each transport attempt. Expired recovery permits owned lookup/review, never a replacement key. Stripe may prune keys after at least24 hours; it also caches error results. [Stripe idempotency contract](https://docs.stripe.com/api/idempotent_requests). Retained bytes live in the pending handle, not a durable spool; process loss cannot recreate the missing historical response.

## 10. Reconciliation provenance

`lookup` requires an accepted owned target, reconciliation run, actor, configured account/mode and appropriate prior source or prepared command. It uses `fetchStatus` outside SQL and publishes PROVIDER_LOOKUP with GET request/path/body/version lineage, NULL execution identity and explicit target/run/actor. A lookup cannot become COMMAND_RESULT or recover a response never retained. Arbitrary refund IDs are rejected before GET.

Both controlled lookup/result publication orders preserve separate kinds and immutable history. Existing ReconciliationService remains detection/note/audit only and is not re-registered to this producer. Mutable provider mirrors and resolved issue notes confer no new financial authority. No missing historical observation is backfilled.

## 11. Lock order and concurrency evidence

The actual isolated graph is:

| Path | Order |
| --- | --- |
| Prospective acceptance fixture | Account SHARE → newly owned child/outbox → immutable authority/FKs; no provider call |
| Execution preparation | Immutable authority reads → account SHARE → new execution/FKs → COMMIT; HTTP occurs afterward |
| Publication | Immutable authority read → account UPDATE → new source/FKs to immutable execution/prior → admission account reentry/intake → known-scope advisory → scope NO KEY UPDATE → revisions/obligation → object projection/FKs/link → deferred validation/COMMIT |
| Admission reader | Account SHARE → canonical advisory → scope NO KEY UPDATE → fresh revisions/blocker checks |
| R1 receipt/correlation | Existing private inbox → account UPDATE → applicable advisory/scope/financial suffix, in the existing separate publication/sealer/binder transactions |

Source/execution FK locks do not update an operation's shared outbox lease. No provider call occurs under financial locks. Source order and account UPDATE serialize duplicate/conflicting publications before their checks. Unknown-owner publication retains its account barrier without guessing another merchant's scope.

The **29-case independent SQL suite includes11 observed PostgreSQL lock schedules**: two terminal-conflict orders, two lookup/result orders, two actual signed-receipt/result orders, two unknown/known-scope publication orders, two unknown-source/clearance-reader orders and redelivery during publication. Gates hold actual transaction work, use distinct backend PIDs and `pg_blocking_pids`, bound waits, release in finally and await every participant. All these schedules committed as expected or rejected the blocked reader; no40P01 was accepted as success or retried into a passing schedule.

The author's simultaneous same-response/distinct-execution and reader/publication cases also reran. Stale expected clearance revisions rejected after publication. Failed-publication retry and committed-response-loss tests check final database contents. These finite schedules do not establish universal deadlock freedom, actual broker/network crash recovery or future financial-writer compatibility. [PostgreSQL row/advisory lock semantics](https://www.postgresql.org/docs/18/explicit-locking.html), [definer privilege guidance](https://www.postgresql.org/docs/18/sql-createfunction.html).

## 12. Historical and dormant compatibility

Migrations0000–0008, prior audit records, accepted decisions and the six F01 source assertions remain unchanged. Existing test edits are migration-count maintenance only. The full financial/evidence matrix passes without changing original accounting expectations. Separate F01 execution has **exactly equal names, statuses and failure messages** to the retained author F01 JSON, including the original financial differences.

Repository-wide symbol searches find the producer only in its new implementation files; no live module/controller/job/consumer/relay uses it. No financial application, ledger/payout writer, ACTIVE scope, historical backfill, D03 enrollment, credential fence or retry/ACK semantic change was added. Ordinary current runtime remains outside D02 acceptance. F01/F04/F05/F06 remain open.

## 13. Exact independent verification

Environment: Windows, Node**24.19.0**, pnpm**10.26.0**, stripe-node**22.6.2**, PostgreSQL**18.6**, x86_64-windows/MSVC19.44.35228. Installed dependencies and offline Corepack cache; no dependency installation/upgrade. Disposable loopback cluster127.0.0.1:55433 and a fresh matrix database `fintech_d02_independent_1792411854625`; fixture/migration suites create their own retained databases.

| Executed check | Result |
| --- | --- |
| Original full green PostgreSQL matrix | **686 passed /20 suites /0 skipped**,298.892s; includes51 author D02 provider +2 D02 migration cases and633 existing cases |
| Final independent SQL suite | **29 passed /1 suite /0 skipped**,80.649s |
| Independent native transport suite | **3 passed /1 failed /0 skipped**, one suite; failure is D02-A-R01 |
| Earlier combined independent iteration |27 passed/1 failed/28 cases,51.459s; superseded SQL24 by final29, never counted twice |
| Separate original F01 | **6 expected financial failures /0 skipped**,41.397s; exact baseline failure-message equality |
| Distinct PostgreSQL acceptance coverage | **718 passed, one new blocking failure**,22 suites; plus six separately retained F01 failures |
| `pnpm lint` | PASS API/web, including reviewer suites |
| `pnpm typecheck` | PASS API/web after build and final test changes |
| `pnpm test` | PASS50 units/12 suites;725 DB opt-ins skipped in default execution and exercised separately above |
| `pnpm build` | PASS Nest API and Next web production builds; no deployment |
| Catalog/source-preservation/doc/whitespace checks | Completion evidence below |

Primary commands, from `apps/api`, with explicit local URLs and RUN_DB_TESTS=1; RUN_MIGRATION_TESTS=1 for the matrix:

```powershell
node node_modules/jest/bin/jest.js --runInBand test/integration --testPathIgnorePatterns 'settlement-f01.pending|provider-observation-review|provider-observation-sql-review' --cacheDirectory ../../.tmp/jest-d02-independent --json --outputFile ../../.tmp/d02-independent-pg.json
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/provider-observation-review.spec.ts test/integration/provider-observation-sql-review.spec.ts --cacheDirectory ../../.tmp/jest-d02-review --json --outputFile ../../.tmp/d02-independent-extra.json
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/provider-observation-sql-review.spec.ts --cacheDirectory ../../.tmp/jest-d02-review --json --outputFile ../../.tmp/d02-independent-sql-final.json
# Separate invocation additionally sets RUN_F01_PENDING=1:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-d02-f01 --json --outputFile ../../.tmp/d02-independent-f01.json
```

Root checks: `pnpm.cmd lint`, `pnpm.cmd build`, `pnpm.cmd typecheck`, `pnpm.cmd test`, `node .tmp/validate-docs.cjs`, `git diff --check`. Logs/JSON and read-only catalog evidence use ignored `.tmp/d02-independent-*`. Tests do not need private environment files. The web test script is a notice, not browser coverage.

Initial environment/harness failures are recorded: cmd `pwd` was corrected to `cd`; a quoted pg_ctl invocation failed before startup; sandbox localhost access returned EACCES and a permitted connection preceded readiness. Sandboxed startup did not persist, requiring permitted recovery of the retained cluster. Initial default Jest failed33 suites before executing assertions because cache renames returned EPERM; the permitted run with workspace TEMP/TMP passed. Next build similarly needed a permitted EPERM retry. The reviewer fixture's initial ClientRequest cast failed typecheck; two later reviewer-only lint errors were corrected by removing a redundant assertion and typing the selected SQL row. Final lint/typecheck pass without disabled rules or implementation changes. A read-only catalog pass first encountered an incomplete retained author-iteration database without the final projection table; the corrected query excludes that older shape. The preservation helper initially compared Git LF bytes directly with unchanged Windows CRLF files; baseline byte comparisons plus normalized Git comparisons corrected that check. Two inline shell probes failed quoting and were replaced by direct script/tool checks. None is reported as a financial defect or passing test.

## 14. Confirmed finding D02-A-R01

**P1 — retain retry responses before SDK retry selection. Blocks D02-A acceptance: YES.**

- **Reference:** `ObservedStripeTransport.makeRequest`, [transport line46](../../apps/api/src/payment-provider/observed-stripe-transport.ts), returning a lazy CapturedResponse; `CapturedResponse.toJSON`, line61. Installed stripe22.6.2 `RequestSender.js`, lines454–455, chooses `_shouldRetry` before the JSON handler. The preserved [native regression](../../apps/api/test/integration/provider-observation-review.spec.ts) is named “retains the original HTTP error body even when the SDK retries before JSON handling”.
- **Violated invariant:** approved R2 §§3/4 and independent design review §3 require truthful original response evidence for every SDK transport attempt, including available HTTP error bodies. Two source identities without their available bytes do not satisfy that contract.
- **Reproduction:** accept a prospective refund, configure maxNetworkRetries=1, send native IncomingMessage HTTP503 containing the complete73-byte JSON error, then a valid HTTP200 refund response. Run the four-case native transport suite with RUN_DB_TESTS=1 and disposable MIGRATION_ADMIN_URL. It uses the real installed SDK Node transport/response classes; native HTTPS is intercepted, so no provider endpoint is contacted.
- **Expected:** two immutable sources; first HTTP503/COMPLETE with exact73 bytes, RETURNED_ERROR/retryable transport evidence; second HTTP200/COMPLETE with the actual refund bytes. Stable provider key, mandatory obligations, no journal.
- **Actual committed state:** source_order4, request ID `req_review_1`, HTTP503, `response_body=NULL`, `body_completeness=ABSENT`, normalized UNKNOWN_OUTCOME/OUTCOME_UNCONFIRMED. Source_order5, HTTP200, COMPLETE472 bytes, RETURNED_OBJECT/CONFIRMED_PROVIDER_RESULT. Both sources/obligations commit; only the latter has a projection. Read-only catalog inspection independently re-read these committed rows in `fintech_r1_signed_9329dce046f243dc80b672d6fde69f58`. The provided error body's exact length is73 bytes; it is never consumed by the wrapper. No remote failure is falsely finalized, but genuine transport evidence is irretrievably omitted.
- **Minimal correction:** initiate bounded body capture for **every received response before handing it to SDK retry selection**, using the supported transport boundary. Expose a cached decode/read result to SDK JSON handling and preserve the SDK's retry/error behavior, partial classification, account/key binding and1MiB limit. Ensure intermediate bodies are consumed or safely terminated. Do not repair this by inventing serialized bytes, weakening the contract, or merely disabling configurable SDK retries.
- **Permanent regression:** keep the exact failing native503→200 assertion, alongside complete success/error and partial-body controls; extend correction coverage to retry exhaustion and a retry-header-driven response so every attempt's bytes/completeness/status/request ID/key are checked. The author's weaker retry test should also assert intermediate body fidelity. Rerun the full matrix after correction.

No additional confirmed P0/P1 or blocking P2 defect was established. The representation and operational limits identified elsewhere are not misreported as reproduced money movement or privilege failures. The reviewed implementation is deliberately left intact for the author to correct.

## 15. Remaining capture/R2 and external dependencies

D02 capture results deliberately retain aggregate PaymentIntent facts as CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED/BLOCKING_REVIEW. They create no CAPTURE object projection, lot or journal. Neither requested amount, aggregate PI success nor an existing lot supplies the dedicated pre-lot proof. Authorization/void retain workflow provenance without invented capture effects. Ambiguous shared-PI/multicapture cases remain excluded from trusted financial effects.

After a corrected independently accepted D02 checkpoint, R2-A still needs closed transaction permits/manifests, typed financial application/disposition and bidirectional SQL finality. R2-B owns the separate pre-lot capture/workflow proof and its dedicated review. Refund/dispute/settlement/payout, cause-specific recovery/resume, F05/F06 corrections, active-path F04 evidence and eventual F01 closure remain later work. No dependent implementation starts here.

**NOT RUN:** hosted CI/Node22/PostgreSQL17, real Stripe API/account/multicapture or forwarded webhook verification, RabbitMQ/Redis/BullMQ network execution, actual OS worker termination/database wire loss, production ACL/default grants, credential/account provisioning, D03 historical eligibility, old-worker fence, maintenance/drain, deployment, scope activation or financial application. Earlier hosted results do not verify this diff. The SQL and mock transport tests establish separate boundaries; neither substitutes for authorized external evidence.

## 16. Final verdict and handoff

**REQUEST_CHANGES**

The smallest required correction is to capture all received response bodies independently of whether stripe-node calls toJSON. Preserve the new red native regression and all green SQL/financial assertions; correct only the transport placement and necessary fixture assertions, then rerun independent verification. D02-A is not accepted as safe to commit yet. Do not start capture application, install operational credentials, commit or push under this review.

Acceptance, when earned, establishes trustworthy immutable provider-result observations in the isolated D02-A boundary. It does not establish exactly-once remote execution or authorize new-policy money movement.

Completion checks: documentation validation passed **53 Markdown files /781 relative links and anchors**, CI YAML parsing/structure and extraction of19 existing Mermaid blocks; no diagram parser/rendering was run. `git diff --check` and final-newline/trailing-whitespace checks passed for reviewer deliverables. Final lint, post-build typecheck and default tests passed, including discovery of both reviewer suites. The successful API/web build covers the unchanged application; subsequent edits are reviewer tests/documentation, with the last test edits limited to erased TypeScript annotations.

The preservation helper verified **239 initial files** byte-for-byte, excluding exactly the removable review-index line and the two reviewer-owned test paths. It also checked all nine historical migration contents against HEAD with Windows line endings normalized, the first nine journal entries, unchanged F01 source and exact F01 failure-message equality. HEAD remains the approved baseline, index empty; the final21-file worktree is the original18 plus two reviewer suites and this report. Saved current suite identities separately and restored all38 pre-existing database-marker contents. The disposable cluster stopped successfully, restoring its initial stopped state; databases and immutable history remain retained. No staging, commit, push, financial application or activation occurred.
