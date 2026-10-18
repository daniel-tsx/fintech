# H1 Fix 02 — B3.2 B.2-R0 receipt admission foundation

Status: **READY_FOR_INDEPENDENT_REVIEW**, as a dormant database checkpoint. No R1/R2 runtime integration, activation, commit or push.

## 1. Starting state and scope

Started on `main` at `cdbad57ccaab9edf83aa5fdf4d18e5c30b4f7514`, with an empty index and exactly the known R1 preflight record/index changes. B.1 and its independent acceptance were committed. A read-only catalog check of the retained disposable B.1 database confirmed seven migrations, 0006 timestamp1792281600000, its SQL sealer and zero ACTIVE scopes.

Preserved the [R1 blocked-preflight record](h1-fix-02-b3-2-b2-r1-trusted-receipt.md). Its stop was correct: immutable receipts/proofs/reviews do not provide a current obligation lifecycle. This checkpoint adds that database foundation; it does not turn the old preflight into a completed receipt adapter. The [human decisions](h1-fix-02-b3-2-human-decisions.md) and [B.1 acceptance](h1-fix-02-b3-2-b1-independent-review.md) remain unchanged.

## 2. Forward migration and changed inventory

The actual journal ended at index6/0006. Added [0007_receipt_admission_foundation.sql](../../apps/api/drizzle/0007_receipt_admission_foundation.sql), index7, timestamp1792307672232. Migrations0000–0006 are unchanged. No schema generation/push, monetary rewrite, history promotion or automatic receipt enrollment occurs.

| Files | Change |
| --- | --- |
| Migration0007 and `drizzle/meta/_journal.json` | Four relations, scope revision, guarded APIs, triggers, constraints, indexes and restricted owner |
| `src/database/schema.ts` | Additive storage declarations; checked-in SQL owns executable transitions, deferred checks and privileges |
| `test/integration/receipt-admission.spec.ts` | Ordinary-role SQL admission/resolution, rollback and controlled concurrency regressions |
| `test/integration/receipt-admission-migration.spec.ts` | Fresh/populated upgrade, compatibility, rollback and capability catalog checks |
| Existing capture migration, integrated verification, settlement integration and B.1 migration specs | Chain count/title updates to eight migrations only; original financial assertions retained |
| This record, documentation index, Database design and Verification | Implemented database behavior, staging limits and executed evidence |

Paths in this table are relative to `apps/api` unless a documentation file. Disposable databases, non-login test roles, probes, JSON reports and caches stay under the local verification environment/ignored `.tmp`; none are deliverables.

The ten new functions are `protect_receipt_admission_authority`, `receipt_admission_facts`, `guard_receipt_obligation`, `check_receipt_admission_obligation`, `enroll_receipt_admission`, `publish_admitted_receipt`, `bind_receipt_obligation`, `review_receipt_obligation`, `resolve_receipt_obligation` and `inspect_receipt_admission`. Seven are restricted SECURITY DEFINER entry/constraint routines; three are invoker-based guards/classification. B.1's functions remain unchanged.

## 3. Durable enrollment and obligation

`receipt_admissions` is immutable enrollment in receipt contract1, keyed by the original inbox UUID and FK-linked to B.1's exact verified receipt. Its provider/account, operation and relevance must match the stored original classification. There is no caller-selectable historical version or version0 enrollment fallback.

`receipt_admission_obligations` is the mutable lifecycle row, also unique by inbox. It retains provider/account/operation, optional canonical payment/merchant/currency/proof revision, obligation revision, observed scope/intake revisions, timestamps and immutable review/resolution references. Known ownership requires the exact owned B.1 proof tuple; unknown ownership has NULL scope, never a guessed merchant. Once known, identity cannot be reassigned. Lifecycle updates do not modify original signed bytes, normalized payloads or sealed proofs.

`receipt_obligation_resolutions` stores immutable completion identity, proof/owner, actual journal where applicable, immutable financial audit, exact allocation-reference snapshot and database principal. A subsequent contradictory review can reblock the same obligation while retaining the first resolution as immutable history. It cannot silently replace that completed fact.

## 4. Mandatory atomic receipt contract

