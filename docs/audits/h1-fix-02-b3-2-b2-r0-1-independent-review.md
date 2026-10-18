# H1 Fix 02 — B3.2 B.2-R0.1 independent correctness re-review

Status: **completed independent review**, 2026-10-18. Verdict: **APPROVE_DORMANT_R0_CHECKPOINT**.

P1 is corrected in SQL and independently reproduced before/after. Genuine pending-refund Option A remains neutral; contradictory evidence retains a durable blocker. P2's CI configuration is corrected. Migration 0007, its tests and review artifacts are safe to commit together as a **dormant database checkpoint**. A successful subsequent hosted PostgreSQL17 integration job remains required; it was **NOT RUN** here. No runtime activation or R1/R2 readiness is approved.

## 1. Baseline and reviewed inventory

Checkout: `main`, HEAD `cdbad57ccaab9edf83aa5fdf4d18e5c30b4f7514`, matching the local `origin/main` tracking ref. No fetch, commit or push. The initial index was empty; 17 pre-existing modified/untracked files were preserved. Untracked does not mean authored by this review: notably the R1 blocked-preflight record and original R0 review already existed.

Read repository instructions/routing, verification and financial documentation, the [approved decisions](h1-fix-02-b3-2-human-decisions.md), [design](h1-fix-02-b3-2-runtime-cutover-design.md), [design review](h1-fix-02-b3-2-design-review.md), [B.1 implementation](h1-fix-02-b3-2-b1-trusted-evidence-schema.md), [B.1 independent acceptance](h1-fix-02-b3-2-b1-independent-review.md), [R1 blocked preflight](h1-fix-02-b3-2-b2-r1-trusted-receipt.md), [R0 foundation and corrective response](h1-fix-02-b3-2-b2-r0-admission-foundation.md), and [original independent R0 review](h1-fix-02-b3-2-b2-r0-independent-review.md). Approved B.1 is present at HEAD. Its migration, immutable evidence/proof contract and original review remain intact.

| Reviewed files | Scope |
| --- | --- |
| `apps/api/drizzle/0007_receipt_admission_foundation.sql` | All 444 lines; four relations, revision guards, classification, deferred checks, publication, lifecycle, reader and capability grants |
| `apps/api/drizzle/meta/_journal.json`, `apps/api/src/database/schema.ts` | Eighth migration and four storage declarations; unchanged by R0.1 relative to original R0 |
| `apps/api/test/integration/receipt-admission.spec.ts` | 50 admission/lifecycle/role/concurrency cases; conservative customer-contradiction expectation corrected |
| `apps/api/test/integration/receipt-admission-review-regressions.spec.ts` | Original three fixture inputs and 28 companion cases; changed oracle inspected explicitly below |
| `apps/api/test/integration/receipt-admission-migration.spec.ts` | Six fresh/upgrade/legacy/rollback/closed-gate/privilege cases |
| Capture migration, B.1 evidence migration, settlement integration and integrated verification specs | Migration count/title updates only; original financial assertions preserved |
| `.github/workflows/ci.yml` | Disposable administrative URL and migration opt-in; Node job unchanged |
| `docs/README.md`, `docs/database-design.md`, `docs/verification.md`, R0 foundation, original independent review, R1 preflight | Documentation, preserved historical findings and appended author response |

The corrective delta is eight files: 0007, admission and classification specs, CI, Database design, Verification, R0 foundation and appended original-review response. SHA-256 checks established preservation of all 17 initial files before this review's navigation addition. SQL0000–0006, the seven earlier journal entries, approved design/decisions, both B.1 records and F01 test match HEAD (Git newline normalization only). The original R0 review is an exact byte prefix of the current file; its adverse verdict/findings have not been rewritten. The R1 preflight is byte-identical to the original R0 inventory.

This review adds only this report and one documentation-index link. Verification scripts, exact original source copies, results and disposable histories remain ignored under `.tmp/r01-review-*`. No service, controller, module, provider adapter, dispatcher, job, legacy settlement/payout writer, dependency or financial routing changed.

## 2. Original P1 reproduction

