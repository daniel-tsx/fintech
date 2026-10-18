# H1 Fix 02 — B3.2 B.2-R0 independent receipt admission review

Status: completed independent PostgreSQL correctness, concurrency and defensive engineering review, **2026-10-18**.

Verdict: **REQUEST_CHANGES**.

The original460 PostgreSQL cases independently pass, and the mandatory obligation, transfer, revision and restricted-role mechanisms generally work as described. However, the current SQL classifier admits contradictory normalized financial evidence through its nonblocking pending-refund branch. Two permanent review regressions reproduce that committed result. Correct this R0 classification defect before preserving the checkpoint as accepted. A separate CI setup regression also needs attention. No financial implementation fix, R1/R2 adapter, activation, commit or push was performed.

## 1. Baseline and reviewed diff

Started on `main`, HEAD **cdbad57ccaab9edf83aa5fdf4d18e5c30b4f7514**, the committed B.1 foundation. Its migration0006, implementation and independent acceptance are present; approved human decisions at b8658f4 remain in history. Initial index empty. The initial worktree contained14 files: **13 R0 deliverables plus the earlier untracked R1 blocked-preflight document**. The R1 record is inherited evidence, not newly implemented R0 functionality.

Read repository AGENTS/CLAUDE, routing/workflow, overview/index/scripts, the approved human decisions, B3.2 design/corrective contract and independent acceptance, B.1 implementation/review and both R1/R0 records. Rechecked the database/ledger/concurrency owners and receiver/normalizer/processor/financial service boundaries. Inspected every line of0007, all four new Drizzle declarations, scope revision addition, journal append, both new suites, all four modified existing tests and documentation changes. Searches found new runtime names only in storage declarations; no live service calls or registrations changed.

| R0 files | Inspected change |
| --- | --- |
| `apps/api/drizzle/0007_receipt_admission_foundation.sql` | Four relations, revision guards, publisher/lifecycle/reader functions, deferred constraints, indexes and restricted owner |
| `apps/api/drizzle/meta/_journal.json` | Append index7/tag0007/timestamp1792307672232; first seven entries preserved |
| `apps/api/src/database/schema.ts` | Storage declarations plus scope evidence revision |
| `receipt-admission.spec.ts`, `receipt-admission-migration.spec.ts` | 50 admission and six migration cases |
| Capture migration, integrated accounting, settlement integration and B.1 evidence migration specs | Eight-migration count/title changes only; original financial assertions retained |
| R0 record, docs index, Database design and Verification | Staging, behavior and implementation evidence |

A SHA-256 manifest verified all14 initial files unchanged before review navigation. SQL0000–0006, original design/review/human decisions, both committed B.1 records and F01 source match Git-normalized HEAD. The earlier R1 document remains byte-identical. This review adds this report, one index link and [three independent regression cases](../../apps/api/test/integration/receipt-admission-review-regressions.spec.ts). No author source/test assertion was changed.

## 2. Acceptance verdict and scope

F1 below is a **current R0 SQL classification defect**, not a request to implement R1 or R2. The supported nonblocking pending path needs the same contradiction protection already present for irrelevant customer events. Neither a future TypeScript normalization convention nor R2 proof rejection makes contradictory admitted input acceptable today.

The primary cardinality invariant did hold in the executed tests: a financially relevant **enrollment** could not commit without its obligation. F1 is different: the obligation exists but receives the wrong **nonblocking disposition**, and the staged reader returns clear. No missing-obligation bypass, forged confirmed proof, actual payout or activated financial application was demonstrated. This limited impact is still material to acceptance of the admission classifier itself.

R0 remains dormant: all inspected scopes exclude ACTIVE; evidence accounts remain UNINSTALLED; financial version1 references stay closed; no live publisher/dispatcher integration exists. Those restrictions bound present financial exposure, but do not make the newly reproduced classifier behavior correct.

## 3. Mandatory atomic obligation enforcement

The enforcement chain in [0007](../../apps/api/drizzle/0007_receipt_admission_foundation.sql) is SQL-owned:

- `receipt_admissions` uses the original inbox UUID, FK-linked to the immutable B.1 receipt. Contract version must be1. Its provider/account/operation tuple is the obligation's referenced identity.
- `publish_admitted_receipt` owns the private inbox and account UPDATE before B.1's nested receipt-trigger SHARE, inserts or compares exact original receipt data and calls enrollment in the same transaction.
- `enroll_receipt_admission` derives classification from stored evidence, creates intake authority as needed, advances the appropriate revision and inserts the enrollment plus its obligation. Known ownership uses the exact B.1 proof tuple; it cannot be supplied as arbitrary merchant/payment fields.
- `receipt_requires_obligation` is an initially deferred constraint trigger after enrollment INSERT. At commit it reclassifies original evidence and requires an obligation exactly when relevant. The obligation primary key permits at most one. `receipt_obligation_consistent` revalidates classification/owned proof after obligation INSERT/UPDATE.
- Immutable enrollment and no-DELETE/TRUNCATE obligation guards prevent removing the relationship afterward. Ordinary worker/publisher roles have no direct table insertion capability.

