# H1 Fix 02 — B3.2 B.1 independent trusted evidence review

Status: completed independent defensive engineering and financial correctness review. Reviewed **2026-10-18**.

Verdict: **APPROVE_DORMANT_B1_CHECKPOINT**.

B.1 is safe to preserve in a commit as an isolated, dormant schema checkpoint. The installed SQL supports later B.2 evidence adapters and preserves the tested original financial invariants. This acceptance permits neither runtime integration nor activation. D01 is implemented as a database projection, not as an operational receipt-to-financial-application contract. **F01/F04/F05/F06 remain open.** No commit or push was performed.

## 1. Starting baseline and complete diff

Reviewed `main` at `b8658f4893c4dc8b69094471d7c54745253b8725`, the approved human-decision commit itself. Its ancestor check succeeded. The initial worktree already contained **13 implementation files**, eight tracked modifications and five untracked files; the index was empty. The request's initial 14-file count differs from the actual checkout and the author's final 13-file inventory. No missing implementation file was inferred from that count.

Read AGENTS.md, CLAUDE.md, README, package scripts, documentation index, AGENT_START_HERE, AI_WORKFLOW, the B3.2 proposal/corrective contract, independent design acceptance, human decisions and B.1 implementation record. Consulted database, ledger, concurrency, refund/dispute, settlement/payout, security and verification owners. Inspected the entire 598-line migration, journal append, Drizzle additions, both new suites, shared fixture, three existing test diffs and related receiver, normalizer, processor, command-result/mirror and dormant financial paths. Searches found no runtime call to the new SQL routines and no new module registration.

The implementation diff is:

| Files | Reviewed change |
| --- | --- |
| `apps/api/drizzle/0006_trusted_financial_evidence.sql` | Six evidence relations; publisher validation; builder/reader/sealer; immutable protections; closed references; restricted function owner |
| `apps/api/drizzle/meta/_journal.json` | Seventh entry only; index6 and timestamp1792281600000 |
| `apps/api/src/database/schema.ts` | Additive evidence declarations and closed allocation references |
| `apps/api/test/integration/trusted-financial-evidence.spec.ts` | 64 evidence cases |
| `apps/api/test/integration/trusted-evidence-migration.spec.ts` | Six migration cases |
| `apps/api/test/support/trusted-evidence-fixtures.ts` | Explicit local SDK verification and SQL publisher fixtures |
| Capture migration, integrated verification and settlement integration specs | Migration-count/title updates only; financial assertions preserved |
| `docs/README.md`, `docs/database-design.md`, `docs/verification.md`, B.1 implementation record | Navigation, schema and verification documentation |

An independent SHA-256 manifest verified all 13 initial files byte-for-byte before adding review navigation. Git-normalized comparisons verified SQL0000–0005, original design/review/decision documents and the F01 test unchanged from HEAD. All six earlier journal entries are unchanged. This run adds this review and one index link. The original implementation report remains unchanged. Review scripts, logs, caches and disposable histories are ignored under `.tmp/b1-independent-*`.

## 2. Acceptance scope and verdict rationale

There is no confirmed P0/P1 B.1 blocker. Acceptance depends on an **enforced closed foundation**, not on the readiness routine's name or a feature flag:

- The existing scope CHECK permits only FOUNDATION_ONLY/REVIEW_REQUIRED. The disconnected financial services still require ACTIVE unless a test subclass deliberately substitutes dormant admission.
- All configured evidence accounts are constrained to immutable UNINSTALLED.
- Refund and hold proof revisions must be NULL; dispute open/close inbox/revision references must all be NULL. Their contract versions are NOT NULL and constrained to0. No version1 reference can commit.
- The new readiness routine always raises. It is supplemental documentation/API protection; the CHECK/NOT NULL constraints and missing ACTIVE state are the actual structural boundary.
- No production receiver, consumer, dispatcher or financial adapter invokes this new contract.

Version0 remains available to legitimate current legacy/dormant-fixture writes. It is **not a protected historical era stamp**, proof of old age, eligibility or new-policy authority. This is acceptable only at this closed checkpoint. Opening it needs a separately reviewed forward migration installing the protected era/default1 guards and complete SQL/application contract together. Simply relaxing these CHECKs would invalidate this acceptance.