Ran the **unchanged original three-case reviewer file**, using an isolated copy of the API source/test support and the exact original 0007 bytes. Its SHA-256 was `e054f6c1639b7e6d6d85dc409b3e436ac107c09042e6abf7282e151a4ba37616`; current corrected 0007 is `f10efd82e40cc843eaf02fe2818e7e11ce442f54c020fbe6060c14e2bb00ec60`. The original bytes were recovered from a retained migration rollback fixture by removing its appended deliberate-failure statement, then requiring the exact original hash. Reviewed workspace SQL was never replaced. Installed dependencies were linked into the ignored reproduction tree; original test assertions were not edited.

Minimal fixture: `signedEvidence(f,{status:'pending'})`, original inbox snapshot overridden to `type: refund.succeeded` or `refund.failed`, with the same merchant/payment/refund/object, amount5000 and USD. A restricted publisher receives only EXECUTE on `publish_admitted_receipt`; a separate restricted reader receives only inspection EXECUTE. Both fixtures publish, commit, and inspect through independent transactions.

| Committed result, each of the two original negative fixtures | Original R0 | Corrected R0.1 |
| --- | --- | --- |
| Receipt / enrollment / obligation | 1 / 1 / 1 | 1 / 1 / 1 |
| Disposition | AWAITING_CONFIRMATION | BLOCKING_REVIEW |
| Linked immutable contradiction review | Absent | Same-inbox CONTRADICTORY, classifier `receipt-admission/v1` |
| Merchant / payment / proof / resolution authority | NULL | NULL |
| Scope reader | CLEAR | Rejected as blocked |
| Financial proof / refund journal | 0 / 0 | 0 / 0 |
| Original bytes and normalized claims | Retained | Retained |

Original tests independently returned **2 failed /1 passed /0 skipped**,16.250s, exit1. The genuine pending control passed. Database `fintech_r0_review_regressions_740c8c4122414d4186c04720643d35a0` retains that bad committed state. This is new execution, distinct from either author's corrective logs or the earlier independent review.

## 3. Corrected classification and precedence

[0007](../../apps/api/drizzle/0007_receipt_admission_foundation.sql), `receipt_admission_facts` (line95), derives identity and classification from stored immutable receipt/inbox data. No publisher-supplied classification/status argument exists. Receipt account, original event UUID/provider event ID, signature, headers, raw event type and normalized snapshot must agree; irreconcilable receipt identity still rejects publication atomically.

For pending/requires_action refund objects, version1's neutral normalization must be `provider.unsupported` with JSON-null data. A terminal normalized label or unexpected financial data sets a contradiction reason. Confirmed refund/dispute classifications call unchanged B.1 `financial_receipt_facts`, checking operation, exact amount/currency/object, explicit ownership and dispute outcome. Present normalized `providerStatus` must match the signed object. A `refund.failed` event whose object says pending/requires_action/succeeded is contradictory. Expected validation errors become retained review evidence; permission, lock, deadlock and other database errors are not broadly caught as harmless pending.

`enroll_receipt_admission` (line200) evaluates those facts **before choosing account lock mode or proof binding**. A contradiction selects account UPDATE even with a caller-supplied proof revision, skips guessed scoped ownership, advances intake revision, appends the fixed-key CONTRADICTORY review and inserts BLOCKING_REVIEW. That CASE has priority over `refund.pending`. Thus the pending operation label cannot select the neutral disposition after contradiction detection.

`check_receipt_admission_obligation` (line168) repeats authoritative classification at deferred validation and requires BLOCKING_REVIEW plus retained matching classifier evidence for contradictions. Any current review reference must belong to this same inbox. A privileged fixture deliberately inserted an otherwise structurally valid nonblocking obligation and reached this deferred check: commit was refused and no enrollment/obligation survived. Ordinary roles cannot issue those direct inserts at all.

## 4. Regression integrity

Compared the saved original file with the current classification suite. Both original negative fixture constructions and names, their signed pending input, normalized terminal assertions and committed-state queries remain. The genuine-pending control's original assertions remain unchanged.