Independent negative probes exercised missing obligations at commit, an explicit early `SET CONSTRAINTS ALL IMMEDIATE`, false unrelated classification, partial owner tuples, wrong account and version0. Each rejected transaction left the prior receipt/proof unchanged and no new enrollment/obligation. Known-enrollment abort preserved scope revision0; atomic-publisher abort left no receipt/enrollment/obligation/intake authority. Identical publication/enrollment preserved the existing obligation and revisions. Contradictory duplicate account/bytes could not overwrite it.

A **bare B.1 receipt is not an admitted R0 receipt**. Legacy B.1 publication remains legal and is not automatically enrolled. That is the explicit compatibility boundary, not a universal trigger requiring every historical/legacy receipt to have an obligation. Future R1 must receive only the protected atomic publisher capability and create its inbox in the same caller transaction. Giving it bare receipt INSERT would invalidate the claimed R1 publisher boundary. No deployed HTTP publisher exists in this checkpoint.

## 4. Lifecycle and clearance validation

The guarded lifecycle separates pending confirmation, unresolved ownership, owned unapplied facts, blocking review and immutable completion evidence. RETRY/DEAD/PROCESSED/IGNORED mutations did not clear obligations. Lease expiration is not a clearance operation. Original bytes, normalized snapshot, event identity and B.1 sealed proof remain unchanged by transitions.

Known ownership cannot be reassigned after binding. Reviews must reference a matching immutable B.1 review on that inbox. Review is sticky; replaying a binding does not clear it. A later review can reblock a cleared obligation while preserving the first immutable resolution row. Review history remains discoverable through immutable inbox-linked reviews even though the current obligation names only the latest review.

`resolve_receipt_obligation` is a restricted financial-fact recognizer, not a posting API. It locks/rechecks the owned proof, payment/refund and frozen allocations. Supported completion requires:

| Kind | Required evidence |
| --- | --- |
| APPLICATION | Signed refund-success proof; exact refund owner/object/amount/currency and SUCCEEDED state; complete CONFIRMED allocations on this inbox and the supplied journal; same frozen lot set; matching immutable POSTED REFUND business journal and financial audit |
| NO_EFFECT | Signed failed/canceled refund proof; matching FAILED refund; complete RELEASED reservations and failure reason on this inbox; matching immutable failure audit; no REFUND journal for that refund |

Proof alone, an arbitrary no-effect assertion or an unrelated balanced capture journal failed to clear an obligation. Duplicate resolution returned the same immutable evidence without another revision increment. Conflicting resolution refused and retained the first result. Resolution rollback preserved the blocker and left no completion row. The worker had no ledger writes in these tests.

The routine sees facts visible to its transaction; it does not independently prove they committed in an earlier transaction. The positive tests deliberately apply the actual dormant service first, commit, then acknowledge. If a future caller writes valid facts in the same transaction, resolution and those writes would share commit/rollback; this must not be described as enforced prior-transaction provenance.

R0 does **not** enforce the complete bidirectional R2 financial/workflow/audit/inbox contract. It does not require or install version1 financial adapters, bind a claim/policy permit, clear accounting exceptions, resume scopes, or recognize every dispute/capture/duplicate no-effect case. Different provider event IDs for an already applied refund can remain blocked because R0 requires allocations to reference this exact inbox. Later verified duplicate recognition is R2 work, not a reason to loosen the present check.

## 5. Provider-account barrier and ownership transfer

Relevant unresolved enrollment has NULL merchant/payment/currency/proof and AWAITING_CORRELATION. The account blocker is durable and independent of inbox status; there is no timeout auto-clear. Unclassified events remain conservative account-level obligations. Genuine pending refunds retain an obligation but are intentionally excluded from the blocker predicate under Option A. F1 concerns contradictory input incorrectly entering that neutral class, not genuine pending neutrality.

`inspect_receipt_admission` checks unknown blockers for the configured provider/account and scoped blockers/OPEN exceptions for the merchant/currency. Known-scope financial obligations remain scoped even across accounts; an unknown account does not automatically freeze all other configured accounts. The routine is a staged receipt reader, not a tenant authorization service or financial permit. The caller's actual account context still needs trusted R1 configuration.

Transfer owns the original inbox, takes account UPDATE, validates that inbox's fixed proof, then advisory/scope NKU. It updates intake revision, scope revision and the same obligation atomically from unknown blocking to scoped AWAITING_APPLICATION. Neither old broad blocker removal nor new scoped blocker insertion can commit alone. Independent reversed-order transfer/enrollment probes and the permanent transfer/reader probe observed real waits and retained the scoped blocker after commit. Another configured account could neither republish the same inbox under itself nor supply a different-inbox proof to clear the original barrier.