`publish_admitted_receipt(inbox, account, raw_bytes, verifier_version)` is a restricted SQL publication capability for the future trusted SDK adapter. It preserves existing inbox identity/signature/headers/normalization and exact raw bytes. PostgreSQL validates lineage, not Stripe HMAC. **No actual trusted HTTP adapter was implemented or verified here.**

The publisher locks its private inbox and chooses exclusive account intake before inserting a first, still-unowned receipt. This precedes B.1's receipt-trigger SHARE lock, avoiding a SHARE upgrade. It calls `enroll_receipt_admission` in the same transaction. Identical duplicates return the original enrollment; contradictory bytes/account/verifier facts fail without overwriting originals. The future R1 adapter must preserve those conflicts in a separate safe review transaction after rollback.

A deferred constraint trigger checks each enrollment against original receipt classification and requires exactly one obligation for a relevant event, none for an explicitly irrelevant event. A second deferred trigger rechecks obligation/proof ownership after mutations. False unrelated classification is rejected too. Publication failure rolls back receipt, enrollment, obligation and revision writes together; the future R1 adapter must insert a new original inbox in that same caller transaction before this call.

A plain B.1 receipt is **not** an R1-admitted receipt. Existing B.1/legacy writers remain legal and are not silently enrolled. R1 remains closed operationally: no endpoint/module calls these routines, PUBLIC execution is revoked, and no existing runtime login receives grants. The coordinated R1 gate is the actual SDK adapter plus its atomic inbox/publication transaction and narrowly granted publication capability, with signed HTTP tests. Giving that adapter raw-table INSERT rights would invalidate this guarantee.

## 5. Classification and pending-refund Option A

Confirmed refund/dispute operations use original event/object/status classification and B.1's shared checked proof reader for known ownership. Genuine `pending`/`requires_action` refund observations use **AWAITING_CONFIRMATION**: durable evidence, no journal/hold and no spending refusal merely because confirmation is pending. A later genuine event is separate immutable evidence; this pending event is not relabeled successful or timed out into clearance.

Only the explicit customer created/updated/deleted allowlist is irrelevant, and only with matching unsupported/NULL normalized data. Other unsupported/unclassified observations remain account-level pending review evidence. No unsupported label supplies a confirmed financial proof. Capture and other unclassified observations remain conservatively unowned in this R0 contract; it does not extend B.1's refund/dispute proof allowlist. R1 must review its complete event matrix rather than silently broadening this foundation or treating unclassified events as harmless.

## 6. Known/unknown authority and revisions

Known enrollment takes private inbox → account SHARE → canonical merchant/currency advisory → scope **FOR NO KEY UPDATE** → fresh proof revalidation. It advances `capture_accounting_scopes.evidence_revision` and writes the scoped obligation atomically. The advisory key is the existing canonical UUID/currency `hashtextextended(...,0)`. NO KEY UPDATE keeps competing scope writers serialized while permitting FK KEY SHARE.

Unknown enrollment takes private inbox → account UPDATE and records the account obligation without a merchant. `receipt_intake_authority` adds a guarded provider/account revision, needed to invalidate a prior account-clearance snapshot across unknown barrier changes. Unknown blockers affect that configured provider/account, not every provider. Pending Option A observations are retained but excluded from spending-blocker predicates.

`bind_receipt_obligation` takes private inbox → account UPDATE → destination advisory/scope, validates the fixed B.1 proof and atomically replaces unknown blocking with scoped awaiting-application. Both intake and scope revisions advance in that transaction. There is no interval in which neither blocker exists. Proof alone does not clear an obligation.

Revision INSERT must start at0; revision mutation requires the non-login guarded writer and exactly old+1. Scope/account identity, DELETE and TRUNCATE cannot reset the authority. Ordinary legacy scope UPDATE grants do not permit assigning or rewinding a revision. R0 advances revisions for its enrollment/mapping/review/resolution changes. **Existing legacy financial writers do not yet participate:** these receipt revisions are not complete financial reconciliation certificates. R2 must coordinate all relevant writers before that use.

`inspect_receipt_admission` locks account SHARE → advisory/scope NKU, reads fresh revisions and current unknown/scoped blockers plus OPEN accounting exceptions. Caller-supplied expected scope/intake revisions reject stale clearance. This is an isolated receipt-authority reader, **not a policy/epoch/claim permit, tenant authorization, settlement or payout implementation**. Runtime account/scope configuration and full policy admission remain R1/R2 gates. It issues no activation certificate.