## 3. Forward migration integrity

[0006](../../apps/api/drizzle/0006_trusted_financial_evidence.sql) is additive and transactional. It replaces no existing financial function. In particular, 0004's `prepare_capture_allocation_write`, `check_capture_allocation_effect`, capacity checks, cumulative fee quotient, original-journal checks, parent version writes, whole-operation/common-journal rules and uniqueness remain installed. F02 functions and triggers remain unchanged.

Independent fresh installation of all seven migrations succeeded in **327ms** on PostgreSQL18.6. The six permanent migration regressions independently passed: empty/repeated install, populated0005 upgrade, compatible post-install legacy writer, retained orphan evidence without promotion, late-error rollback and observed maintenance-DDL blocking. The rollback case compares original rows/function definitions and verifies removal of the added columns, evidence relation and newly created non-login role while retaining six migration records. This is failure-before-commit rollback, **not a supplied down migration after successful installation**.

The permanent populated-upgrade case covers finalized refund evidence and an unapplied historical inbox. An additional independent probe staged unchanged0000–0005, then used actual dormant services/test admission plus one explicit PLANNED fixture to populate:

- RESERVED, CONFIRMED and RELEASED refunds;
- PLANNED, OPEN and CLOSED dispute allocations;
- an actual refund-caused hold adjustment;
- pending and finalized settlement candidates, POSTED originals, audit, inbox, outbox and idempotency records.

Upgrade preserved fingerprints across **17 tables**, excluding only the six newly added allocation metadata fields. One hold effect and all six allocation states remained present. No receipt, proof or ACTIVE scope was manufactured. Previously valid historical evidence remains under its original contract; invalid/orphan/unverifiable history is retained without promotion. No DELETE, monetary repair or financial backfill is part of0006.

**Installation risks:** lines6–7 explicitly acquire ACCESS EXCLUSIVE on inbox and the three allocation/effect tables, blocking reads and writes until commit. Added CHECK/FK validation and ordinary index builds can scan existing allocation history. Foreign-key creation also locks referenced relations; the four explicit tables are not the entire DDL lock set. Constant default0 does not imply a full monetary rewrite. CREATE ROLE/GRANT/ownership operations touch cluster catalogs and require an administrative migration identity with the necessary role/function ownership authority. `lock_timeout=10s` bounds individual lock waits, not total scan/install time. Drain writers and install transactionally; no zero-downtime or large-history timing claim follows from the small fresh fixture. Successful migration rollback means retaining additive schema when reverting application code, not deleting financial history.

## 4. Immutable receipt and sealed proof

The receipt relation stores exact original `bytea`, signature, transport headers, separate normalized JSON, normalization version, method/version attestation and received/verified times. It does not reconstruct bytes from JSON. Publication locks the original inbox, matches its stored provider/signature/headers/payload and changes its MVCC row version without changing the timestamp value. Existing provider-event uniqueness and original payload protections remain intact. Referenced inbox identity cannot be deleted/retargeted past its FK.

All six new relations reject UPDATE/DELETE and statement-level TRUNCATE. The permanent tests exercise all three operations with actual rows. Restricted-role probes additionally refused proof/binding updates, proof deletion/truncation and observation insertion, checking the saved proof after each failure. Receipt retention leaves ordinary processing status/lease updates available; a legacy status-only role needs no SELECT on private receipt storage. These are immutability guarantees, not a new claim-generation/disposition state machine: the original processor's stale failure bookkeeping remains a B.2 dependency.

The proof primary key gives one authority per inbox; revision1/contract1 and validator version are fixed. Sealing accepts reference IDs and expected attempt revision, not arbitrary merchant/payment/amount or VERIFIED booleans. Binding/proof creation is atomic. Identical concurrent seal attempts return the same proof; conflicting ownership aborts, preserving original receipt/owner/proof. Reviews have append-only identity and idempotent inbox/review keys. The sealer does not automatically persist every failure classification: B.2 must record reviews safely after an aborted transaction and atomically maintain admission blockers.

Keep these four propositions separate:

| Proposition | B.1 evidence |
| --- | --- |
| A receipt row declares SDK verification | Stored method/version and restricted publisher input |
| The trusted receiver really verified those bytes | Locally executed SDK fixture only; deployed publisher **not implemented** |
| A trusted owned correlation proof exists | Restricted sealer plus original/canonical SQL comparisons, immutable sources and binding |
| Current admission permits a financial application | **Unavailable in B.1**; neither receipt nor proof grants it |

PostgreSQL does not verify Stripe HMAC or authenticate a remote command result. Historical normalized events without retained raw bytes do not automatically receive attestation. The local test signing secret and publisher are explicit fixtures, not evidence of a deployed publisher.

## 5. Trusted provider-object ownership

The unique `(provider, provider_account, object_kind, provider_object_id)` binding and composite payment/merchant/currency/refund FKs enforce account-scoped immutable ownership. Sealing compares operation principal and owner against an existing binding instead of updating it. Capture PaymentIntent is deliberately not unique per attempt. Permanent tests retain two original capture journals for one PI and reject wrong owner, amount, currency, PI/Charge, exact-object witness and conflicting owned mirrors.

Refund proofs require an accepted refund, canonical outbox/key, exact amount/currency and complete frozen refund allocations backed by valid original capture lots/journals and trusted capture-command observations. A signed refund UUID can establish the accepted chain without a refund result; when absent, an exact immutable COMMAND_RESULT witness is mandatory. A PROVIDER_LOOKUP or latest PI/amount mirror cannot substitute. Conflicting exact-object owner witnesses reject sealing. Publisher validation checks stored accepted commands, not a caller's replacement trusted values.

Disputes use signed `dp_` identity and uniquely owned capture PI/Charge evidence, with no invented dispute command. Existing dispute principal, scope and terminal outcome must agree. First-open proof can lack an internal dispute UUID. Trusted observations supply the provider/account chain; current commands do not independently authenticate a remote account without the future publisher.

Permanent cross-scope tests gate both account-lock orders and retain one owner plus a review. Additional independent probes rejected assigning the same object to another refund **on the same payment**, preserving the first proof and leaving no second proof. They also accepted equal external IDs under two separately configured/authenticated fixture accounts, retaining two account-scoped bindings. Different-account IDs are not globally conflated. Currency/owner incompatibility is rejected by accepted evidence comparisons and the single account/object binding, not by mutable mirror status.

New contradictory observations and current mirror/outcome conflicts must participate in B.2 admission, even when a historical immutable projection still reads successfully. The projection is not an up-to-date clearance certificate. Runtime conflict classification, publisher source-key discipline and obligation linkage remain deferred.

## 6. Shared SQL projection and Drizzle agreement

Inspected `financial_receipt_facts` (line183), `build_financial_evidence` (305), `load_effective_financial_evidence` (419) and `seal_financial_correlation` (475). The allowlist derives supported refund success/failure or dispute open/close from retained raw event/object/status. Pending/unsupported outcomes cannot be made successful merely by a normalized label. Original explicit IDs/references remain constraints, including when normalization returned unsupported.

The reader rejects missing/wrong inbox, revision and operation, NULL arguments, original/proof/binding event/object/owner/amount/currency disagreement, absent required immutable provenance and incompatible account/owned sources. The caller supplies identity selectors; comparison facts come from stored receipts, bindings, observations, lots and POSTED originals. Capture source amounts are decimal strings in JSON and bigint in SQL. Numeric type/integrality/positive/safe-bound checks precede amount use; malformed UUID/reference/numeric casts fail the transaction, not a permissive fallback. Conditional proof shape uses `IS TRUE` where nullable SQL expressions otherwise permit unknown.

Capture JSON references are validated by the checked builder/reader rather than element-level FKs. Referenced lots, original journals and observations have immutability/deletion protection. The ordinary role cannot insert arbitrary source JSON into a proof. Historical reads intentionally avoid recomputing proof from today's mutable mirror. The reader does not validate current permit, workflow prerequisites, application amount against an arbitrary caller operation, or final effects; B.2 adapters and SQL constraints must compare their actual owned operation/effects with the returned tuple.