Legacy payment, settlement and payout services do not call the new reader, so this does **not** claim current pooled funds are quarantined. Existing financial suites and migration compatibility tests retain legacy behavior, as H04 requires. Operational review deadlines/escalation, complete source inventory and unknown recovery remain R1/R2/runbook work.

## 6. Evidence revision guarantees

Scope and intake revisions are bigint, nonnegative, initial0. Authority identity and deletion/TRUNCATE are protected. A changed revision requires the restricted admission owner and exactly old+1. Ordinary direct assignments failed, including after a legacy-style scope UPDATE grant; normal legacy status updates remain legal.

Known enrollment/review/resolution advances scope revision. Unknown enrollment/review advances intake revision. Unknown-to-known transfer advances both. Identical duplicates do not invent changes. Genuine pending evidence advances intake revision conservatively despite remaining Option A neutral. Relevant failed transactions did not retain their increment. Separate receipts on one scope committed both increments with no lost update; independent tests first established intake authority so this was actual advisory/scope serialization rather than merely first-row uniqueness contention.

The reader holds account SHARE and advisory/scope NKU, then reads current revisions and blockers. Supplied stale expected scope/intake revisions reject, including after the blocker was legitimately cleared. Omitting expected revisions requests a fresh check; it does not validate an old cached decision. Unknown barrier changes invalidate the applicable account view; scoped changes invalidate that scope's view.

These are receipt evidence revisions, **not balances, complete reconciliation certificates, policy/admission epochs or authorization to pay out**. Legacy financial writers do not yet advance them. Their separation is compatible with H02; the tested local receipt/reader ordering implements only the staged part of H03/H04. R2 must coordinate all relevant writers before relying on them for financial admission/certification.

## 7. Lock graph and independent concurrency evidence

Reviewed explicit locks and FK/unique waits:

```text
Atomic publication: private inbox → account UPDATE → B.1 receipt trigger
  (same inbox version write, account SHARE already subsumed) → enrollment
Known enrollment: private inbox → account SHARE → intake-row creation/read
  → canonical advisory → scope NO KEY UPDATE → proof reread → obligation
Unknown enrollment/transfer: private inbox → account UPDATE
  → [destination advisory → scope NKU for transfer] → revision/obligation
Resolution: private inbox → account SHARE → advisory/scope NKU
  → payment NKU → refund UPDATE → ordered lots/allocations NKU → completion
Isolated inspection: account SHARE → advisory → scope NKU → fresh predicates
B.1 sealing: private inbox → account UPDATE → advisory/scope
  → payment/children/lots/allocations → immutable owner/proof
```

The new publisher's exclusive account acquisition **precedes** the old trigger's SHARE, so it does not rely on upgrading two concurrent SHARE holders. First-use intake INSERT can wait on a unique key; known scope writes serialize through advisory/scope. Scope NKU permits the obligation FK's KEY SHARE while excluding competing non-key scope writers. All new mutation APIs serialize on their own private inbox before later locks; they do not acquire another operation's inbox afterward. Obligation UPDATE and deferred resolution FK occur under that prefix. No network call is inside SQL.

| Requested contention | Independently executed evidence |
| --- | --- |
| Two receipts, same provider account | Two actual restricted atomic publishers, both first-publication orders, different merchants/inboxes; observed account wait, both committed, intake revision2 |
| Same merchant/currency receipts | Permanent schedule plus supplement with pre-existing intake authority; two obligations and scope revision2 |
| Known admission versus revision update | Permanent resolution/enrollment and stale-revision cases; both increments retained |
| Unknown transfer versus scoped enrollment | Permanent case plus both reversed supplement orders; account-before-scope wait, two scoped obligations, revision2 |
| Receipt-first versus reader | Permanent known and unknown variants; reader waited then refused committed blocker |
| Reader-first versus receipt | Permanent known and unknown variants; receipt could not commit inside the held reader interval |
| Conflicting resolutions | Permanent private-inbox wait; second conflicting attempt rejected, first completion retained |
| Abort after enrollment | Permanent publisher rollback plus direct known-enrollment abort; no admission/obligation or scope increment survived |
| B.1 sealing versus R0 enrollment | Supplement both orders on one inbox; wait observed, one fixed proof/obligation, unknown-first then guarded binding |
| Different merchants sharing account | Actual publishers serialize as unknown; independently, two known enrollments share account SHARE and the second merchant commits before the first releases its separate scope |

Tests used explicit promise gates, distinct PIDs, bounded `pg_blocking_pids` polling, statement timeouts and awaited cleanup. None accepted40P01,23505 or retry success as serialization proof. The separate-scope completion check uses a timeout only as a failure bound; its success oracle is a committed second obligation while the first gate remains held.