The original negative oracle required **rejection, zero receipt/enrollment, clear reader**. The current request expressly requires **retained receipt, BLOCKING_REVIEW, blocked reader**. R0.1 openly changes that rejection oracle to the requested conservative retention contract; it does not accept the old nonblocking result. Added assertions require the immutable same-inbox review, NULL guessed ownership/proof/resolution, account revision1, blocked reader and no completion row. Original test bytes, original adverse results and the historical review remain available; the before/after distinction is explicit.

All **31** classification cases passed in the independent matrix. Coverage includes both pending terminal labels, requires_action, matching terminal outcomes, owner/payment/refund/object/amount/currency/providerStatus contradictions, failure-event contradictions, unexpected unsupported data, replay identity, RETRY/DEAD/expired lease, direct clearance/revision refusal, absent-proof resolution/binding, initial and replay rollback, deferred nonblocking refusal, same-account cross-scope barriers and genuinely nonfinancial customer events. Setup uses a database owner for trusted fixtures; tested entry points use NOLOGIN/NOINHERIT/NOSUPERUSER roles. Fixtures do not disable the constraints under review.

## 5. Pending, confirmed, contradictory and unknown behavior

| Authoritative evidence | Durable admission behavior |
| --- | --- |
| Genuine pending/requires_action with neutral normalization | AWAITING_CONFIRMATION, no guessed owner, no new refund journal/posted hold; clear only if no independent blocker exists |
| Matching confirmed outcome, ownership not sealed | AWAITING_CORRELATION and account blocker |
| Matching sealed owner, unapplied outcome | AWAITING_APPLICATION and merchant/currency blocker |
| Contradictory financial claims | Immutable original retained; CONTRADICTORY review plus BLOCKING_REVIEW at account boundary; no pending exemption |
| Unclassified/unsupported financial event | Conservative unresolved account obligation; unsupported does not imply irrelevant |
| Genuine customer lifecycle with neutral normalization | Nonfinancial immutable enrollment, no obligation; financial labeling instead creates review |

Additional independent probes published genuine pending receipts after both an existing account blocker and an existing scoped blocker. Each preserved the prior receipt/proof/obligation unchanged, kept the reader blocked, and created no refund journal. H03 Option A is preserved without clearing other evidence. Immutable UPDATE protections prevent turning contradictory stored facts into harmless pending.

## 6. Mandatory obligation, lifecycle and revisions

The original SQL cardinality boundary remains: a bare legacy B.1 receipt is not an R0 admission. Each **financially relevant enrollment** must have exactly one durable obligation before commit. The admission primary key/FKs bind the original inbox, receipt, provider/account and operation; contract version is1. Initially deferred `receipt_requires_obligation` and `receipt_obligation_consistent` reclassify and validate required cardinality, review and any owned proof. Immutable admissions and guarded no-delete/no-truncate obligations prevent removing that relationship. The atomic publisher cannot omit enrollment or a blocker. Failure leaves no partial receipt/admission/review/revision. Replay preserves identity and revision.

Independent negative probes rejected missing obligations at commit and explicit early constraint validation, false irrelevant classification, partial owner tuples, account mismatch and version0. They inspected committed state afterward. The permanent suite additionally checks classification-specific deferred rejection. RETRY, DEAD, unrelated inbox status and lease age cannot clear obligations. No timeout path exists. Unknown binding atomically increments intake and destination scope revisions and transfers to AWAITING_APPLICATION under account exclusion; original receipt and immutable reviews remain traceable. Blocking review has no ordinary recovery bypass.

`resolve_receipt_obligation` (line335) does not post money. APPLICATION requires matching sealed refund-success proof, exact refund owner/object/amount/currency/SUCCEEDED state, complete confirmed frozen allocations on this inbox and journal, the same lot set, the matching POSTED REFUND business journal and immutable audit. An unrelated balanced journal cannot authorize it. NO_EFFECT requires signed failed/canceled evidence, matching FAILED refund, complete released allocations with confirmed-provider-failure reason on this inbox, matching immutable failure audit and absence of that refund's journal. An ordinary caller's assertion or arbitrary note is insufficient. Duplicate resolution preserves the immutable completion row; conflict/rollback preserves original state. Later review can reblock without deleting immutable completion history.

Resolution recognizes valid facts visible in its transaction; SQL does not require they committed in an earlier transaction. Positive fixtures apply the actual dormant service and commit before recognition. Full bidirectional workflow/claim/effect/audit/inbox enforcement, other operation/duplicate no-effect cases and reviewed contradiction recovery remain R2 work.