Drizzle columns, nullability, bigint/bytea representation and closed proof-reference tuples agree with the migrated storage. Declarations are **not a complete alternate DDL specification**: e.g. the new observation declaration omits SQL's positive amount/currency/status/version checks; object-owner declaration omits SQL's positive amount check; proof declaration omits its detailed operation/refund/dispute/outcome conditional CHECK. Index/constraint names also differ in places. SQL enforces these today; schema generation/push is not an accepted installation path. This is a nonblocking declaration-parity limitation, not evidence those SQL checks are absent. Before schema-derived tooling is relied on, mirror those scalar/shape checks or document their SQL-only ownership explicitly.

| Integration boundary | Current state |
| --- | --- |
| Database builder, sealer and effective projection | Implemented and independently SQL-tested |
| Receiver/result publishers and financial service adapters | Not implemented; fixture publishers only |
| Replaced immediate/deferred financial readers and complete disposition/application linkage | Not implemented; original0004 validators remain, new references closed |
| Dispatch/claim/permit/policy/epoch/intake spending integration | Not implemented; runtime remains legacy |

D01 is therefore database-foundation progress; it is not fully operational.

## 7. Privilege boundary and publisher limitations

Migration lines565–598 create a per-database non-login, non-inheriting, non-superuser/non-CREATEROLE/non-CREATEDB/non-BYPASSRLS owner. Only the sealer and header guard are SECURITY DEFINER. All nine new routines pin `pg_catalog, pg_temp`, qualify persistent references and revoke PUBLIC execution. New table PUBLIC rights are revoked. No ordinary worker/publisher login grants or existing credential memberships are installed.

The sealer owner receives needed historical SELECT, binding/proof INSERT and limited timestamp-column UPDATE grants needed by PostgreSQL row-locking SELECTs. It loses temporary schema CREATE authority after ownership transfer. Independent catalog checks in four databases verified nine routines, two definers, pinned paths, no PUBLIC EXECUTE, safe role attributes, no schema CREATE and **no INSERT/UPDATE/DELETE/TRUNCATE rights on ledger headers, entries or accounts**. The tested worker is not a member of that owner role. A sealer's ability to read original financial evidence is necessary and is not ledger write authority.

The permanent suite actually uses SET LOCAL ROLE for a restricted publisher, sealer/reader worker and status-only legacy worker. Positive publication/sealing/reading runs under those roles; unauthorized receipt/proof/binding insertion and PUBLIC sealer access fail. Independent probes additionally verify unchanged committed proof after five denied mutations and reject three NULL selector variants. Admin/superuser rights are used to create disposable databases/roles and canonical fixtures, not to stand in for these authorization assertions.

This proves the tested SQL role capabilities after explicit fixture grants, **not production credential isolation or tenant-facing authorization**. Actual publisher credentials, narrowly reviewed operational grants, source authenticity/version mapping, default-privilege inventory and old-worker/session fences are B.2/operational work. An app still using an owner/superuser login is outside this guarantee. A trusted publisher can lie about remote verification; the database cannot turn that trust assumption into cryptographic proof.

## 8. Repeatable-read receipt/header race

The author's retained failing report has one failed case: a stale RR writer committed a changed inbox header after receipt publication. This review independently reproduced that result by replacing only the publisher trigger's parent UPDATE with a no-op **in a separate disposable review database**, then restoring its exact installed definition. Source migration0006 was never altered.

Original schedule: H establishes a RR snapshot containing the inbox and no receipt; R locks the parent and commits an immutable receipt with `{}` headers; H changes headers to `{"stale":true}`. A row lock alone created no new parent version. H's receipt query used its old snapshot, saw no receipt and committed. Actual result was a retained receipt with `{}` alongside a mutated parent header. The reader correctly refused their disagreement, but original receipt/header consistency had already been lost.

The corrected publisher first owns the inbox, then performs `UPDATE webhook_events SET updated_at=updated_at`, before account SHARE. That write creates a parent tuple version while retaining its exact timestamp and original fields. Under RR, the stale updater can no longer modify the parent after that later committed version. PostgreSQL documents this distinction between a lock and an actual concurrent update in [repeatable-read semantics](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-REPEATABLE-READ).