Do not compose bare B.1 SHARE publication and later unknown enrollment/sealing as if that were the new atomic publisher. R1 must use exclusive-first publication and separately reviewed correlation composition. Existing legacy refund/mirror/authorization reverse edges still prohibit partial live financial integration. These schedules establish neither universal deadlock freedom nor live settlement/payout correctness. PostgreSQL's [locking semantics](https://www.postgresql.org/docs/18/explicit-locking.html) support the interpretation; the local wait/committed-state results are the executed evidence.

## 8. Privilege and trusted publisher assessment

The dedicated `fintech_admission_<md5(database)>` owner is NOLOGIN/NOINHERIT, non-superuser/non-CREATEROLE/non-CREATEDB/non-REPLICATION/non-BYPASSRLS. It has evidence SELECT, receipt/admission INSERT, obligation UPDATE and limited timestamp/revision column grants needed for locks and guarded writes. It has no ledger header/entry/account INSERT/UPDATE/DELETE/TRUNCATE and no lasting schema CREATE.

All ten new functions pin `pg_catalog, pg_temp`; seven restricted entry/constraint routines are SECURITY DEFINER and three classification/guard functions are invoker-based. Persistent references are schema-qualified, and caller values are not interpolated into SQL. PUBLIC EXECUTE/table rights are revoked. No real login or worker membership is installed by the migration. Function-owner and trigger behavior follow PostgreSQL's [function security](https://www.postgresql.org/docs/18/sql-createfunction.html) and [constraint-trigger](https://www.postgresql.org/docs/18/sql-createtrigger.html) contracts.

Positive publication/lifecycle/inspection tests ran through SET LOCAL ROLE with explicit restricted fixture grants. Supplemental ordinary-role attempts to insert admissions/receipts/resolutions, change/delete/truncate obligations and mutate sealed proof failed permission checks and preserved saved receipt/proof/obligation. An arbitrary NO_EFFECT request also failed. Capability-owner-only direct INSERT was used separately to test deferred structural checks, not passed off as ordinary-role isolation. Admin setup/fixture privileges do not establish runtime isolation.

Independent final catalogs in five databases verify10 pinned functions,7 definers, no PUBLIC execution, safe owner attributes, no schema CREATE and no ledger writes. Built Drizzle column names/nullability match all four SQL relations. Drizzle does not model trigger/function privileges or the resolution FK's deferred execution as a complete alternate schema; checked-in SQL remains authoritative and schema push/generation is not approved.

R1 still must establish real SDK verification of exact bytes, authenticated configured provider/account, actual verifier/version, stable inbox identity, same-transaction inbox/publication, narrow EXECUTE grants without raw-table writes, duplicate/conflict handling and retired owner-pool access. SQL attestation does not verify HMAC. The publisher is a trusted capability; F1 demonstrates that even this capability's malformed normalized input should be rejected structurally rather than trusted into a neutral disposition.

## 9. Forward migration and legacy compatibility

Independently installed all eight migrations in a new disposable database: PostgreSQL18.6, **394ms**. The six R0 migration cases and six accepted B.1 migration cases passed. Fresh/repeated installation, populated0006 upgrade with finalized dormant refund and original signed receipt/proof/review, original journal immutability, closed v1/ACTIVE gates, late-error rollback and capability catalogs passed. The populated upgrade compares12 existing relations and selected financial/B.1 function definitions. It does not prove every conceivable large historical state; no broader claim is made.

0007 replaces no B.1 function, edits no historical migration and backfills no admission, trust, object owner or financial effect. Existing scopes gain nonfinancial revision0. Legacy B.1 receipt/allocation/inbox writers remain usable and unadmitted; original financial assertions were unchanged apart from migration counts/titles. Failure rollback retains original receipts/journals and seven earlier migration records while removing new storage, column and role. This is transactional installation rollback, not a destructive post-commit down migration.

Drain writers for installation. Scope ACCESS EXCLUSIVE blocks reads and writes; ALTER/FK/trigger installation also locks referenced existing relations. New ordinary indexes are transactional, not concurrent. Scope default/CHECK validation and schema/catalog work are not a zero-downtime promise. `lock_timeout=10s` bounds lock waits, not total scan/install time. Installation needs administrative CREATEROLE/function ownership authority. No large-history lock/scan benchmark or production migration was performed.

## 10. Independent regression evidence matrix

Windows; Node24.19.0; pnpm10.26.0; **PostgreSQL18.6** on disposable localhost:55432 only. No private environment values were loaded or printed.

