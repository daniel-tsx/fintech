# H1 Fix 02 — B3.2 B.2-R2-A: shared financial application foundation

Current checkpoint: **R2-A.2 ownership correction drafted — BLOCKED_BY_FINANCIAL_OWNERSHIP_CONTRACT**, 2026-10-20. Local PostgreSQL access returned EACCES; corrected database behavior is unverified. See §23 for this run's changes and execution limits. The [independent REQUEST_CHANGES report](h1-fix-02-b3-2-b2-r2-a-independent-review.md) and its four failed ownership regressions remain unchanged. The failed R2-A record, R2-A.1 correction/evidence and §22 review history remain preserved; historical READY wording does not represent acceptance. No shared/production installation, commit, push, activation or R2-B work is authorized.

## Historical R2-A failed run

Status: **BLOCKED_BY_FINANCIAL_APPLICATION_CONTRACT**, 2026-10-20. This is a failed implementation checkpoint, not acceptance or authorization to install. **Do not apply draft migration0010.** It remains in the uncommitted migration journal for inspection; running the current migration chain would install the defective guard. No commit, push, deployment, runtime worker registration, provider execution or scope activation occurred.

## 1. Starting baseline and authority

Started from clean, synchronized `main`, HEAD **449df0392f0fbffdcffe535c493ea9f1321e33bb**, the accepted dormant D02-A checkpoint. The approved [R2 design](h1-fix-02-b3-2-b2-r2-financial-application-design.md), [independent review](h1-fix-02-b3-2-b2-r2-design-review.md), [H01–H12](h1-fix-02-b3-2-human-decisions.md), [accounting policy](h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09), B.1/R0/R0.2/R1 and D02 implementation/review history define the boundary. In particular, independent review §10 assigns closed common structures to R2-A and complete operation validators to later checkpoints.

Repository instructions, source/evidence SQL and affected financial boundaries were inspected. Historical F01/F02/F04/F05/F06 and all prior decisions/reviews remain unchanged. No monetary policy was amended. Initial tracked-file hashes cover245 files;43 pre-existing ignored database markers were saved for restoration.

## 2. Implementation inventory and complete diff boundary

The uncommitted draft contains:

- [Migration0010](../../apps/api/drizzle/0010_financial_application_foundation.sql) and its migration-journal entry.
- [Drizzle mappings](../../apps/api/src/database/schema.ts) for the nine new relations below.
- [Structural SQL regressions](../../apps/api/test/integration/financial-application-foundation.spec.ts),35 cases, and [migration regressions](../../apps/api/test/integration/financial-application-migration.spec.ts),4 cases.
- Current-chain count/title maintenance,10→11, in capture/integrated/settlement, B.1, R0, R0.2 and D02 migration tests. Original financial assertions are retained.
- Optional migration-folder parameters in the existing [receipt harness](../../apps/api/test/support/trusted-receipt-harness.ts) and [observation harness](../../apps/api/test/support/provider-observation-harness.ts), enabling populated0009 upgrade tests; the receipt harness checks11 after completed upgrades.
- This record and documentation navigation.

No live application service, module, controller, consumer, scheduler, reconciliation route, runtime configuration or dependency changed. SQL0000–0009 and the original F01 source are unchanged. Temporary scripts, JSON/logs, caches, local database artifacts and fixture credentials are excluded from deliverables. There is no staged inventory or new commit.

## 3. Draft schema and canonical identity

Nine prospective relations were drafted: `financial_application_contracts`, `financial_application_scope_authority`, `financial_application_roots`, `financial_application_manifests`, `financial_application_permits`, `financial_applications`, `financial_application_dispositions`, `financial_application_revision_effects` and `financial_application_effect_links`.

Canonical roots use family/operation/phase/currency uniqueness, with common terminal slots for capture/refund and separate dispute OPEN/CLOSE shapes. Typed operation columns and ownership FKs bind the accepted object; a trigger compares provider command roots with immutable D02 acceptance. Internal/dispute acceptance remains closed. Scope authority has only DORMANT enrollment; installation inserts no contract, enrollment, certificate or ACTIVE scope. Existing D02 acceptance remains LEGACY/0, without retrospective policy stamping.

These are draft structures, not established financial guarantees. Contract version evolution, every unsupported proof alternative and full historical replay behavior still require acceptance before dependent writers can rely on them.

## 4. Permit and privilege model

The draft issuer locks the private inbox and compares PROCESSING/attempt generation, then takes account SHARE, canonical advisory and scope NKU before parents/lots/allocations. It invokes the existing effective-proof reader and a migration-installed SQL preparation function. The worker supplies an exact selector, not calculation authority.

Protected permits bind server-derived `pg_current_xact_id()`/`pg_backend_pid()`, manifest, authenticated principal, accepted root, policy/epoch and evidence revisions. Retained rows cannot be looked up as current authority in another transaction/backend. The structural fixture uses actual restricted LOGINs with EXECUTE grants, no owner membership or direct trusted-table insertion. The database-specific NOLOGIN application owner has no ledger DML/schema CREATE. Guarded revision advancement remains with the existing admission owner.

No operation contract or runtime LOGIN grant is installed by the migration. Earlier structural tests explicitly installed a nonmonetary SQL probe in disposable databases; its full validator returns false. That probe is not a refund validator, financial success or operational policy enrollment.