## 7. Lifecycle and resolution enforcement

| State / transition | Authority |
| --- | --- |
| AWAITING_CONFIRMATION | Genuine pending refund; retained and nonblocking under Option A |
| AWAITING_CORRELATION | Relevant owned-account event without verified scope; broad blocker |
| AWAITING_CORRELATION → AWAITING_APPLICATION | Guarded immutable proof binding; atomic account-to-scope transfer |
| AWAITING_APPLICATION | Known scope, truthful proof, financial fact not yet acknowledged |
| Any state → BLOCKING_REVIEW | Matching immutable B.1 review reference; preserves proof and original completion history |
| AWAITING_APPLICATION → CLEARED_APPLICATION | Actual matching committed refund journal, full finalized allocation group, accepted owner/amount/provider object and immutable audit |
| AWAITING_APPLICATION → CLEARED_NO_EFFECT | Signed failed/canceled refund proof, matching FAILED refund, complete released reservations, immutable failure audit and absence of its financial journal |

`resolve_receipt_obligation` performs no ledger/workflow mutation. The first supported completion recognizers are the two refund cases above. It acknowledges an already established financial fact under its original contract; it neither upgrades version0 evidence nor authorizes a new version0 financial effect. A proof, arbitrary journal, missing allocation/audit, note or journal absence alone cannot clear anything. Dispute/capture application linkage and other no-effect cases remain blocked until the separately reviewed R2 contract; they do not receive a permissive fallback.

Identical resolution returns the saved immutable row without another revision increment. Conflicting resolution aborts and preserves the first evidence. A failed transaction leaves the blocker and no completion record. BLOCKING_REVIEW is deliberately sticky: separate reviewed recovery is required, including after a previously cleared fact is reblocked. Resolution does not clear accounting exceptions or resume/activate a scope. Inbox RETRY/DEAD/PROCESSED/IGNORED cannot alter an obligation.

## 8. Lock and privilege boundaries

All lifecycle entry points require READ COMMITTED and own their documented prefix. Resolution takes private inbox → account SHARE → advisory/scope NKU → payment NKU → refund → ordered lots/allocations, then records completion. No other operation's inbox is acquired after scope. There is no provider/broker/network operation in these routines.

B.1 sealer code is unchanged. It owns private inbox → account UPDATE → advisory/scope → financial rows. Call it in a separate correlation transaction before that prefix, or, for a future R1 atomic first receipt, retain the already-exclusive unknown intake before calling it; do not invoke it after taking shared intake/scope locks. Mapping then follows the guarded transfer contract. R0 does not prove arbitrary partial adoption with legacy refund/mirror/authorization lock orders safe. Actual writer coordination remains R2; no universal deadlock freedom is claimed.

Migration creates a separate per-database `fintech_admission_<md5(database)>` NOLOGIN/NOINHERIT, non-superuser/non-CREATEROLE/non-CREATEDB/non-BYPASSRLS capability owner. It can read required evidence, publish B.1 receipts, manage only admission state and increment revision columns. It has no ledger writes or lasting schema CREATE. New functions pin `pg_catalog, pg_temp`, qualify persistent references and revoke PUBLIC execution. New table PUBLIC rights are revoked. No real login/credential/membership changes were made. Ordinary-role SQL tests use explicit fixture grants; they are not production credential isolation evidence.

## 9. Migration and historical compatibility

Drain writers for installation. 0007 explicitly takes ACCESS EXCLUSIVE on the existing scope table; ADD COLUMN/CHECK and new ordinary indexes/FKs take transactional DDL locks, including referenced-table locks. `lock_timeout=10s` bounds individual lock waits, not total installation/scan duration. No zero-downtime or large-history timing claim follows from disposable fixtures. Installation requires administrative role/function-ownership authority.

Existing scopes receive revision0, not a clearance certificate. No account authority, admission, obligation or resolution is backfilled. Populated0006 upgrade fingerprints cover twelve original relations plus selected B.1/F02/allocation functions, including an actual finalized dormant refund, original capture, signed receipt, proof, audit and review. The deliberately failing migration rolls back the new tables, scope column, functions and role while preserving seven previous migrations and original evidence. There is no destructive post-commit down migration; reverting application code retains additive financial evidence.