| Executed group | Result |
| --- | --- |
| Original capture/refund/dispute/settlement suites | 27/63/70/73 passed |
| Foundation / earlier migration / F02 / existing concurrency / B3.1 | 30/5/17/5/44 passed |
| Accepted B.1 evidence / B.1 migration | 64/6 passed |
| R0 admission / R0 migration | **50/6 passed** |
| Original combined PostgreSQL command | **460 passed;13 suites;0 failed;0 skipped;74.551s** |
| New independent classification regressions | **2 failed,1 passed,0 skipped;15.951s**; failures are F1, control preserves genuine Option A |
| Configured-CI environment probe | **1 selected test failed,49 intentionally filtered**; setup error is F2, not a financial assertion |
| Separate unchanged F01 | **6 expected financial failures;0 skipped;13.942s**; names and exact account-difference lines match the author's original results |
| Independent supplement | Seven observed-wait schedules plus independent-scope progress; six negative groups; original contradictory classification observed separately |
| Unit/default tests before review tests | 50 passed;466 database cases skipped |
| Unit/default tests after review tests | **50 passed;469 database cases skipped**;32.457s |
| Lint / typecheck | Passed, including added review fixture after its result typing correction |
| API/web build | Passed after permitted retry of sandbox EPERM writing Next generated output |

The existing50 admission cases include parameterized status/owner variants and isolated SQL/service fixtures; they are not50 complete HTTP-to-financial-application flows. The actual publisher concurrency path was absent from the original schedule helper, which runs its first/second transactions as the worker; the independent supplement exercises the real publication capability. The original same-scope first-use test can block on intake row uniqueness; the additional pre-existing-authority case tests scope serialization explicitly.

The mandatory-obligation tests inspect rollback; privilege cases actually change roles. Some original negatives verify only selected surviving rows, not a complete financial fingerprint. Supplemental snapshots strengthen receipt/proof/enrollment/obligation/resolution preservation and revision rollback. The six migration tests compare original fingerprints and closed gates; their late-error matcher is broad, but final catalog absence/original-row checks also pass. None of these limits excuses F1 or converts a staged reader into a complete financial permit.

## 11. Confirmed findings

### F1 — P1: pending exemption ignores contradictory normalized financial classification

**Location:** `apps/api/drizzle/0007_receipt_admission_foundation.sql`, `receipt_admission_facts`, lines113–117, reached by `publish_admitted_receipt`/`enroll_receipt_admission` and the deferred checker. The customer exemption at lines109–111 already checks normalized type/data; the pending branch does not.

**Violated invariant:** contradictory original/normalized financial evidence must not obtain a harmless/nonblocking admission classification. The approved design section21.5 requires raw/normalized disagreement to retain review. R0 owns this classification today, even though HTTP provenance and financial application are future work.

**Minimal reproduction:**

1. Use the existing signed fixture helper to create a correctly SDK-verified `refund.updated` body with refund status `pending`.
2. Store the same event/inbox identity and signature with normalized type `refund.succeeded` (companion: `refund.failed`) and populated financial data. This models a normalization defect; the original signed bytes remain pending.
3. Under a non-owner role granted **only EXECUTE** on the protected publisher, call `publish_admitted_receipt(inbox, account, raw, verifier)` and commit.
4. From another restricted role call `inspect_receipt_admission` for that account/scope.

**Expected:** publication rejects the mismatch and rolls back its receipt/enrollment/obligation/revision writes, retaining the original inbox for safe review handling. A separately designed blocking-review result would be conservative, but the existing publication API's customer-mismatch precedent is rejection. Correct version1 pending normalization (`provider.unsupported`, JSON-null data) must remain neutral.

**Actual committed state, both variants:**

```json
{
  "publicationRejected": false,
  "receipts": 1,
  "admissions": 1,
  "disposition": "AWAITING_CONFIRMATION",
  "proofs": 0,
  "refundJournals": 0,
  "readerClear": true
}
```

The deferred checker calls the same incomplete classifier and therefore accepts the result. Original normalized data is preserved rather than corrected; the contradiction is silently neutralized in admission. A durable obligation exists, so this is **not a cardinality bypass**. No financial journal, confirmed B.1 proof or live payout was fabricated. The defect is the current SQL admission result for contradictory evidence, and it **blocks R0 acceptance**, not only later R2 activation.

**Smallest correction:** validate version1 pending normalization before granting `refund.pending`/AWAITING_CONFIRMATION. Reject confirmed/otherwise incompatible normalized type/data and preserve the existing genuine pending/Option A behavior. Keep the validation in the SQL classifier so publication and deferred validation share it. Do not rewrite stored payloads, add a pending financial hold, alter0000–0006 or implement an adapter as a workaround.

**Permanent regression:** [receipt-admission-review-regressions.spec.ts](../../apps/api/test/integration/receipt-admission-review-regressions.spec.ts) contains both negative variants and the genuine pending control. Independently executed result:2 red/1 green. It queries actual committed receipts/admissions/disposition/proof/journal and a subsequent reader result; fixture owner privilege is not used to publish. Extend the same contract tests to `requires_action` when correcting the shared pending branch.