Scope/account revisions are stored **evidence revisions, not balances or payment permits**. Guarded updates advance by exactly one and ordinary roles cannot set/rewind them. Concurrent admissions do not lose increments; failed transactions commit none. Inspection locks account and scope and checks supplied revisions; provider-account changes invalidate saved intake clearance. H02's policy/admission epochs, certificates and activation authority are still future work; this partial dormant storage does not implement all of H02. H03's tested local ordering and H04's account barrier agree with the approved policy, while legacy operations remain outside the staged reader. Operator deadline/escalation and runtime enforcement remain unimplemented.

## 7. Privileges and controlled concurrency

Catalog checks confirmed 10 pinned routines, seven SECURITY DEFINER routines, `search_path=pg_catalog, pg_temp`, qualified persistent references and no PUBLIC EXECUTE. The admission owner is a unique NONLOGIN/NOINHERIT/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS role, without memberships or remaining schema CREATE. R0.1 adds only financial-review INSERT; immutable review UPDATE/DELETE/TRUNCATE remain denied, as do ledger header/entry/account writes. No existing runtime login receives grants. Restricted worker probes denied seven direct receipt/admission/resolution/proof/blocker mutations; no-effect assertion without evidence failed. Table owners/superusers and deliberate capability membership changes remain trusted administration, not the ordinary-role threat model.

The actual installed lock prefix is **private inbox → provider account → advisory merchant/currency scope → scope row → financial references**. The request's account-first shorthand must not be read as authorization to reverse B.1's established private-inbox-first prefix. The isolated reader has no private inbox and begins at account SHARE. New atomic publication acquires account UPDATE **before** B.1's trigger takes its nested SHARE; it does not first take SHARE and later upgrade. Known enrollment uses account SHARE; unknown/contradictory publication and transfer use UPDATE. Scope revision changes occur under the canonical advisory lock and scope NO KEY UPDATE; obligations share their private inbox serialization. Resolution then locks payment NO KEY UPDATE, refund, ordered lots and allocations. The separate B.1 sealer retains its inbox/account UPDATE/scope/financial-reference prefix and is not composed after reader/scope acquisition.

The correction adds immutable review INSERT/FK key-share checks on the already-owned inbox/review; it adds no later financial-inbox acquisition. Existing admission/proof/scope/resolution FK checks remain part of the graph. Scope NO KEY UPDATE avoids unnecessary conflict with FK KEY SHARE, but arbitrary outside transaction prefixes remain unsupported. PostgreSQL's documented [row-lock conflicts and transaction lock lifetime](https://www.postgresql.org/docs/18/explicit-locking.html) support this analysis; [definer-function guidance](https://www.postgresql.org/docs/18/sql-createfunction.html) supports the path/EXECUTE review.

The independent probe set passed **25 checks**, including **15 schedules with observed `pg_blocking_pids` waits**, explicit release gates, separate backend IDs and assertions after transaction completion. There are no retry loops masking deadlocks; expected refusal paths also exclude deadlock/uniqueness errors.

| Schedules independently executed | Committed outcome |
| --- | --- |
| Two atomic publishers sharing an account, both event orders | Both obligations retained; intake revision2; nested B.1 SHARE does not require an upgrade |
| Two known receipts sharing a scope | Both obligations retained; scope revision2 |
| Unknown transfer vs known enrollment, both orders | Both scoped obligations retained; scope revision2, no transfer gap |
| B.1 sealing vs R0 enrollment, both orders | One immutable proof and correctly bound obligation; revision1 |
| Different merchants sharing an account | Second known scope committed before first scope transaction released |
| Contradiction vs reader, receipt-first | Reader waits, then rejects committed blocker |
| Contradiction vs reader, reader-first | Publication waits; later reader blocked and saved revision stale |
| Genuine pending vs reader, both orders | Ordered publication/read, neutral disposition and no accidental blocker |
| Duplicate contradictory publication | One review/obligation identity, one intake increment |
| Contradiction/account barrier vs known scoped admission, both orders | Both obligations retained, scope increment preserved, account barrier still blocks |
| Contradictory publication vs attempted no-effect resolution | Resolver waits, then refuses; blocker retained, no resolution |