Independent fixed schedules used restricted roles, distinct backend PIDs, promise gates, bounded statement timeouts and observed `pg_blocking_pids`:

| Order | Observed and committed result |
| --- | --- |
| Receipt first, held uncommitted while stale RR writer attempts UPDATE | Actual parent wait; receipt commits; writer fails **40001**, not40P01/23505; exact inbox fields/timestamp remain unchanged and raw receipt bytes survive |
| Header first, held uncommitted while receipt publisher attempts INSERT | Actual parent wait; header commits; publisher's stale header snapshot is rejected and its receipt/parent-version write rolls back; retry with exact stored headers commits |

The permanent regression also independently passed. These schedules establish expected serialization failure/retry and orderly rejection, not timing-induced apparent success. No deadlock or uniqueness error was accepted as equivalent. Gates were finally released and started transactions awaited.

The additional write reuses an inbox row already locked before account/financial locks; it adds no provider-owner/payment acquisition. Current inbox triggers add no timestamp setter/audit side effect, and the header-only guard is not fired by naming only `updated_at`. No new inverse dependency was identified within the tested receipt/sealer prefix. Existing legacy reverse edges and invoking the self-locking sealer after intake SHARE/scope locks remain incompatible with live partial adoption. **Universal deadlock freedom is not claimed.** This is a useful casebook candidate: row locking alone does not invalidate a stale parent snapshot; retain the before/after committed-state evidence before making a separate casebook entry.

## 9. Historical compatibility and financial enforcement

Historical finalized rows cannot change their originals under the existing protections. Valid old rows need no fabricated proof. NULL version, explicit version1 and version0 with a proof reference reject; transaction snapshots verify journal/financial rollback for the permanent version tests. Direct legacy format0 writes continue to use the original strict0004 checks. Existing dormant service tests retain their financial assertions and use deliberate admission overrides, never stored ACTIVE scopes.

No v1 success/failure/dispute/hold path is partially enabled. Composite proof FKs currently have NULL reference components; their future operation/cause/group/application semantics are not tested by pretending the closed references are usable. A bare ledger writer remains subject to original ledger invariants, not a newly installed whole-effect/application validator. Such legacy capability is not new-policy authorization. Current code has no selectable new policy and scope constraints prohibit the services' normal admission.

Before permitting any new-policy durable intent/candidate/application, B.2 must prohibit caller-created historical versions and downgrades, install shared-reader financial validation and bidirectional deferred linkage (including entirely absent application groups), and coordinate every writer. A valid proof followed by an unrelated ordinary legacy journal is not a tested v1 financial lifecycle. This explicit staging boundary preserves the approved dormant checkpoint without approving a default0 bypass at activation.

## 10. Independent regression evidence matrix

Environment: Windows, Node24.19.0, pnpm10.26.0, **PostgreSQL18.6**, local disposable cluster bound to127.0.0.1:55432. No private environment file was loaded or printed.

| Executed group | Passed | Failed / skipped | Meaning |
| --- | ---: | --- | --- |
| Capture integration | 27 | 0 / 0 | Actual current capture transaction compatibility |
| Refund integration | 63 | 0 / 0 | Original dormant financial assertions retained |
| Dispute integration | 70 | 0 / 0 | Original dormant effects/prerequisites retained |
| Settlement integration | 73 | 0 / 0 | Original dormant finalization/replay/locking retained |
| Foundation | 30 | 0 / 0 | Capacity, fee, group and evidence constraints |
| Earlier migration suite | 5 | 0 / 0 | Existing migration/history behavior |
| F02 immutability | 17 | 0 / 0 | Original sealing, deferred and snapshot checks |
| Existing concurrency | 5 | 0 / 0 | Existing financial races |
| B3.1 integrated | 44 | 0 / 0 | Integrated dormant evidence, including known admission-gap reproductions |
| New trusted evidence | 64 | 0 / 0 | SQL fixtures, real local SDK signatures, roles and controlled sealing waits |
| New migration | 6 | 0 / 0 | Fresh/upgrade/rollback/maintenance boundary |
| **Green PostgreSQL total** | **404** | **0 / 0** | 334 accepted +64 evidence +6 migration, independently rerun |
| Legacy F01 opt-in | 0 | **6 expected financial failures / 0** | Same six case statuses as author's report; original assertions unchanged |
| Default `pnpm test` | 50 unit | 0 / **410 DB skipped** | 12 unit suites passed; web test script is a notice |
| Lint, typecheck, API/web build | All passed | None | Independent final code checks |
| Additional reviewer probes | R0 reproduced; R1–R6 passed | No final probe failure | Both RR orders; denied mutations/NULLs; same-payment refund conflict; distinct accounts; zero activation |
| Populated upgrade supplement | Passed | None | 17 table fingerprints, all allocation states/hold effect and settlement history |