### F2 — P2: new admission suite cannot run under the configured CI environment

**Location:** `apps/api/test/integration/receipt-admission.spec.ts:22`; existing `.github/workflows/ci.yml:64`–82 supplies RUN_DB_TESTS and DATABASE_URL but no MIGRATION_ADMIN_URL. The new suite is enabled by RUN_DB_TESTS alone and unconditionally requires the missing variable. The accepted B.1 evidence suite supports the local DATABASE_URL fallback.

**Expected:** the existing PostgreSQL integration job can initialize and execute the new admission suite against its disposable service database.

**Actual:** local reproduction with the same variable shape, selecting one existing admission test, exited1 with `Disposable MIGRATION_ADMIN_URL required`;1 failed/49 filtered. No admission database or financial state was created by this failed preflight. This is confirmed configuration/test delivery breakage, not a hosted CI execution claim or SQL ownership defect.

**Smallest correction:** explicitly supply the disposable service's MIGRATION_ADMIN_URL in CI, or use the established localhost-validated DATABASE_URL fallback in the suite. Preserve local-only host validation and actual database/role capability checks. Do not silently skip admission tests when RUN_DB_TESTS=1.

**Regression:** execute the same selected probe without MIGRATION_ADMIN_URL if adopting fallback, or validate the configured CI job's explicit admin environment and run the full suite with that setup. Hosted PostgreSQL17 remains a separate NOT RUN gate. F2 is distinct from the P1 schema acceptance blocker; it should be addressed before relying on a green integration workflow.

## 12. Remaining R1/R2 dependencies

R1 remains unimplemented: actual SDK-verifying HTTP publisher, authenticated provider/account context, exact version/source attestation, atomic inbox/publication TX, narrowly provisioned login grants, event matrix, duplicate/conflicting delivery retention, separate correlation composition and failed-correlation review publication. The inherited blocked-preflight record remains intact; R0 does not retroactively complete it.

R2 remains unimplemented: policy/mode/epochs/transaction-local permits; claim/disposition fencing; all-writer revision/lock participation; protected historical era/default1/no-downgrade rules; shared proof-reader financial adapters and bidirectional deferred effect/workflow/audit/inbox linkage; complete refund/dispute/capture/zero/duplicate resolution; exception clearance/resume; cohort/candidate recovery and old-worker/session fencing. D02 non-inbox observations/same-obligation linkage and D03 historical unsupported/unverified inventory remain mandatory. F01/F04/F05/F06 remain open.

Correcting F1 needs none of that runtime work. R0 must first classify its own SQL inputs safely.

## 13. Explicit operational limits and final catalogs

| Independent database | Migrations | ACTIVE / enabled accounts | Admissions / obligations / resolutions |
| --- | ---: | --- | --- |
| `fintech_r0_independent_1792311199752` | 8 | 0 / 0 | 0 / 0 / 0 |
| `fintech_r0_admission_428cab7438504cf5a29c3ed4696a9818` | 8 | 0 / 0 | 43 / 42 / 9 |
| `fintech_b32b1_evidence_15e3ab651e854c8fa12eed29bf8c0f67` | 8 | 0 / 0 | 0 / 0 / 0 |
| `fintech_r0_review_extra_176e56df0131473a82be2da124fa4225` | 8 | 0 / 0 | 19 / 19 / 0 |
| `fintech_r0_review_regressions_cae8eb40b8eb43d591491956a0b4cf4d` | 8 | 0 / 0 | 3 / 3 / 0 |

All five also have zero v1/non-NULL financial proof references and the exact reviewed0007 migration hash. Reproduction databases intentionally retain the bad admissions as evidence. UUID migration/probe databases are retained disposable histories, not repaired/deleted data.

**NOT RUN:** PostgreSQL17 (installed directory has data, no executable binaries), hosted CI, actual signed HTTP R1 adapter, real Stripe/test-account API, RabbitMQ, Redis/BullMQ, bank operations, live financial routing, operational credentials/session/restart fencing, production/shared migrations, real history reconciliation and large-history load/lock benchmarks. The local CI-variable probe did execute; it is not hosted CI evidence. Local SDK signature fixtures executed without provider network access. No scope was activated.

## 14. Exact execution results and artifacts

Commands below ran from the repository root unless an API working directory is specified. PowerShell set only disposable/local process environment. No dependency installation or private `.env` access occurred.