The separately rerun 50-case admission suite additionally covers both normal reader/receipt orders, waiting transfer reader, resolution revision vs admission and conflicting resolutions. These schedules establish tested SQL ordering only, not universal deadlock freedom or live settlement/payout correctness.

## 8. P2 CI configuration and setup/cleanup

[CI](../../.github/workflows/ci.yml) now supplies DATABASE_URL for `fintech_ci`, MIGRATION_ADMIN_URL for `postgres`, RUN_DB_TESTS=1 and RUN_MIGRATION_TESTS=1. Both URLs point only to the disposable localhost PostgreSQL17 service and use that service's checked-in fixture identity. Node22/24 job structure is equal to HEAD. The integration command discovers all integration specs; no new missing-variable skip or permissive URL fallback was introduced.

B.1 and R0 migration suites require **both** opt-ins. Independent execution discovered and passed B.1's six, R0's six and capture foundation's five migration cases with zero skips, including fresh installation, populated upgrades, late rollback and DDL wait coverage. Restricted-role cases still exercise their separate SQL roles. The CI image's configured PostgreSQL user supplies administrative setup; local equivalent create/drop capability was executed explicitly.

A unique local database was created, all eight migrations installed, and zero journals/receipts/scopes asserted before dropping **only that newly created empty database** and its two unique non-login roles. Their absence was checked afterward. Existing immutable financial/reproduction histories were retained. Migration tests close their clients and deliberately retain local databases; CI service-container disposal is their job-level database/role cleanup boundary. Migration rollback independently leaves no new admission owner/tables/column and preserves pre-existing financial fingerprints.

P2 configuration is fixed, but **hosted Actions/PostgreSQL17 execution is NOT RUN**. Require a successful post-commit hosted integration job, including discovered migration cases without unexpected skips, as a subsequent gate before proceeding with R1 or runtime work. This review does not push merely to obtain that result.

## 9. Exact independent execution results

Environment: Windows, Node24.19.0, pnpm10.26.0, PostgreSQL18.6, installed offline dependencies, isolated `127.0.0.1:55432` cluster. No private environment file or live provider/broker/Redis boundary was used. Main matrix database: `fintech_b2r01_1792315569067`; each evidence/admission/classification/migration suite creates its own disposable databases as designed.

| Independently executed suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Receipt classification regressions | 31 | 0 | 0 |
| Receipt admission | 50 | 0 | 0 |
| Receipt migration | 6 | 0 | 0 |
| B.1 trusted evidence | 64 | 0 | 0 |
| B.1 evidence migration | 6 | 0 | 0 |
| F02 posted ledger immutability | 17 | 0 | 0 |
| Capture integration | 27 | 0 | 0 |
| Refund integration | 63 | 0 | 0 |
| Dispute integration | 70 | 0 | 0 |
| Settlement integration | 73 | 0 | 0 |
| B3.1 integrated verification | 44 | 0 | 0 |
| Capture allocation foundation | 30 | 0 | 0 |
| Capture migration | 5 | 0 | 0 |
| Financial concurrency | 5 | 0 | 0 |
| **Complete matrix: 14 suites,68.101s** | **491** | **0** | **0** |
| Original R0 reviewer file against original SQL,16.250s | 1 | 2 expected | 0 |
| Original legacy F01,7.778s | 0 | 6 expected | 0 |

Compared all six F01 case names, failure statuses and financial assertion differences with the original independent results; they match. These are still original legacy defects, not waived new failures. The matrix is independently executed evidence, not inherited author logs.

Root `pnpm lint`, `pnpm build`, `pnpm typecheck` and `pnpm test` exited0. Default tests passed50 units across12 suites, with497 opt-in database cases skipped; database acceptance comes from the separate491-case run and six F01 reproductions. Build covered Nest and Next; final typecheck followed build. The independent probe script passed25 checks/15 controlled wait schedules. CI configuration/empty cleanup and catalog/preservation scripts passed.

Exact commands (PowerShell; paths below relative to the stated working directory):