The original ACTIVE exclusion, immutable UNINSTALLED accounts, readiness refusal and financial proof-reference/version CHECKs remain closed. Existing legacy inbox/ledger/lot/allocation/exception behavior remains unchanged. No controller/module/provider consumer/job/payout source changed.

## 10. Permanent PostgreSQL matrix

The admission suite uses its own retained database so its deliberately unapplied receipts do not contaminate legacy global inbox pollers. Positive completion fixtures invoke the actual dormant refund service with a test-only FOUNDATION_ONLY admission override; no stored ACTIVE scope exists. Restricted publisher/worker calls use SET LOCAL ROLE and no ledger write capability.

The matrix covers mandatory/false-unrelated deferred admission, known/unknown owners, wrong merchant/payment/currency/account/revision, duplicate bytes/identity, unsupported and pending policy, original-byte preservation, receipt and resolution rollback, legacy status independence, full verified refund application/no-effect, missing/wrong completion evidence, idempotent/conflicting completion, review/reblocking, protected revisions, stale snapshots and account-specific barriers.

Controlled schedules observe distinct backend PIDs and `pg_blocking_pids`, hold explicit pre-commit gates, use bounded statement timeouts and await cleanup: same-scope admissions, both known receipt/reader orders, both unknown receipt/reader orders, transfer/reader, unknown transfer/scoped admission, resolution-revision/admission and conflicting resolutions. No40P01 or uniqueness error counts as successful serialization. The separate FK-mode check proves KEY SHARE compatibility with the scope NKU reader. These are SQL receipt-side schedules, not live settlement/payout races.

The six migration cases cover fresh/repeated installation, populated0006 upgrade, legacy compatibility/history retention, late-error rollback, unchanged dormant gates and non-login/pinned/no-PUBLIC/no-ledger-write catalogs.

## 11. Verification evidence

Windows, Node24.19.0, pnpm10.26.0 and disposable PostgreSQL18.6 only. No private environment file was loaded or printed.

The initial package-script target stalled before creating a test database and was cancelled; no pass was inferred. Direct Jest from the repository root then failed to find the API-relative tsconfig. Running the installed runner from `apps/api` with a writable ignored TEMP directory resolved the harness issue. Initial lint found two unsafe result/error typings; they were corrected. Strengthening populated migration history to finalized evidence exposed an earlier immutability rejection before the intended version CHECK; the version-gate assertion now uses a separate RESERVED fixture and still requires the CHECK. No original financial assertion was weakened.

A permanent defensive classification case reproduced one committed bad R0 enrollment: raw customer event plus contradictory normalized refund data was classified irrelevant with no obligation. The new guard refuses that mismatch and rolls receipt/admission writes back. Retained pre-correction report: `.tmp/b2r0-classification-before.json` (one intended failure; other names filtered). Earlier full runs passed459 and460 cases before final Option A staging; final results below supersede them. Those temporary reports are not deliverables.

The final build initially hit sandbox EPERM creating Next output. Running build and typecheck concurrently also let typecheck observe missing generated Next types. The permitted build retry passed, then a **sequential** typecheck passed. No source workaround or generated artifact was committed.

| Final executed check | Result |
| --- | --- |
| `pnpm lint` | API/web passed |
| `pnpm typecheck`, after build | API/web passed |
| `pnpm test` | 50 unit passes;466 DB opt-ins skipped by default, executed separately |
| `pnpm build` | API/web passed; permitted retry after generated-output EPERM |
| New admission suite | **50 passed**, none skipped |
| New migration suite | **6 passed**, none skipped |
| Accepted PostgreSQL suites | **404 passed**, none skipped |
| Combined final PostgreSQL | **460 passed / 13 suites / 0 failed / 0 skipped**,76.171s |
| Separate unchanged F01 | **6 expected financial assertion failures / 0 skipped**,9.656s; same six names/statuses as B.1 |
| Final catalog | Exact0007 hash; all four built Drizzle models' column names/nullability match;10 pinned routines, no PUBLIC execution; non-login owner has no ledger-header/entry/account write or schema-CREATE rights |

Root script environment used the installed offline Corepack cache:

```powershell
$env:COREPACK_HOME='C:/Users/Daniel/AppData/Local/node/corepack'
$env:COREPACK_ENABLE_NETWORK='0'
$env:TEMP=(Resolve-Path '.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
pnpm lint
pnpm test
pnpm build
pnpm typecheck
```