## 5. Source/effect manifest

The draft stores immutable proof/claim/scope/revision selectors and SQL-produced before/after effect images. Typed effect links reference journals, lots, refund/dispute allocations, hold effects and settlement items, with deferred relationships and ownership keys. Four additive unique ownership keys are installed on existing effect tables without modifying historical rows.

Application records point to one manifest and immutable audit. There is no second balance store. Complete operation calculations, correct entry multisets, complete groups and result interpretation remain the responsibility of reviewed operation contracts, none of which is enabled here. The blocked run does not establish those properties.

## 6. Bidirectional finality and confirmed blocker

The draft attempts immediate permit/exact-write guards and deferred complete-application checks on protected financial rows, plus application-side workflow/audit/disposition/effect checks. It also attempts protected DELETE/TRUNCATE refusal and business-reference checks independent of caller version0/NULL fields.

**R2-A-R01 — blocking legacy compatibility regression.** `guard_financial_application_effect` declares a PL/pgSQL root variable named `r` and uses `r` again as a SQL table alias in its root/scope lookup. PostgreSQL reports **`column reference "r.merchant_id" is ambiguous`**. Expression resolution happens before the intended unenrolled-scope return. Consequently ordinary legacy fixture/payment/journal work can fail even with no enrolled scope or installed operation contract.

Reproduction: apply the draft eleven-migration chain to a disposable database and run the existing financial integration tests. The unchanged refund/capture/ledger fixtures fail at legacy writes, before their financial assertions. The original F02 balance/immutability tests can receive this unrelated error instead of reaching their existing checks. This is a defect in the draft guard, not evidence that the original financial constraints or accepted baseline failed.

The full command completed its assertions with **34 passed /741 failed /0 skipped**,25 suites (1 passed,24 failed),98.417s.740 failures report or wrap the guard ambiguity. The remaining failure is the new populated-upgrade fixture returning UNRESOLVED instead of BOUND before migration0010, which also needs investigation. It is not reported as a production correlation defect.

The user's §14 explicitly requires stopping when a supposedly compatible dormant guard breaks legacy writers. Implementation stopped at that condition. The failed draft and regressions are retained; no legacy assertion, SQL0000–0009, F02 rule or accounting policy was weakened to obtain green results. No acceptance can follow from the earlier structural-only green run.

## 7. Admission disposition boundary

The proposed companion preserves original R0 resolutions and references exact inbox obligation revisions or D02 source UUIDs. R0.2 uses delivery/barrier keys; its recovery remains closed. REVIEW_REQUIRED/RETRY do not discharge a source. Existing database names remain AWAITING_APPLICATION/BLOCKING_REVIEW and CLEARED_APPLICATION/CLEARED_NO_EFFECT; proposed application acknowledgments use APPLIED/VERIFIED_NO_EFFECT.

The draft admits only its exact signed source and selected matching D02 witness. Unrelated obligations, exceptions, additional sources and delivery barriers remain blocking. A changed R0 revision or new contradictory D02 source cannot inherit an older acknowledgment. The existing global receipt inspector is unchanged and remains conservative; no note-only resolution or ignoreBlockers API was introduced. Successful application-owned clearance is not established by this failed checkpoint.

## 8. Lock order and transaction ownership

Intended order remains private wrapper → account → merchant/currency advisory → scope → payment/refund parents → ordered lots/dispute/refund allocations → manifest/private application/effects → dispositions/revision/conditional inbox finality → deferred COMMIT. Proof sealing/binding is done in separate fixture transactions before application preparation; no self-locking sealer/resolver is called after financial suffix locks.

FK KEY SHARE and unique-key waits still matter: original source/accepted authority references are immutable, while parent/effect references can wait. The structural concurrency case observes distinct PIDs and `pg_blocking_pids` on the private inbox. A DDL case observes an actual writer blocking the added ownership constraint. These finite cases do not prove a complete future writer lock graph. The final failing run supersedes earlier green structural evidence.

## 9. Fresh/upgrade migration evidence

Fresh installation and repeated migration, transactional rollback of new objects/owner/keys, and observed DDL waiting passed in the final new migration suite (**3 passed /1 failed**). Populated0009 upgrade verification is **incomplete** because its new proof fixture failed before the upgrade. Other historical upgrade/fingerprint tests that passed do not establish whole-checkpoint compatibility in the presence of the confirmed guard failure.

Only disposable loopback PostgreSQL18.6 databases were used. No production migration or hosted database was accessed. Retained database history is not deleted. Catalog and source-preservation results are recorded in §11 after cleanup.

## 10. Structural regression evidence and limits

An earlier focused revision passed34/34 structural tests: authentic limited-role issuance, transaction/backend reuse refusal, savepoint rollback, retry, typed proof ownership, claim/revision rejection, ordinary-role/GUC forgery refusal, source-specific rejection, missing-effect/application/disposition refusal, late contradiction and one observed issuer schedule. It did not post money or prove refund/capture calculations.

Subsequent effect-guard/ownership-link changes and the additional reverse-implication test were included in the final775-case matrix. In that final run, the structural suite passed9 and failed26; the broader regression failure invalidates any READY claim. The final result, not the earlier34-case iteration, is authoritative. The deliberate probe validator never approves a finalized application.