```powershell
# Repository root: prepare hash-checked original copies, preserving reviewed files.
node .tmp/r01-review-prepare.cjs
# Preparation's local dependency junction required an elevated retry after EPERM.
& 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' start -D '.tmp/verification-pg18' -l '.tmp/r01-review-postgres.log' -o '-p 55432 -h 127.0.0.1' -w

# .tmp/r01-review-original/apps/api: unchanged original reviewer tests/old SQL.
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
$env:MIGRATION_ADMIN_URL='postgres://fintech@127.0.0.1:55432/postgres'
$env:DATABASE_URL=$env:MIGRATION_ADMIN_URL
$env:TEMP=(Resolve-Path '../../../../.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
node node_modules/jest/bin/jest.js --runInBand --no-cache --runTestsByPath test/integration/receipt-admission-review-regressions.spec.ts --json --outputFile='../../../../.tmp/r01-review-before.json'

# Root: create a fresh eight-migration matrix database with existing local setup helper.
node .tmp/b2r01-setup.cjs
# Saved that new identity in .tmp/r01-review-db.txt; restored the author's marker.

# apps/api: current corrected SQL and all required integration suites.
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
$env:MIGRATION_ADMIN_URL='postgres://fintech@127.0.0.1:55432/postgres'
$env:DATABASE_URL='postgres://fintech@127.0.0.1:55432/'+(Get-Content '../../.tmp/r01-review-db.txt').Trim()
$env:TEMP=(Resolve-Path '../../.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
node node_modules/jest/bin/jest.js --runInBand test/integration --testPathIgnorePatterns settlement-f01.pending --json --outputFile='../../.tmp/r01-review-pg-accepted.json'
$env:RUN_F01_PENDING='1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --json --outputFile='../../.tmp/r01-review-f01.json'

# Root: no financial application or external services in these probes.
node apps/api/node_modules/tsx/dist/cli.mjs --tsconfig apps/api/tsconfig.json .tmp/r01-review-extra.ts
node .tmp/r01-review-ci-contract.cjs
node .tmp/r01-review-catalog.cjs
node .tmp/r01-review-results.cjs

# Root static checks, with opt-in database tests disabled for default unit run.
$env:COREPACK_HOME='C:/Users/Daniel/AppData/Local/node/corepack'
$env:COREPACK_ENABLE_NETWORK='0'
$env:TEMP=(Resolve-Path '.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
$env:RUN_DB_TESTS='0'
$env:RUN_MIGRATION_TESTS='0'
$env:NEXT_TELEMETRY_DISABLED='1'
pnpm.cmd lint
pnpm.cmd test
pnpm.cmd build
pnpm.cmd typecheck
node .tmp/validate-docs.cjs
git -c safe.directory='C:/Work/Learning Projects/learn-fintech' diff --check
```

Commands' output is retained in matching `.tmp/r01-review-*.log`/JSON. Harness errors are excluded from acceptance: the first original-test attempt used the default server port instead of55432 and produced three connection/setup failures; after correction it produced the required2/1 result. One full-matrix attempt omitted DATABASE_URL because of a relative marker-path error (329 setup failures/162 passes); an overlapping redirection retry did not start. The explicit-URL final matrix above passed491 with zero skips. Initial source-copy preparation failed to find exact bytes until the rollback suffix was removed/hash-checked, then needed dependency-junction permission. A redundant catalog repeat was cancelled while awaiting tool completion; the earlier completed catalog checks and final probe assertions supply the cited evidence. None of those harness attempts is presented as a schema defect or a passing check.

## 10. Historical and financial compatibility

Forward migration only: 0000–0006 are unchanged; journal append is index7/tag0007/timestamp1792307672232. Fresh repeated installation and populated0006 upgrade passed. Upgrade fingerprints cover original receipts/proofs/reviews, ledger headers/entries, capture lots, refunds/allocations, inboxes, exceptions and selected existing functions. No historical receipts are automatically enrolled or promoted, no provider trust is backfilled, and no financial repair occurs. B.1 correlation sealing and ownership validation remain authoritative.