The accepted build ran with permitted local filesystem access. Logs: `.tmp/b2r0-lint-final.log`, `b2r0-test-accepted.log`, `b2r0-build-accepted.log`, `b2r0-typecheck-accepted.log`. Full PostgreSQL command, executed from `apps/api`:

```powershell
$env:TEMP=(Resolve-Path '../../.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
$env:MIGRATION_ADMIN_URL='postgres://fintech@127.0.0.1:55432/postgres'
$env:DATABASE_URL='postgres://fintech@127.0.0.1:55432/'+(Get-Content '../../.tmp/b2r0-db.txt').Trim()
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/capture-accounting-integration.spec.ts test/integration/refund-accounting-integration.spec.ts test/integration/dispute-accounting-integration.spec.ts test/integration/settlement-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts test/integration/integrated-accounting-verification.spec.ts test/integration/trusted-financial-evidence.spec.ts test/integration/trusted-evidence-migration.spec.ts test/integration/receipt-admission.spec.ts test/integration/receipt-admission-migration.spec.ts --cacheDirectory ../../.tmp/jest-b2r0 --json --outputFile ../../.tmp/b2r0-accepted-pg.json
```

The separate F01 command used the same local DATABASE_URL and RUN_DB_TESTS, plus RUN_F01_PENDING=1:

```powershell
$env:RUN_F01_PENDING='1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-b2r0 --json --outputFile ../../.tmp/b2r0-accepted-f01.json
```

It exited1 for the original financial assertions, not a setup/privilege failure. Ignored final catalog/preservation script: `node .tmp/b2r0-catalog.cjs` from the root; final JSON `.tmp/b2r0-catalog.json`. It independently compares original migration/journal entries and the untouched R1 record. Fresh-chain setup used `node .tmp/b2r0-setup.cjs`; migration regressions independently install and upgrade their own retained databases.

| Final inspected database | Migrations | ACTIVE / enabled accounts | Admissions / obligations / resolutions |
| --- | ---: | --- | --- |
| `fintech_b2r0_1792309282200` | 8 | **0 / 0** | 0 / 0 / 0 |
| `fintech_r0_admission_55c553e7c3724907911e64524d499fb9` | 8 | **0 / 0** | 43 / 42 / 9 |

Final checks: `node .tmp/validate-docs.cjs` passed **42 Markdown files /535 relative links and anchors**, plus CI YAML parsing/structure. It extracted19 existing Mermaid blocks; no diagram parser/rendering was executed. `git diff --check` passed. A direct final-newline/trailing-whitespace check included all untracked deliverables. Manual scope review and an explicit inventory assertion verified13 R0 deliverables plus the untouched pre-existing R1 record, an empty index, no runtime source changes beyond storage declarations, unchanged SQL0000–0006 and preserved first seven journal entries. The R1 record is byte-identical and the old index contents are preserved after removing the new R0 link.

The final catalog check was repeated after all regressions and again passed. `pg_ctl.exe stop -D .tmp/verification-pg18 -m fast -w` exited0, restoring the cluster's original stopped state without deleting histories or logs. HEAD remains cdbad57; all intended work remains uncommitted. No push occurred. **R0 is ready for independent review as a dormant database checkpoint only.**

## 12. R1/R2 prerequisites and independent review

R1 still needs its actual SDK-verifying raw HTTP adapter, real configured provider-account context, atomic inbox/publisher transaction, narrowly reviewed capability grants, event-classification matrix, separate B.1 correlation composition and durable failed-correlation/conflict publication. A fixture verifier string is not deployed authenticity. Pending callbacks must remain Option A neutral. Non-inbox command-result/reconciliation publishers and their same-obligation linkage remain explicit work.

R2 must install protected financial era/default1/no-downgrade guards, shared-reader immediate/deferred financial adapters, bidirectional complete application/workflow/audit/inbox linkage, zero/no-effect and dispute/capture resolution contracts, current policy/mode/epoch/claim permits, exception resolution/resume, all-writer lock/revision participation, old-worker fencing and reviewed cohort/candidate recovery. R0 receipt inspection and completion records cannot substitute for those guarantees. F01/F04/F05/F06 remain open.