Actual capture/refund monetary application, correct per-lot source/fee/hold selection, successful finality, complete ordinary-role effect paths, historical replay, all requested negative variants and full application concurrency remain unverified. Six original F01 assertions are preserved; their separate baseline execution is distinguished from this defective0010 installation in §11.

## 11. Executed checks and cleanup

Environment: Windows, Node24.19.0, pnpm10.26.0, PostgreSQL18.6; cached dependencies, mocked Stripe/broker boundaries, no dependency installation.

| Check | Result |
| --- | --- |
| Full PostgreSQL matrix, `RUN_DB_TESTS=1 RUN_MIGRATION_TESTS=1`, excluding opt-in F01 | **FAIL:34 passed,741 failed,0 skipped;25 suites** |
| Earlier focused structural revision |34 passed,0 failed; superseded by final failure |
| Final new structural/migration suites within the full run |Structural9 passed/26 failed; migration3 passed/1 failed |
| `pnpm lint` |PASS API/web |
| `pnpm build` |PASS API/web; no deployment |
| `pnpm typecheck` after build |PASS API/web |
| `pnpm test` |PASS50 units/12 suites;781 DB tests/26 suites skipped;831 total discovered |
| Hosted PostgreSQL17, Node22/24, live Stripe/RabbitMQ/Redis, runtime cutover |NOT RUN; no authorization or claim of verification |

The full failing Jest command wrote complete JSON/results, then retained open handles after fixture failures; it was interrupted after assertion completion. This does not change the failed counts. Initial draft iterations also had a PL/pgSQL CASE parse error, a missing proof-reader SELECT capability, an ambiguous JSON alias and a manual-savepoint fixture issue. Those earlier corrections did not establish final compatibility. No failure is hidden by retries, skipped financial assertions or a changed oracle.

Commands/evidence: `.tmp/r2a-matrix.json`, `.tmp/r2a-matrix.log`, `.tmp/r2a-focused.json`, `.tmp/r2a-{lint,build,typecheck,default-test}.log`. These are ignored local evidence, not repository deliverables. Final documentation, whitespace, catalog, F01 baseline and preservation checks are appended below.

Final preservation/cleanup: all ten historical SQL files, the first ten journal entries, the original F01 source and prior human/design/review records are unchanged. Of245 original tracked files, only the12 named source/schema/test/navigation files changed;233 remain byte-identical. Four new deliverables make16 uncommitted files, with an empty index and unchanged starting HEAD. New-file whitespace and `git diff --check` passed. Documentation validation passed56 Markdown files/822 relative links and anchors, with CI YAML parsed/structure checked;19 unchanged Mermaid blocks were inventoried, without claiming diagram parsing/rendering.

Separate original F01 execution used a new database with **only accepted SQL0000–0009**, not the defective0010 draft: **6 expected financial failures,0 passed,0 skipped**,15.152s. All six names/statuses/full failure messages exactly equal the accepted D02-R1 review JSON. This preserves the original red history; it does not verify draft compatibility. The full0010 matrix remains failed.

Read-only catalog inspection found348 retained databases with accounting-scope tables,6590 scopes and **zero ACTIVE**, zero enabled evidence accounts, and40 databases with application tables containing **zero finalized applications**. The subsequently created F01 baseline had10 migrations and0 scopes/ACTIVE. All43 pre-existing database-marker contents were restored. The disposable cluster returned to its initial stopped state; databases and immutable fixture history were retained. No real Stripe/broker/Redis/provider, operational credential, production data or environment was used.

## 12. Remaining installation and R2 dependencies

First correct and independently verify the common R2-A contract, including the legacy guard failure and upgrade fixture. Complete its missing adversarial/positive structural coverage before accepting any adapter. Do not infer financial liveness from empty registries or use the SQL probe as a production operation contract.

R2-B pre-lot capture/workflow evidence, operation-specific full validators/adapters, exact duplicate/recovery paths, F05/F06 corrections, complete settlement/payout/legacy writer floor, D03 history/cohort proof, operational grants and old-worker fencing, external/hosted evidence and explicit activation remain separate dependencies. No operation family was activated and no R2-B work began.

## 13. Independent review priorities and verdict

Review the recorded compatibility failure first, then protected claim/permit issuance, registry/version history, complete typed ownership, no missing-group/NULL/version0/business-key bypass, both finality implications, source-specific revision/late-contradiction handling and actual FK/lock order. Require a clean final full PostgreSQL run with unchanged historical assertions before treating the framework as review-ready.

**BLOCKED_BY_FINANCIAL_APPLICATION_CONTRACT**

## 14. R2-A.1 correction authority and starting state

Continued the existing implementation on `main`, HEAD **449df0392f0fbffdcffe535c493ea9f1321e33bb**. The worktree contained the16 R2-A deliverables listed above, with an empty index. A new249-file byte-hash inventory includes all tracked and untracked starting files;46 pre-existing database markers were saved. Original migration0010, this failed-run record and the prior test JSON/logs were retained separately under ignored `.tmp/r2a1-*` evidence.

This correction does not redesign the checkpoint. Changes relative to that starting work are limited to migration0010's conflicting identifiers/status comment, the new original-path regression and corrected frozen-attribution setup in the existing migration suite, a [legacy before/after suite](../../apps/api/test/integration/financial-application-legacy-compatibility.spec.ts), this appended record/current banner and navigation. Drizzle mappings, registry/permit architecture, ownership predicates, grants, other R2-A fixtures and all historical SQL remain unchanged.