Migration0007 explicitly takes ACCESS EXCLUSIVE on capture scopes, adds/validates constraints and creates triggers with installation locks on existing relations. It requires transactional installation, sufficient migration-owner role/DDL privileges and the reviewed maintenance/drain window, with10s lock timeout. The populated test is not a large-history duration benchmark; **zero-downtime compatibility is not claimed**.

Catalog checks on six retained original/current databases confirmed eight migrations/exact applicable0007 hash, zero ACTIVE scopes, accounts only UNINSTALLED, closed version1 financial proof references, pinned functions and four Drizzle storage models matching actual columns/nullability. A final additional probe database separately asserted zero ACTIVE/enabled accounts. Source CHECKs still exclude ACTIVE and version1 financial use; migration tests attempt and reject opening them. Legacy writer behavior, F02 immutability and allocation constraints remain tested. No runtime financial route calls this admission contract.

## 11. Findings and unverified boundaries

**No new acceptance-blocking defect found.** Original P1 (wrong nonblocking classification) is corrected by retained contradiction precedence plus deferred enforcement; original P2 is corrected in CI configuration and locally verified setup/discovery. The original adverse review remains historical evidence, not retroactively approved prose.

Unverified: hosted GitHub Actions/PostgreSQL17, signed HTTP delivery, real SDK/account-context provenance, actual Stripe/test-account APIs, RabbitMQ/Redis integration, production/shared database installation, large-history migration timings, mixed-version credential/session fencing, activation/reconciliation certificates, all-writer deadlock freedom, live settlement/payout admission and receipt-to-financial-application runtime. No F01/F04/F05/F06 closure, financial routing safety or production-readiness claim follows from these SQL tests.

## 12. Remaining R1/R2 dependencies

R1 must establish trusted HTTP ingress: exact raw-byte SDK signature verification, configured provider/account context, faithful versioned normalization, accepted event identity and duplicate handling, atomic original inbox plus protected publication, restricted credentials/EXECUTE-only admission authority and explicit contradictory-delivery observability. SQL validates a stored attestation's internal consistency; it does not run Stripe SDK verification or prove an HTTP request existed. Isolated fixture publisher EXECUTE is not deployed HTTP provenance. B.1 trusted command-result observations/object ownership must be produced by their genuine adapters; receipt enrollment cannot invent them.

R2 must supply policy/admission epochs and guarded permits, compatible claim/disposition fencing, all financial writers' shared lock/revision floor, full effect/workflow/audit/inbox linkage, verified operation-specific application/no-effect/duplicate recognition, exception recovery and separate guarded resume. Account barrier triage/deadline/escalation and reviewed history/activation eligibility remain operational work. Old-worker database credential/session fencing and signed HTTP/broker/hosted/mixed-version evidence require their separately authorized stages. Keep scopes dormant and financial proof-version gates closed until those reviews pass.

## 13. Acceptance and handoff

**APPROVE_DORMANT_R0_CHECKPOINT.** P1 is independently corrected; genuine pending Option A remains unchanged. Mandatory obligations, immutable evidence, account/scoped blockers, matching financial resolution, monotonic revisions and ordinary-role protections remain enforced within the tested SQL contract. No admission bypass was found within that contract. P2 configuration is corrected; successful hosted PostgreSQL17 CI remains a subsequent requirement.

Safe to commit migration0007, its schema/journal/tests/CI and preserved/new review artifacts together as a dormant checkpoint. Zero ACTIVE scopes and no changed runtime financial routing were established. R1 publisher and R2 financial application remain unimplemented. This review did not commit, push, activate scopes or implement either stage.

Recommended conventional commit: `feat(accounting): add dormant receipt admission foundation`.

Completion: `node .tmp/validate-docs.cjs` passed44 Markdown files/553 relative links and anchors, with CI YAML parsing/structure checks. It extracted19 existing Mermaid blocks; diagram parsing/rendering was not run. `git diff --check` and direct final-newline/trailing-whitespace checks passed for all18 intended files. `node .tmp/r01-review-finish.cjs` verified all17 initial files preserved apart from the single removable index addition, exact original-review prefix, unchanged HEAD/empty index and restored earlier database-marker files. `pg_ctl.exe stop -D .tmp/verification-pg18 -m fast -w` exited0, restoring the initial stopped cluster and retaining financial histories. No commit or push occurred.