Independent review should prioritize the enrolled-receipt/mandatory-obligation implication, unrelated/pending classification, completion evidence sufficiency and narrow supported cases, ordinary-role mutation boundaries, unknown transfer and both revision counters, implicit FK waits and partial-adoption lock risks, and the distinction between an existing financial fact and authorization for a new financial application.

**NOT RUN:** PostgreSQL17/hosted CI, signed HTTP, actual Stripe/test-account API, broker/worker/Redis, full R1/R2 services, production/shared migrations, production credentials/session fences, real history reconciliation or large-history benchmarks. No external financial operation occurred. R1/R2/B.3 were not started and no accounting scope was activated.

## 13. R0.1 author correction — admission classification (2026-10-18)

Current author handoff: **READY_FOR_RE_REVIEW**, not independently accepted. The original R0 report above and the independent **REQUEST_CHANGES** verdict remain historical evidence. This section records the requested correction only; it does not supersede that review.

### Baseline and corrected files

Started on `main`, HEAD `cdbad57ccaab9edf83aa5fdf4d18e5c30b4f7514`, empty index, with16 existing R0/review/R1 worktree files. Preserved the B.1 checkpoint, migrations0000–0006, all earlier journal entries, original six F01 assertions and the R1 blocked-preflight record. R0.1 changes the existing uncommitted0007, the admission/reviewer test files, CI integration environment, this record, the independent record's author-response appendix and the Database design/Verification owners. It adds no financial runtime wiring or Drizzle shape change. The total worktree inventory is17 intended files; ignored `.tmp` tools/logs/databases are not deliverables. No staging, commit or push.

### P1 reproduction and root cause

Ran the three reviewer regressions **unchanged before editing SQL** on a fresh PostgreSQL18.6 database. Exit1: **2 failed /1 passed /0 skipped** (`.tmp/b2r01-before.json`). Both original negative fixtures committed one receipt and admission, disposition AWAITING_CONFIRMATION, no proof/refund journal, and a reader that returned clear. The genuine pending control passed. The raw-status CASE selected `refund.pending` without comparing normalized terminal claims; the deferred check repeated that same classification, so it did not correct the nonblocking disposition.

The review tests' original expected result was publication rejection with **zero receipts/admissions and a clear reader**. That rejection oracle conflicts with R0.1's explicit retained-receipt/blocking-review requirement. Both original fixture constructions, names and the genuine-pending control remain. Their assertions now require **successful retention of one receipt/admission, BLOCKING_REVIEW, no proof/journal and a blocked reader**, plus the linked immutable review. This changes the oracle openly to the requested durable contract; it does not turn the reproduced bad result into an accepted result. The original complete test file is retained in ignored `.tmp/b2r01-original-receipt-admission-review-regressions.spec.ts`, and the review below preserves its original findings.

### SQL classification and durable contract

`receipt_admission_facts` derives everything from the immutable original inbox and receipt; callers cannot choose a pending classification. Before granting the pending exemption it requires version1's `provider.unsupported` with JSON-null data. A terminal normalized success/failure or unexpected financial data produces a contradiction reason. Confirmed refund/dispute outcomes reuse unchanged B.1 `financial_receipt_facts` for exact operation, amount, currency, provider-object and explicit-owner comparisons; a present normalized providerStatus must also match the raw status. A refund.failed event with pending/requires_action/succeeded object status also retains a contradiction review. Only expected validation failures become review evidence; lock/privilege/database errors are not swallowed. Contradictory financial labeling of an otherwise nonfinancial customer event also retains a review, whereas genuine nonfinancial customer normalization remains obligation-free.

Enrollment atomically retains the original receipt, immutable enrollment, immutable CONTRADICTORY review (fixed classifier key/reason) and BLOCKING_REVIEW obligation. The review refers to the same inbox, whose exact raw bytes and normalized snapshot remain unchanged. No untrusted metadata is promoted into a scope: contradictory input takes exclusive account intake before any scope lock and advances that account's evidence revision. The capability owner gains only append-only financial-review INSERT in addition to its previous grants; it still cannot mutate reviews, ledger headers, entries or accounts. No ordinary runtime grants are installed.