## 15. Original42702 reproduction and exact correction

A new disposable database, `fintech_r2a1_repro_1792456244697`, received the original defective eleven-migration chain. The following statement then failed before inserting a payment, with no enrolled application scope or contract:

```sql
insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,captured_amount,platform_fee_amount,payment_method_token) values ($1,$2,'CAPTURED','MANUAL','USD',10000,10000,10000,300,'pm_test')
```

Bound fixture UUIDs were payment `0fd6b1a6-e67c-4d63-bc79-fab6af1c27c8` and merchant `d8403bb8-4c66-4699-82a8-63c2576f5633`. PostgreSQL returned:

```text
SQLSTATE: 42702
message: column reference "r.merchant_id" is ambiguous
detail: It could refer to either a PL/pgSQL variable or a table column.
where: PL/pgSQL function public.guard_financial_application_effect() line 19 at IF
internal_position: 186
internal_query:
TG_TABLE_NAME='ledger_transactions' AND EXISTS(SELECT 1 FROM public.financial_application_roots r
    JOIN public.financial_application_scope_authority s ON (s.merchant_id,s.currency)=(r.merchant_id,r.currency)
    WHERE r.operation_id=(n->>'business_id')::uuid)
routine: plpgsql_post_column_ref (pl_comp.c:1046)
```

Trigger: `application_effect_permit`, BEFORE INSERT/UPDATE/DELETE on `public.payments`, invoking `public.guard_financial_application_effect()`. Caller/session role was `fintech`, with caller `search_path="$user", public`; the SECURITY DEFINER owner was `fintech_application_f51dcd4350dc98795dbb06764937eb6a`, with pinned `search_path=pg_catalog,pg_temp`. Persistent table references were already qualified. This was a variable/query-alias collision, not a schema-selection problem.

In the original/current line layout, migration0010 line370 declared `r public.financial_application_roots%ROWTYPE`; lines386–388 also declared query alias `r` and used `r.merchant_id`. PostgreSQL must resolve that SQL expression even when the trigger is handling a payment rather than a journal. The intended empty-enrollment return occurs later, so it could not prevent the error.

The correction names the PL/pgSQL record `application_root` and query aliases `root_row`/`scope_row`, updating only their references. Merchant/currency, accepted operation, business type, current-permit and exact-write predicates are retained. No predicate became TRUE; no exception handler, permissive default or global name-resolution setting was added. The other0010 function declarations/query aliases were inspected; a supplemental static collision scan found no remaining same-name record/scalar aliases, and the relevant functions were exercised by the structural suite.

The permanent payment-INSERT regression was run **before** the rename: **0 passed/1 failed/4 name-filtered skips**. The exact original42702 occurred. After correction, the unfiltered migration and structural suites passed **40/40**, including that case. Full original error/trigger/role/source context is retained in `.tmp/r2a1-reproduction.json`; the original defective SQL is `.tmp/r2a1-original-0010.sql`.

## 16. Failure inventory and independent baseline defects

The retained original matrix has **34 passed/741 failed/0 skipped**, not six skipped tests. The six F01 cases were excluded from that command and run separately. Normalizing direct and wrapped Jest errors shows **740 failures attributable to42702**, including five tests that expected existing F02/ownership errors but instead received the new ambiguity. They were real compatibility failures; they were not harmless or individually patched.

The remaining original failure was independent: the populated0009 upgrade fixture accepted a new2000 refund but never inserted its frozen allocation. Existing0006 `build_financial_evidence` correctly raises `Trustworthy frozen refund attribution required`, which the correlation adapter reports as UNRESOLVED. The corrected fixture first asserts that refusal, then inserts the exact owned2000 allocation before requiring BOUND. Existing proof-builder SQL and assertions remain unchanged.