The 64 cases include parameterized input variants and one immutability case per table, not 64 independent end-to-end financial scenarios. Snapshot/refusal helpers compare journals, entries, lot, payment, refund, allocations and audit; rollback cases check absent proof/binding/original survival. Some negative/immutability cases assert exceptions without a complete table-by-table fingerprint. Independent committed-proof checks strengthen that boundary, but this is not exhaustive statement-fault injection.

Concurrency tests observe blockers and await settled outcomes; short delays are bounded polling, not the synchronization oracle. Cross-scope ownership contenders in this implementation serialize on the account UPDATE before reaching the unique binding. Thus those tests do **not separately exercise a unique-index wait**; uniqueness remains a schema backstop. Immutable review insertion after a conflict is explicit fixture work, not a deployed automatic review lifecycle. Pending evidence is placed in a separate database so legacy global inbox pollers cannot consume it.

The six migration cases alone do not cover every old allocation lifecycle; the independent populated upgrade supplement addresses that concrete gap. No test expectation was changed to make a suite pass. These counts must not be called complete E01–E28 or receipt→dispatcher→service→journal evidence.

## 11. Confirmed findings and limitations

**No confirmed financial correctness or privilege defect blocks this dormant checkpoint.** No financial source correction was made.

| Review observation | Classification and smallest follow-up |
| --- | --- |
| Drizzle does not repeat every new SQL CHECK | Nonblocking representation limitation; SQL remains authoritative and generation/push remains prohibited. Align declarations before schema-derived DDL is used; not a current committed-database bypass |
| No live receipt/result publisher or current permit/disposition enforcement | Explicit B.2 dependency, not a claim of completed runtime isolation/application |
| Some required application/cause/composite-FK negatives cannot reach their checks because v1 is closed | Activation gate: test them after the full forward contract is installed; closed-reference errors cannot stand in for those tests |
| Conflict review, source-key lifecycle and current contradictions are not automatically handled by the sealer | B.2 must preserve observations and block admission without overwriting truthful historical proof |
| Header race test in the implementation covers one original order | Independently supplemented with both observed orders and reproduced original committed failure; no remaining race blocker found |

The request's finding fields (severity, violated invariant, minimal reproduction, committed bad state, correction and blocking gate) would apply to a confirmed defect. The original header defect is documented above as independently reproduced historical behavior, **already corrected in the reviewed0006**, not a new open finding. No owner/superuser resistance is claimed.

## 12. Mandatory B.2 dependencies

1. Implement trusted signed-byte/attestation and immutable command-result/reconciliation publishers with reviewed source identity/version, restricted credentials and grants. Test actual HTTP receiver and duplicate/conflicting event handling.
2. Finish **D02**: confirmed non-inbox observations block relevant admission before a webhook; a later genuine callback/proof/application links and clears the same obligation. Pending/unknown Option A intent is not a fabricated posted hold; note-only resolution is insufficient.
3. Finish **D03**: inventory old unsupported/ignored/incomplete history. Missing raw bytes/ownership remain historical/untrusted and excluded until reviewed recovery; do not reconstruct authenticity.
4. Add current intake/scope policy/mode/epochs/claims, scoped/unknown blockers and coordinated dispatcher/lock floor. Preserve returned dispositions and conditional failure bookkeeping.
5. Adapt refund/dispute/hold services and immediate/deferred SQL to the same reader and exact inbox/revision. Install protected historical-era guards/default1 and complete operation/cause/amount/group/journal/workflow/audit/inbox linkage **in both directions**, including zero/no-effect and missing-group cases.
6. Use this sealer before its own lock prefix in a separate correlation transaction, followed by fresh admitted reader/application, or separately review a coordinated replacement. Do not call it after shared intake/A/S and create a lock upgrade.
7. Preserve frozen fee/source/ownership, accepted/provider keys and replay. Recheck newly conflicting immutable observations/current owned evidence before applying money without invalidating truthful historical proof merely because mirrors changed.
8. Complete separately reviewed F05/F06 corrections, actual F04 writer races, cohort eligibility, conservative candidate recovery and old-binary/session fencing before activation. Passing dormant accounting tests does not close legacy F01.