Baseline commands: `git status --short`, `git log -4 --format="%H %s"`, `git diff --stat`, `git diff --cached --name-only`, `node --version`, `pnpm.cmd --version`. Preservation/catalog scripts independently compare hashes rather than trusting the implementation record.

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' start -D '.tmp\verification-pg18' -l '.tmp\r0-independent-postgres.log' -o '-p 55432 -h 127.0.0.1' -w
node .tmp/r0-independent-setup.cjs
```

Both exited0; fresh8-migration setup394ms, PostgreSQL18.6. The cluster was initially stopped.

Static/unit/build environment and commands:

```powershell
$env:COREPACK_HOME='C:\Users\Daniel\AppData\Local\node\corepack'
$env:COREPACK_ENABLE_NETWORK='0'
$env:TEMP=(Resolve-Path '.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
pnpm.cmd lint
pnpm.cmd test
pnpm.cmd build
pnpm.cmd typecheck
```

Final lint/unit/typecheck passed. Initial build exited1 on sandbox EPERM creating Next output; the permitted retry passed, then typecheck ran sequentially. After adding review tests, final lint and unit were rerun; default unit execution remains green because it skips DB opt-ins. A targeted review-fixture lint first found an unsafe result member access; only the new fixture annotation was corrected, followed by passing full lint/typecheck. This was a reviewer harness typing issue, not a product correction. Logs use `.tmp/r0-independent-{lint,test,typecheck,build}*`.

Original PostgreSQL command, **from `apps/api`**:

```powershell
$env:TEMP=(Resolve-Path '../../.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
$env:MIGRATION_ADMIN_URL='postgres://fintech@127.0.0.1:55432/postgres'
$env:DATABASE_URL='postgres://fintech@127.0.0.1:55432/'+(Get-Content '../../.tmp/r0-independent-db.txt').Trim()
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/capture-accounting-integration.spec.ts test/integration/refund-accounting-integration.spec.ts test/integration/dispute-accounting-integration.spec.ts test/integration/settlement-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts test/integration/integrated-accounting-verification.spec.ts test/integration/trusted-financial-evidence.spec.ts test/integration/trusted-evidence-migration.spec.ts test/integration/receipt-admission.spec.ts test/integration/receipt-admission-migration.spec.ts --cacheDirectory ../../.tmp/jest-r0-independent --json --outputFile ../../.tmp/r0-independent-pg.json
```

Exit0:460 passed/0 failed/0 skipped. Full output `.tmp/r0-independent-pg.log`; structured counts `.tmp/r0-independent-pg.json`. These are this review's independent results, not inherited author logs.

Separate F01 command, same API environment:

```powershell
$env:RUN_F01_PENDING='1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-r0-independent --json --outputFile ../../.tmp/r0-independent-f01.json
```

Exit1 for six original financial assertions,0 skipped. Exact expected/actual account differences were compared with `.tmp/b2r0-accepted-f01.json` and matched; that author file was used only for comparison, not as substitute execution evidence.

Permanent F1 reproductions, API directory with RUN_DB_TESTS=1 and disposable MIGRATION_ADMIN_URL:

```powershell
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/receipt-admission-review-regressions.spec.ts --cacheDirectory ../../.tmp/jest-r0-independent --json --outputFile ../../.tmp/r0-independent-regressions.json
```

Exit1:2 failed/1 passed/0 skipped. Both failures assert the actual committed mismatch described in F1. Do not weaken those assertions to regain green status.

F2 environment reproduction, API directory:

```powershell
$env:RUN_DB_TESTS='1'
Remove-Item Env:MIGRATION_ADMIN_URL -ErrorAction SilentlyContinue
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/receipt-admission.spec.ts --testNamePattern 'known proof admits exactly one matching scoped obligation and advances revision' --cacheDirectory ../../.tmp/jest-r0-independent --json --outputFile ../../.tmp/r0-independent-ci-env.json
```

DATABASE_URL remained the disposable review database. Exit1:1 selected setup failure/49 intentionally filtered; missing admin URL reported before DB creation. The workflow lacks that same variable. This diagnostic is not included among the460 green cases or the six financial F01 failures.

Supplemental root commands:

```powershell
node apps/api/node_modules/tsx/dist/cli.mjs --tsconfig apps/api/tsconfig.json .tmp/r0-independent-extra.ts
node .tmp/r0-independent-catalog.cjs
node .tmp/validate-docs.cjs
git diff --check
```

The supplement exited0 for its schedule/negative assertions and separately logged the exploratory bad classification observation. Catalog exited0 for preservation/ACL/schema/count assertions, including expected2 failed review regressions and exact unchanged F01 account differences. JSON/logs and setup scripts are ignored `.tmp/r0-independent-*`; the permanent red tests and this report are durable review deliverables. Documentation, whitespace, final marker restoration and cluster shutdown results are recorded in the completion note below.

## 15. Corrective requirements and handoff

1. Correct F1 in the current R0 classifier, preserving immutability and genuine pending Option A neutrality. Leave historical0000–0006 and the original implementation report unchanged. No R1/R2 implementation is needed for this fix.
2. Add `requires_action` and normalized contradiction companions when strengthening the pending guard. Preserve both review negatives and the control. Re-run the original460 plus all3 review cases: **at least463 must pass**, plus newly added companions, with zero skips in that command. Keep the six original F01 failures separate.
3. Address F2's disposable-admin environment/fallback without removing the locality check or silently skipping tests. Re-run its environment-shaped diagnostic and document the chosen CI setup; do not label PostgreSQL17/hosted CI passed without execution.
4. Re-run relevant static/build/docs/preservation checks and seek a focused independent re-review before declaring R0 accepted or committing it. The otherwise sound obligation/lock/role mechanisms do not need a broad rewrite.

No accounting scope activation, runtime financial routing change, financial source fix, R1/R2 adapter, staging, commit or push occurred in this review. The next step is a small R0 corrective run followed by re-review, with all activation and operational dependencies still closed.

Completion note: final `node .tmp/validate-docs.cjs` passed **43 Markdown files and539 relative links/anchors**, plus CI YAML parsing/structure;19 existing Mermaid blocks were extracted without parsing/rendering. `git diff --check` passed. `node .tmp/r0-independent-finish.cjs` passed newline/trailing-whitespace checks for all7 untracked deliverables and verified an empty index. Final root typecheck and full lint passed after the review fixture's typed-query correction. The catalog recheck confirmed all14 initial file contents preserved after excluding exactly the new review navigation line, unchanged0000–0006/seven earlier journal entries, zero ACTIVE/enabled/v1 states and expected independent green/red counts. The two author suite database markers were restored; independent markers/JSON/logs retain this review's database identities. `pg_ctl.exe stop -D .tmp\verification-pg18 -m fast -w` exited0, restoring the original stopped cluster without deleting history. Final review changes are this report, its index link and the three-case regression file; the author's R0/R1 records and all financial implementation files remain unchanged.

## 16. Author response — R0.1 correction (2026-10-18)

**Author response only: READY_FOR_RE_REVIEW. The independent REQUEST_CHANGES verdict and §§1–15 above are unchanged. This is not independent acceptance.** Full corrective evidence and exact commands are appended in [R0 implementation §13](h1-fix-02-b3-2-b2-r0-admission-foundation.md#13-r01-author-correction--admission-classification-2026-10-18).

- **F1 confirmed:** ran the original three-case file unchanged before SQL edits. Both negatives failed with committed AWAITING_CONFIRMATION/clear reader; genuine pending passed (`.tmp/b2r01-before.json`). Classification now checks normalized terminal/data contradictions before the pending exemption, reuses B.1 confirmed financial validation and also compares present providerStatus. Contradictory input atomically retains receipt, immutable review and unknown-owner BLOCKING_REVIEW with an intake revision increment. Deferred validation requires that review/blocker. Retry/DEAD, rollback, ordinary direct SQL, stale revisions and unproved clearance cannot remove it. Genuine pending/requires_action remain Option A neutral; another account and genuine nonfinancial customer events remain clear.
- **Test-oracle distinction:** the original negatives expected rejection, zero retained receipts/admissions and a clear reader. The requested R0.1 contract instead requires retention plus a blocked reader. Their original fixtures/names are retained; assertions explicitly require one retained receipt/admission, BLOCKING_REVIEW, linked immutable contradiction review, no proof/journal and a reader refusal. This is an intentional contract correction, not a claim that the original rejection assertions passed unchanged. The unchanged baseline snapshot/results remain in ignored artifacts and the findings above. The original control is preserved;28 companions bring this file to31 passing tests.
- **F2 corrected:** only the existing disposable PostgreSQL CI job gains its local service MIGRATION_ADMIN_URL and RUN_MIGRATION_TESTS=1. No Node job change, fallback or silent skip. Local fixture roles remain separate from restricted-role assertions. A separate empty eight-migration database and its two unique non-login owners were created/removed successfully; existing financial histories remain retained. Suites close clients; CI service disposal is the database/role cleanup boundary. Hosted PostgreSQL17 was not executed.
- **Executed results:** final required PostgreSQL matrix **491 passed /14 suites /0 skips**; separate six original F01 financial failures retained; lint/typecheck,50 units and Nest/Next builds pass. Default unit execution skips497 DB opt-ins, exercised separately. Catalogs confirm8 migrations, exact corrected0007 hash, four storage models, pinned/restricted functions, no ledger writes and zero ACTIVE/enabled accounts. Historical0000–0006, B.1, original F01 source and R1 preflight are preserved. Final docs/whitespace/preservation results appear in the implementation completion note.

Please re-review the retained classification evidence/deferred guard, exclusive account lock selection, immutable review INSERT capability, stronger retained-blocker assertions and CI migration opt-ins. R1/R2 runtime integration, account/claim/policy/admission permits, all-writer fencing and financial disposition contracts remain separate gates. F01/F04/F05/F06 remain open. No activation, commit or push.