**Newly observed existing runtime defect — reconciliation issue publication.** `ReconciliationService.issue` at [line79](../../apps/api/src/reconciliation/reconciliation.service.ts#L79) omits the final SQL closing parenthesis. Actual mismatch publication raises SQLSTATE **42601**, `syntax error at end of input`, on accepted0009 and corrected0010 alike. This committed runtime service was not changed. The new comparison suite verifies the same refusal and FAILED run without financial mutation in both phases; it separately verifies matched reconciliation and actual note-only resolution of an explicitly seeded local review fixture. Successful discrepancy publication remains broken and needs a separate focused correction. It is not attributed to0010 or claimed fixed.

The first new legacy comparison iteration had8 passes/4 failures: two new mirror expectations incorrectly assumed the authorization mirror would keep `requires_capture`, while the existing shared-PI update changes both mirror rows to `succeeded`; two exercised the independent42601 defect. Inspection and baseline execution established the actual behavior. The final tests explicitly name these retained legacy behaviors. No previously existing financial assertion was changed or skipped to hide either issue.

## 17. Independent legacy before/after comparison

The new compatibility suite starts a fresh database on accepted0000–0009, invokes existing runtime service classes, fingerprints17 populated workflow/financial/messaging/audit/reconciliation tables, installs corrected0010, requires byte-equivalent row fingerprints, and repeats the same workflows using fresh operation identities. Each after-upgrade result must equal the saved normalized before-upgrade result as well as its explicit expected amounts/statuses.

| Case, executed on both schemas | Preserved observed result |
| --- | --- |
| Payment creation/authorization/capture | Actual API idempotency/outbox transactions plus locally SDK-signed receiver/processor confirmations; authorization10000, capture10000, fee300, lot G/F/N10000/300/9700, one original capture effect, exact API/event replay |
| Refund acceptance/completion |2000 principal,60 fee reversal; PSP8000, pending7760, original fee revenue300 and fee-refund expense60 |
| Dispute open/win | Hold2000 changes pending9700→7700; win restores9700 and clearing0; closed/MERCHANT_WON |
| Settlement generation/completion/replay | Legacy NULL accounting policy retained; cash10000/available9700, PSP/pending0; original POSTED capture remains immutable |
| Payout reservation/completion/replay | Reserve8000 from9700; completion leaves cash2000/available1700/clearing0; one reservation and one completion journal |
| Webhook/mirror and matched reconciliation/note resolution | Signed local inbox/processor and existing mirrors execute; matched provider fixture yields0 issues; explicitly seeded review resolves without financial changes |
| Existing discrepancy-publication defect | Actual reconciliation run fails42601 on both schemas, appends a FAILED run and0 issue rows, and changes no financial balance |

**14 passed/0 failed/0 skipped**, seven cases before and seven after. No application permit/root/enrollment/contract was created by any legacy case. Provider status responses and mirror references are explicit local fixtures; no Stripe/bank operation was called. The compatibility comparisons preserve current behavior, not provider authenticity or monetary correctness for new-policy writers. They do not close F01/F04/F05/F06.

## 18. Dormant finality, authority and security recheck

The compatibility strategy is unchanged: application scope enrollment and operation contracts are protected, immutable and **empty after installation**. Legacy rows outside enrollment continue through the original financial constraints. An enrolled scope still requires the current database permit and exact SQL-prepared write; caller NULL/version0 fields or arbitrary business types do not choose an escape route. Unsupported operation/proof/validator paths remain closed. No existing column default changed and no root/receipt/history was promoted into a new era.

The35-case structural suite passed in the full and final focused runs. It exercises server-derived top-level transaction/backend identity, actual restricted LOGINs, no direct trusted-table insertion, GUC/UUID forgery refusal, cross-backend and post-COMMIT reuse refusal, savepoint rollback/reissuance, transaction rollback/retry, exact typed ownership/terminal identity, stale claims/proofs/revisions, unprepared writes, missing application/effects, deferred COMMIT and immediate-constraint refusal, partial/wrong-source dispositions, late contradictory D02 observations, legacy version0 outside enrollment and a controlled two-backend permit wait.

Owner/table/column grants and SECURITY DEFINER paths remain unchanged by the correction. Tests require no PUBLIC EXECUTE leaks, no schema CREATE or ledger DML for application/evidence-only owners, and pinned function search paths. Existing B.1/R0/R0.2/R1/D02 role, admission, native retry and concurrency regressions passed. No SQL authorization or financial ownership check was removed.

The SQL probe is still installed only by the administrator in disposable structural-test databases; its complete operation validator returns false. There is **no successful new-era financial application**, no capture/refund/dispute calculation validator, and no enabled runtime path. Green structural checks do not establish per-lot monetary correctness, complete future dispatch/recovery or a safe production cutover.

## 19. Migration and historical preservation

Fresh eleven-migration installation/repeated application, populated0009 upgrade with original journals/proofs/genuine D02 bytes, late transactional DDL rollback and observed writer/DDL waiting all passed. The rollback case checks absence of new application relation/owner/ownership key and then successfully reapplies the complete migration, exposing any partial object leak. The legacy comparison independently verifies17 original table fingerprints across installation.

The correction changes only identifiers and a historical warning comment in uncommitted0010. SQL0000–0009, the first ten journal entries, original F01 source, F02 functions/constraints, human decisions and prior reviews remain byte-identical. No historical financial backfill, production credential, activation certificate or live writer registration was introduced. All PostgreSQL executions used new disposable databases in the loopback-only local cluster; the defective reproduction was never applied to an existing shared database.

## 20. R2-A.1 verification results

Actual environment: **PostgreSQL18.6 on x86_64-windows, MSVC19.44.35228; Node24.19.0; pnpm10.26.0**. No dependency installation/upgrade was needed.

| Executed check | Result |
| --- | --- |
| Original retained R2-A matrix |34 passed/741 failed/0 skipped;740 ambiguity consequences plus1 missing-allocation fixture |
| New original-path regression before correction |1 failed/4 name-filtered skips; original42702 reproduced |
| Corrected focused structural/migration run |40 passed/0 failed/0 skipped |
| Legacy before/after suite |14 passed/0 failed/0 skipped |
| Full final financial/evidence/migration/role/concurrency matrix |**790 passed/26 suites;0 failed,0 skipped**,192.425s |
| Final three R2-A suites after changing only the SQL warning comment |**54 passed/3 suites;0 failed,0 skipped**,22.875s; subset of the full matrix, not additional distinct coverage |
| Separate unchanged F01 on corrected0000–0010 |**6 expected financial failures/0 skipped**,18.233s; all names/statuses/full failure messages exactly equal accepted D02-R1 review evidence |
| `pnpm lint`, `pnpm build`, post-build `pnpm typecheck` |PASS API/web |
| `pnpm test` |**50 passed/12 unit suites;796 DB cases/27 suites skipped**,846 total discovered; DB opt-ins exercised separately above |
| Hosted PostgreSQL17/Node22/24, live Stripe/bank, RabbitMQ/Redis network, operational fence/activation |NOT RUN; no claim of verification |

The full PostgreSQL command uses `RUN_DB_TESTS=1 RUN_MIGRATION_TESTS=1`, explicit new local DATABASE_URL/MIGRATION_ADMIN_URL and Jest `--runInBand test/integration --testPathIgnorePatterns settlement-f01.pending`. F01 is a separate opt-in command with RUN_F01_PENDING=1 and its own fresh corrected-chain database. No failed test became skipped and no original financial oracle was weakened. The two expected42601 comparisons are explicitly named baseline-defect assertions, not successful issue publication.

Ignored evidence is `.tmp/r2a1-{reproduction,original-failure-inventory,original-red,focused,legacy,matrix,final-foundation,f01}.json` and corresponding logs, plus lint/build/typecheck/default-test logs.

Final documentation validation passed for56 Markdown files and824 relative links/anchors, with YAML parsed and its structure checked;19 unchanged Mermaid blocks were inventoried, not rendered or parser-validated. `git diff --check` and the new files' trailing-whitespace/final-newline checks passed. The249-file starting inventory confirms exactly the four changed files described in section14, plus the single new legacy compatibility suite. The other245 starting files, SQL0000–0009, first ten migration-journal entries and original F01 source remain unchanged. The original failed record's body through section13 is preserved verbatim.

The final read-only local catalog scan found7491 accounting scopes across409 disposable databases, **0 ACTIVE scopes**, **0 enabled accounting accounts**, and **0 financial applications** across the97 databases containing application tables. All46 pre-existing database markers were restored byte-for-byte with0 mismatches; current test database identities were retained separately in ignored evidence. The local PostgreSQL cluster was stopped, returning it to its starting state while retaining all databases and history. HEAD remains449df0392f0fbffdcffe535c493ea9f1321e33bb, the index is empty, and17 intended R2-A/A.1 files remain uncommitted. No commit or push occurred.

## 21. Handoff and independent review priorities

Review the minimal variable/alias correction and the original red regression first, then confirm that every ownership predicate, restricted grant and empty-enrollment boundary is retained. Challenge the existing common permit/claim/revision authority, bidirectional guard coverage, exact-source acknowledgments, typed composite relationships and implicit FK/lock order. Contract-version evolution, unsupported proof shapes, complete historical replay/recovery and all operation-specific validators remain later acceptance work; the correction does not certify those unimplemented behaviors.

Remaining dependencies are R2-B pre-lot capture/workflow evidence, full operation adapters/validators, F05/F06 corrections, settlement/payout/legacy writer coordination, D03 eligibility, operational credential/session fencing, hosted/external evidence and explicit activation. The independent existing reconciliation42601 issue-publication defect also requires its own correction before operational reliance. No R2-B work or activation began here.

**READY_FOR_INDEPENDENT_REVIEW**

## 22. Independent review finalization — REQUEST_CHANGES

The [independent R2-A report](h1-fix-02-b3-2-b2-r2-a-independent-review.md), finalized 2026-10-20 from retained evidence and source inspection, requests changes for two P1 defects in migration 0010's reverse ownership enforcement. Its saved final reviewer run has **four failed regressions, one passed control and zero skips**: journals with wrong merchant/currency and no canonical root committed without applications; settlement-item insertion and an existing-item payment retarget committed without the required permit. The earlier 790-case matrix excludes these five reviewer cases and does not establish their invariants.

Minimal next checkpoint: **R2-A.2 authoritative effect ownership and settlement-candidate integrity correction**, followed by independent re-review before R2-B. Preserve the four failing assertions and original history; resolve protection through authoritative operation/header/payment/capture owners, including OLD/NEW references, and require complete application finality. The report names exact SQL predicates, least-privilege read considerations, permanent regressions and unverified boundaries.

This finalization changes documentation only. It does not repeat the interrupted PostgreSQL authorization experiments, connect to a database, edit implementation/tests/evidence, or certify the interrupted review's resource cleanup/current catalog. Sections 1–21 and retained original/corrected results remain preserved; no financial scope was activated, and no commit or push occurred. **REQUEST_CHANGES.**

## 23. R2-A.2 financial ownership correction — execution blocked

Date: **2026-10-20**. Author disposition: **BLOCKED_BY_FINANCIAL_OWNERSHIP_CONTRACT**. This is an uncommitted corrective draft with incomplete database verification, not an accepted checkpoint. The independent verdict is still REQUEST_CHANGES. No R2-B work begins.

### Authority, inspection and source root causes

Inspected the complete starting worktree on `main`, HEAD `449df0392f0fbffdcffe535c493ea9f1321e33bb`, with an empty index and 18 existing uncommitted paths. Read repository instructions, task routing, verification, approved R2 application design/review, H01–H12, original R2-A/A.1 history, finalized independent findings, reviewer fixtures, current migration 0010, original settlement constraints and the ledger/database/concurrency/settlement contracts. A starting SHA-256 inventory covers 317 repository/evidence files; 40 pre-existing database markers were saved for preservation checks. Existing work was retained.

The two confirmed defects are specified in independent review §§3–4, not newly reproduced in this run:

1. **Journal ownership:** the immediate guard selected protection from claimed journal scope and an existing application root. An absent root plus a wrong merchant/currency missed the owned CAPTURE operation. The deferred guard required an already present permit/manifest before checking finality, so entirely absent authority/application silently escaped.
2. **Settlement ownership:** the item branch followed only NEW payment ownership, omitted settlement/capture authority, and read nonexistent OLD merchant fields. An incompatible payment retarget could erase protection. Separate legacy existence FKs and nullable lot links did not establish coherent header/payment/capture ownership or original amounts. The definer's SELECT grants omitted required source relations.

Violated invariants: protected effect → current owned operation/application authority → complete canonical application at COMMIT; and candidate header/payment/capture/journal/currency ownership with immutable original G/F/N. Journal balance, a payment UUID, an absent application, and NULL legacy policy/lot fields cannot establish those invariants.

### Corrective SQL draft

- `financial_application_effect_owners` resolves implicated owners from PostgreSQL records without requiring a root. For journals it checks attempts, refunds, disputes, hold effects, settlements, payouts, immutable accepted command authorities and any roots, including owning payments. Lookup does not depend on the claimed business type. Entries resolve both their parent journal's sources and their account; items resolve header, payment, attempt/owning payment, optional lot and original capture journal.
- Both trigger timings inspect OLD and NEW references. Immediate checks require the current transaction/backend/principal permit, matching ownership and exact SQL-prepared write. Protected journal merchant NULL is rejected; platform accounts with NULL merchant do not supply journal ownership. The existing business/operation match now uses `IS NOT TRUE` to refuse nullable comparisons.
- Protected item updates retain header/payment/attempt/lot/currency and original gross/fee/net. `check_financial_application_item_owner` requires a coherent header/payment/successful CAPTURE attempt/POSTED CAPTURE journal, with item gross equal to attempt amount and original journal gross/fee/net. It requires positive gross and G=F+N. It reads immutable original financial entries rather than current payment-wide totals or later settlement/refund amounts. It adds no fee rounding or settlement policy.
- Deferred checks reread the final persisted effect by identity, resolve protection from queued OLD/NEW and current rows, require the current permit and final manifested row, recheck owners/item sources, and call the complete-application validator. No permit or no application now selects a refusal for a protected effect. Existing application→effects checks remain intact. PostgreSQL supports deferred constraint triggers and explicit `SET CONSTRAINTS` checks; the new behavior still needs execution against this SQL ([trigger documentation](https://www.postgresql.org/docs/18/sql-createtrigger.html)).

### Exact deliverable changes relative to this run's starting tree

| File | Change |
| --- | --- |
| [0010 SQL](../../apps/api/drizzle/0010_financial_application_foundation.sql) | Shared authoritative owner lookup, prospective item integrity, OLD/NEW guards, final-state backstop and minimum definer reads; draft status comment |
| [Ownership regressions](../../apps/api/test/integration/financial-application-ownership.spec.ts) | 33 new cases specified: limited authenticated writer; rootless typed/unsupported journals; OLD references; entry parent; header/payment/capture detection; missing permit/application at COMMIT/IMMEDIATE; independent source predicates and legacy control |
| [Migration regressions](../../apps/api/test/integration/financial-application-migration.spec.ts) | Expected restricted-owner function inventory 11→13 for the two new helpers; existing migration/financial assertions unchanged |
| This implementation record | Current status and appended §23; original body through §22 preserved |
| [Documentation index](../README.md) | Current R2-A.2 blocked status; independent review entry unchanged |

The five reviewer cases and their assertions remain byte-identical, including their historical comment about the red baseline. No production financial writer, runtime registration, Drizzle storage model, migration metadata, dependency or configuration changed in this correction.

### Historical compatibility, privileges and transaction considerations

This draft still installs **zero** contracts, enrollments, applications or ACTIVE scopes. The scope registry is immutable/protected and empty by default; genuinely unenrolled legacy writes retain the existing return path and original constraints. Item ownership predicates apply to prospective protected writes, including legacy-shaped items touched after enrollment; they do not scan, stamp, backfill or rewrite historical candidates. SQL 0000–0009 and existing F02/0004/R0/R0.2/R1/D02 rules remain unchanged. These are source/preservation observations, not newly executed migration compatibility guarantees.

Both helpers use the existing restricted NOLOGIN application owner, pinned `pg_catalog,pg_temp` context and revoked PUBLIC EXECUTE. Added SELECT is limited to `payment_attempts`, `disputes`, `payouts`, `settlements`, `settlement_items` and `dispute_hold_effects`, needed by the owner lookup/final-row checks. No financial DML, permit insertion, role membership, operational login grant or new issuance API is granted to ordinary writers. Existing server-derived transaction permit issuance/lifetime and closed operation contracts remain in place. Catalog/role composition verification is pending.

The correction adds read predicates, not new row-lock acquisition or a new parent update. Existing FK, source immutability, parent versioning and account → advisory → scope → header → payment/children → lot/item ordering are preserved in source. This is not concurrency proof. Enrollment/installation still needs the approved maintenance/fence protocol; arbitrary concurrent administrative enrollment is not certified. Unsupported operation validators, capture pre-lot proof and all future writer adapters remain closed.

### Actual execution evidence for R2-A.2

Environment: Windows, Node **24.19.0**, installed pnpm **10.26.0**, PostgreSQL **18.6** binary. PostgreSQL17 server binary was unavailable. Cached package tooling was selected with `COREPACK_HOME=C:\Users\Daniel\AppData\Local\node\corepack` and `COREPACK_ENABLE_NETWORK=0`; no dependency download/install occurred.

| Executed operation | Result |
| --- | --- |
| New private PostgreSQL18 cluster bootstrap | Incomplete. Initialization did not produce a usable cluster; attempted startup reported missing `global/pg_control`. A separate bootstrap was stopped before completion. Partial directories/logs retained; no migration ran there. |
| Normal corrective test setup on existing disposable localhost server | **BLOCKED:** `node .tmp/r2a2-run.cjs focused` failed at initial connection with `EACCES`, `connect EACCES 127.0.0.1:55434`. It reached no SQL, database creation, migration or Jest invocation. No further database operation, alternate connection, escalation or interrupted authorization experiment was attempted. |
| First `pnpm lint` invocation | Did not reach lint: Corepack attempted network resolution and failed `ENOTFOUND registry.npmjs.org`. Existing offline cache then enabled ordinary checks without network. |
| Offline `pnpm lint` | PASS API/web; final source recheck recorded separately below. |
| Offline `pnpm typecheck` | PASS API/web, including the new suite; final recheck passed. |
| Offline `pnpm build` | PASS Nest API and Next web production builds. No deployment. |
| Offline `pnpm test` | **FAILED before test execution:** all 41 discovered suites failed Jest transform-cache writes with `EPERM: operation not permitted, rename` in the sandbox temporary directory; **0 tests executed**. Operation stopped; no cache/permission workaround or rerun was attempted. Web test script remains a notice. |
| Documentation and preservation checks | Results appended below after final validation. |

The user required stopping restricted test operations. The localhost EACCES and Jest EPERM were retained and reported; no attempt was made to bypass either restriction. These are execution limitations, not passing negative financial regressions. Logs/scripts remain ignored `.tmp/r2a2-*` local artifacts.

**Not executed:** corrected reviewer cases; new ownership cases; full financial/structural/permit/deferred/settlement/evidence/admission/concurrency suites; fresh installation; populated0009 upgrade; runtime journal fingerprints; legacy before/after; current role/catalog/zero-ACTIVE inspection; separate F01 rerun. The previous reviewer **4 failed/1 passed**, original **34 passed/741 failed**, A.1 **790 passed**, and six separate F01 failures remain inherited evidence for their original revisions. None becomes a corrected result in this run. Prior reports/results and the independent verdict are unchanged.

### Remaining limitations and independent re-review priorities

The SQL has not been parsed/applied or exercised by PostgreSQL in this correction. Static TypeScript/lint/build success cannot prove its ownership predicates, definer privileges, finality, historical compatibility or lock behavior. No claim of database acceptance, four corrected failures, current cluster cleanup, successful new-policy financial application or F01/F04/F05/F06 closure is made.

Next authorized validation must run the unchanged five reviewer cases, all 33 corrective cases and all ordinary R2-A/financial suites on disposable PostgreSQL with the intended restricted roles. Require semantic P0001 refusal/rollback rather than incidental permission/setup errors; validate original item bytes and no partial applications. Inspect all typed operation mappings, OLD/NEW references, unsupported business types, NULL ownership, manifest omission, final-row rereads, G/F/N source consistency and both constraint timings. Recheck fresh/populated upgrades and original journal fingerprints, full legacy compatibility, F02/evidence/admission protections, restricted helpers/grants, zero ACTIVE and observed lock schedules. Execute the six unchanged F01 cases separately and preserve their financial failures. Then obtain independent re-review before R2-B.

Hosted exact-diff PostgreSQL17/Node22/24, genuine new-policy operation validators, recovery, F05/F06 corrections, common compatible writer floor, D03, operational credential/session fencing, provider/broker/Redis and explicit installation/activation remain separate gates. No commit, push, production migration or activation occurred.

Final non-database checks: **lint, typecheck and API/web build PASS**. Documentation validation passed **57 Markdown files / 843 relative links and anchors**, with CI YAML parsed and structure checked; 19 existing Mermaid blocks were inventoried, not parsed/rendered. `git diff --check` and direct changed-file whitespace/final-newline checks passed. The 317-file starting inventory shows only the four existing deliverables listed above changed, plus the new ownership suite. All other starting files, ten historical migrations, migration metadata, reviewer suite (`eceacfe6e4635958d279c5e406a13d18eb1ceca3e2f555f751a8bf7e7b8e3e17`), independent report, original body through §22 and retained R2-A/A.1/review evidence remain byte-identical. All 40 pre-existing marker contents are unchanged. HEAD is unchanged and the index remains empty. These preservation checks do not inspect or certify database state. Diagnostic logs, failed bootstrap artifacts and validation scripts remain ignored under `.tmp/r2a2-*`.