## 13. Unverified operational boundaries and final catalogs

| Independently inspected database | Migrations | ACTIVE | Non-UNINSTALLED accounts | Receipts / proofs |
| --- | ---: | ---: | ---: | ---: |
| `fintech_b1_independent_1792297129106` | 7 | 0 | 0 | 0 / 0 |
| `fintech_b32b1_evidence_9af8c4b907a04252b7d5375d4a784efd` | 7 | 0 | 0 | 66 / 35 |
| `fintech_b1_review_extra_21fce806e3954bc79a68e44e596a838c` | 7 | 0 | 0 | 6 / 2 |
| `fintech_b1_review_upgrade_0c1bd0e6770b4e578375f557e633f8c0` | 7 | 0 | 0 | 0 / 0 |

All four also have zero refund/dispute/hold v1 or non-NULL proof references. The extra database intentionally retains the old-race reproduction's unsealed inconsistent parent/receipt as review evidence; the original publisher definition was restored before fixed probes. It is not trusted financial application history. Other UUID migration/probe databases are disposable retained artifacts, never production data.

**NOT RUN:** PostgreSQL17 (installed directory contains data but no executable binaries), hosted CI, actual signed HTTP publisher/dispatch flow, real Stripe/test-account provider verification, RabbitMQ, Redis/BullMQ, deployment, shared/production migrations, production credentials/session fencing, real history inventory and large-history lock/scan benchmarks. CI configuration targets PostgreSQL17 but its migration-suite opt-in is not set; a configured job is not a passed migration acceptance run. Local SDK fixture verification did execute without provider network access.

## 14. Exact executed commands and results

All commands ran from the repository root. PowerShell was used for scoped environment setup, redirects and local process control. No new dependencies were installed. Local role/DB changes were confined to the disposable test cluster. Its initial stopped state was restored after verification; histories and logs were retained.

Common pnpm environment:

```powershell
$env:COREPACK_HOME='C:\Users\Daniel\AppData\Local\node\corepack'
$env:COREPACK_ENABLE_NETWORK='0'
$env:TEMP=(Resolve-Path '.tmp\b1-independent-temp').Path
$env:TMP=$env:TEMP
```

Baseline/environment commands: `git status --short`, `git log -1 --format="%H %s"`, `git merge-base --is-ancestor b8658f4 HEAD`, `git diff --stat`, `git diff --numstat`, `node --version`, `pnpm.cmd --version`. All succeeded; hashes/counts are recorded above.

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' start -D '.tmp\verification-pg18' -l '.tmp\h1-b32b1-independent-postgres.log' -o '-p 55432 -h 127.0.0.1' -w
node .tmp/b1-independent-setup.cjs
```

Final start/setup succeeded: fresh database, seven migrations, PostgreSQL18.6,327ms. An initial start used `.tmp/verification-postgres`, an incomplete historical directory, and failed for missing `pg_control`. The correct `.tmp/verification-pg18` sandbox start was interrupted; initial connection attempts returned EACCES/ECONNREFUSED. Permitted localhost execution and cluster recovery completed before tests. No data directory was deleted or repaired. The administrative start eventually returned0 after recovery; successful connection/setup established readiness.

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
```

All exited0. Logs: `.tmp/b1-independent-{lint,typecheck,test,build}.log`. Default test:50 passed,410 skipped. No dev service, worker or provider consumer was started.

Green PostgreSQL execution:

```powershell
$env:DATABASE_URL='postgres://fintech@127.0.0.1:55432/'+(Get-Content .tmp/b1-independent-db.txt).Trim()
$env:MIGRATION_ADMIN_URL='postgres://fintech@127.0.0.1:55432/postgres'
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
pnpm.cmd --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-integration.spec.ts test/integration/refund-accounting-integration.spec.ts test/integration/dispute-accounting-integration.spec.ts test/integration/settlement-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts test/integration/integrated-accounting-verification.spec.ts test/integration/trusted-financial-evidence.spec.ts test/integration/trusted-evidence-migration.spec.ts --cacheDirectory ../../.tmp/jest-b1-independent --json --outputFile ../../.tmp/b1-independent-pg.json
```

Exit0:11 suites,404 passed,0 failed,0 skipped;65.803s. Full output `.tmp/b1-independent-pg.log`, structured report `.tmp/b1-independent-pg.json`.

Separate unchanged F01 execution with the same disposable DATABASE_URL:

```powershell
$env:RUN_DB_TESTS='1'
$env:RUN_F01_PENDING='1'
pnpm.cmd --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-b1-independent --json --outputFile ../../.tmp/b1-independent-f01.json
```

Exit1 as expected:6 financial assertion failures,0 skipped;15.944s. Compared the six names/statuses with the author's saved run. No setup/permission error was counted as a financial regression.

Independent supplemental commands:

```powershell
node apps/api/node_modules/tsx/dist/cli.mjs --tsconfig apps/api/tsconfig.json .tmp/b1-independent-extra.ts
node apps/api/node_modules/tsx/dist/cli.mjs --tsconfig apps/api/tsconfig.json .tmp/b1-independent-upgrade.ts
node .tmp/b1-independent-catalog.cjs
```

Final runs exited0. JSON/logs under the matching `.tmp/b1-independent-*` prefix record the original-race reproduction, both fixed orders, role/NULL and ownership probes,17-table upgrade and four-database ACL/catalog/preservation checks. Initial reviewer harness runs failed on a root-level `reflect-metadata` import, an unquoted camel-case SQL alias and fingerprint ordering that assumed an `id` on a composite-key table. Only ignored harness code was corrected; financial implementation and expected outcomes were unchanged. A catalog matcher was narrowed to count six SQL files separately from snapshot metadata. These harness failures are not product defects.

Documentation/whitespace/preservation verification and final cluster shutdown are recorded in the completion note below. Official PostgreSQL18 [locking](https://www.postgresql.org/docs/18/explicit-locking.html) and [function security](https://www.postgresql.org/docs/18/sql-createfunction.html) documentation were consulted for the lock/privilege interpretation; executed local results are the primary acceptance evidence.

## 15. Corrective actions and handoff

No B.1 financial correction is required before a dormant checkpoint commit. Recommended conventional message:

```text
feat(accounting): add dormant trusted financial evidence foundation
```

Preserve0006, the existing financial assertions and this independent review together. Before any B.2 activation-facing work, obtain its checkpoint-specific authorization and enforce the dependencies in section12. The declaration-parity follow-up can be handled surgically; it does not authorize schema generation or migration-history edits. Do not call this production readiness, close F01/F04/F05/F06, activate scopes, implement B.2, commit or push as part of this review.

Completion verification: `node .tmp/validate-docs.cjs` passed **40 Markdown files and516 relative links/anchors**, plus CI YAML parsing/structure. It extracted19 existing Mermaid blocks; no diagram parser/rendering was run and no diagram was added. `git diff --check` passed; `node .tmp/b1-independent-finish.cjs` checked final newline/trailing whitespace on all six untracked deliverables and inspected all six F01 expected/actual financial differences. Final catalog checks also compared built Drizzle column names/nullability with all six migrated evidence tables. All13 initial file contents remain preserved after excluding exactly this run's one docs-index navigation line; the original implementation report is byte-identical. The permanent suite's ignored author database marker was restored and the review database marker retained separately. `pg_ctl.exe stop -D .tmp\verification-pg18 -m fast -w` exited0, restoring the cluster's original stopped state without deleting history. Final review changes are this document and its index link only; no source fix, staging, commit, push or activation occurred.