Deferred validation now requires the retained classifier review and blocking disposition whenever reclassification detects a contradiction, and requires any current review reference to belong to the same inbox. One permanent case explicitly reaches that deferred check under the non-login capability owner with an otherwise structurally valid nonblocking obligation; commit fails. Original bytes/proofs and B.1 ownership/amount/currency checks are not rewritten. Duplicate publication/re-enrollment returns the same obligation/review without another revision. RETRY/DEAD and lease-age changes do not clear it. Unproven resolution/binding and unauthorized direct clearance fail; rollback preserves a prior blocker. Initial publication rollback leaves no partial receipt/admission/review, and retry establishes the complete blocker.

Genuine `pending`/`requires_action` normalization remains AWAITING_CONFIRMATION and clear when no other blocker exists, with no posted refund hold. Matching terminal outcomes remain AWAITING_CORRELATION until trusted ownership, then the existing AWAITING_APPLICATION contract requires financial application/no-effect evidence. Unknown review blocks the configured provider account, including other scopes on that account as H04 requires; a different configured account remains clear. Scope ownership is not guessed, and stale intake revisions reject. Legacy money movement still does not consult this staged reader: no current-runtime quarantine or financial permit is claimed.

### P2 CI correction and database cleanup boundary

[CI](../../.github/workflows/ci.yml) now sets `MIGRATION_ADMIN_URL=postgres://fintech:fintech@localhost:5432/postgres` and `RUN_MIGRATION_TESTS=1` alongside RUN_DB_TESTS in the existing disposable PostgreSQL17 service job. These are the same checked-in fixture identities as the service, not external credentials. The Node22/24 job is structurally unchanged. Localhost validation and SET LOCAL ROLE publisher/worker checks are unchanged. No fallback or missing-variable skip was added.

The migration suites create UUID databases and close their clients in afterAll; they deliberately retain local immutable financial histories. CI container disposal is the job-level database/role cleanup boundary. A separate local empty-install check created a unique database, applied all8 migrations, asserted zero journals/receipts/scopes, closed its connection, dropped **only that newly created empty database** and its two unique non-login owners, and checked their absence. Existing reproduction histories were retained. `.tmp/b2r01-ci-contract.json` records local setup/cleanup and the unchanged Node job. This proves local administrative setup/cleanup capability, not hosted PostgreSQL17 execution.

### Executed R0.1 verification

Environment: Node24.19.0, pnpm10.26.0, disposable localhost PostgreSQL18.6 (`127.0.0.1:55432`), installed offline dependencies. No private environment values or external service calls. Fresh shared matrix database: `fintech_b2r01_1792313779837`,8 migrations. Admission/review suites create their own fresh databases, isolating their deliberately unresolved inboxes from legacy pollers.

| Executed check | Result |
| --- | --- |
| Unchanged three-case reviewer baseline | 2 failed /1 passed /0 skipped,10.31s; retained bad committed state |
| Final classification regression file | **31 passed /0 skipped**,9.785s; original3 plus28 focused companions |
| Complete required PostgreSQL matrix | **491 passed /14 suites /0 failed /0 skipped**,76.752s: original460 plus31 classification cases |
| Separate original F01 | **6 expected financial assertion failures /0 skipped**,7.582s; names and financial assertion differences match prior independent evidence |
| `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` | Passed; unit50, default DB opt-ins497 skipped and exercised separately; Nest/Next builds passed |
| CI environment/empty database cleanup check | Passed locally; both migration opt-ins configured, local service URL only, Node job unchanged |
| Catalog/preservation |8 migrations/exact0007 hash, four Drizzle models,10 pinned functions/7 definers/no PUBLIC execution, non-login owner/no ledger write or schema CREATE; zero ACTIVE/enabled accounts in all three inspected databases |

The first expanded run found TypeScript fixture annotations/missing required providerTransactionId; these were corrected. Lint then found an unnecessary fixture cast, removed. A full matrix run passed487 cases but one new deferred-check fixture failed before the intended check because its helper supplied the pre-override normalized payload. Correcting that fixture to the actual immutable inbox snapshot produced 28-case and488-case passes. Final inspection additionally classified refund.failed events with pending/requires_action/succeeded object statuses as contradictions and added three companions; the final491-case matrix includes all31 classification cases. No product test expectation was weakened to accept that setup error. Ignored logs/JSON retain these intermediate results.

Exact baseline/final classification commands, from `apps/api`:

```powershell
$env:TEMP=(Resolve-Path '../../.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
$env:RUN_DB_TESTS='1'
$env:MIGRATION_ADMIN_URL='postgres://fintech@127.0.0.1:55432/postgres'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/receipt-admission-review-regressions.spec.ts --cacheDirectory ../../.tmp/jest-b2r01 --json --outputFile ../../.tmp/b2r01-before.json
# The preceding command ran before correction; the following ran after it.
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/receipt-admission-review-regressions.spec.ts --cacheDirectory ../../.tmp/jest-b2r01 --json --outputFile ../../.tmp/b2r01-regressions-final-accepted.json
```

Full final PostgreSQL command, same API directory:

```powershell
$env:RUN_MIGRATION_TESTS='1'
$env:DATABASE_URL='postgres://fintech@127.0.0.1:55432/'+(Get-Content '../../.tmp/b2r01-db.txt').Trim()
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/capture-accounting-integration.spec.ts test/integration/refund-accounting-integration.spec.ts test/integration/dispute-accounting-integration.spec.ts test/integration/settlement-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts test/integration/integrated-accounting-verification.spec.ts test/integration/trusted-financial-evidence.spec.ts test/integration/trusted-evidence-migration.spec.ts test/integration/receipt-admission.spec.ts test/integration/receipt-admission-migration.spec.ts test/integration/receipt-admission-review-regressions.spec.ts --cacheDirectory ../../.tmp/jest-b2r01 --json --outputFile ../../.tmp/b2r01-final-accepted-pg.json
$env:RUN_F01_PENDING='1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-b2r01 --json --outputFile ../../.tmp/b2r01-f01-final.json
```

Root static/build commands used the offline Corepack/TEMP environment from §11. Logs use `.tmp/b2r01-{lint-accepted,typecheck-accepted,test-accepted,build}.log`; build precedes final typecheck to avoid Next generated-type races. Additional root commands: `node .tmp/b2r01-setup.cjs`, `node .tmp/b2r01-ci-contract.cjs`, `node .tmp/b2r01-catalog.cjs`, `node .tmp/validate-docs.cjs`, `git diff --check`. Final preservation/documentation/cluster-restoration results are recorded in the completion note below.

### Re-review priorities and remaining limits

Independently recheck retained contradiction provenance, the changed rejection-versus-retention test oracle, B.1 validator reuse/providerStatus check, deferred nonblocking rejection, exclusive unknown-intake selection before scope, review INSERT capability, replay/stale revisions and CI's enabled migration environment. The original independent verdict remains REQUEST_CHANGES until a new independent gate.

R1 HTTP/SDK/account-context/atomic inbox integration, R2 policy/claim/financial-linkage adapters and all-writer lock/revision coordination, D02/D03 inventory/recovery, operational credential fencing and scope activation remain unimplemented. No scope is ACTIVE; F01/F04/F05/F06 remain open. **NOT RUN:** PostgreSQL17, hosted Actions, signed HTTP, live Stripe/test-account API, RabbitMQ/Redis, production/shared migrations, real history reconciliation or large-history benchmarks. No R1/R2 implementation, financial policy change, commit or push occurred.

R0.1 completion note: `node .tmp/validate-docs.cjs` passed **43 Markdown files /542 relative links and anchors**, plus CI YAML parsing/structure. It extracted19 existing Mermaid blocks; no diagram parser/rendering was run. `git diff --check` and direct newline/trailing-whitespace checks for all17 intended files passed. `node .tmp/b2r01-finish.cjs` verified the exact17-file inventory, eight corrective files, empty index/unchanged HEAD, byte-preserved original report prefixes, unchanged non-corrective R0/B.1/R1 evidence, unchanged0000–0006/seven earlier journal entries and original F01 names/statuses/financial assertion differences. `.tmp/b2r01-final-inventory.json` records those assertions. Final catalog and `node .tmp/b2r01-final-gates.cjs` confirm zero ACTIVE/enabled scopes/accounts, zero opened financial proof references and immutable-review INSERT without UPDATE/DELETE/TRUNCATE in all three R0.1 databases. R0.1 database identities are saved separately; earlier author/reviewer markers were restored. `pg_ctl.exe stop -D .tmp/verification-pg18 -m fast -w` exited0, restoring the original stopped cluster without deleting financial histories. All work remains uncommitted and unstaged for independent re-review.
