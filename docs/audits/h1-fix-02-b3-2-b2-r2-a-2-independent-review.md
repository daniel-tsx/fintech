# H1 Fix 02 — B3.2 B.2-R2-A.2: independent financial ownership re-review

Date: **2026-10-20**. Status: completed independent correctness re-review. **Verdict: APPROVE_DORMANT_R2_A_CHECKPOINT.**

What this change does: the corrected SQL derives protection from stored financial owners even when a canonical root is missing, and checks settlement candidates against their header, payment, successful capture and original journal. Both original P1 findings are resolved within the dormant foundation boundary. No new acceptance-blocking finding was identified; this acceptance does not establish successful new-policy monetary application or production cutover readiness.

## 1. Reviewed baseline and complete diff

Checkout: `C:\Work\Learning Projects\learn-fintech`, branch `main`. HEAD and the local `origin/main` reference both resolve to **088a945f0d1cb30fc07e4ea802dae884f317d81f**. No fetch or remote verification was performed. The index was empty.

The starting uncommitted diff contained three existing documentation edits, **71 insertions / 2 deletions**: `docs/README.md`, [the implementation record](h1-fix-02-b3-2-b2-r2-a-financial-application-foundation.md), and [verification](../verification.md). Read that entire diff. The ownership correction itself was already committed in **4b2e2df459652e99e6cd237a651a320b7c278be6**; reviewing only the current documentation diff would miss the implementation. Inspected that complete checkpoint inventory against parent **449df0392f0fbffdcffe535c493ea9f1321e33bb**, including all 564 lines of [migration 0010](../../apps/api/drizzle/0010_financial_application_foundation.sql), the nine [Drizzle mappings](../../apps/api/src/database/schema.ts), migration metadata, all five application suites, both harness changes and migration-count maintenance in existing suites. Also compared the retained pre-A.2 SQL with the current SQL to isolate the ownership correction.

Review authority: repository AGENTS/CLAUDE, README/package scripts, [task routing](../AGENT_START_HERE.md), [AI workflow and payment checklist](../AI_WORKFLOW.md), ledger/database/concurrency/settlement owners, [approved R2 design](h1-fix-02-b3-2-b2-r2-financial-application-design.md), [independent design acceptance §10](h1-fix-02-b3-2-b2-r2-design-review.md#10-proposed-r2-implementation-sequence), and [H01–H12](h1-fix-02-b3-2-human-decisions.md). Read the R2-A/A.1/A.2 correction and recovery history, [original adverse review](h1-fix-02-b3-2-b2-r2-a-independent-review.md), original reviewer cases, all 33 supplements, and relevant existing ledger/settlement SQL. Applied the repository copies of `ponytail-review` and `supabase-postgres-best-practices`.

A starting inventory covers **377 repository files and 228 existing local evidence files**; 40 pre-existing database markers were saved. No reset, merge, implementation repair, assertion edit, staging, commit or push occurred. This review adds this report and one navigation link only. Existing documentation edits and historical adverse evidence remain preserved.

| Reviewed artifact | SHA-256 |
| --- | --- |
| Current migration 0010 | `50c6caee59d6e49a53728a0269733521ee0b31aaccd548428824d3f8916a3c17` |
| Unchanged original reviewer suite | `eceacfe6e4635958d279c5e406a13d18eb1ceca3e2f555f751a8bf7e7b8e3e17` |

## 2. Original P1 findings and disposition

| Original finding | Previously confirmed failure | Independent disposition |
| --- | --- | --- |
| R2-A-IR01 / P1-A: missing canonical root conceals journal ownership | Wrong merchant or currency plus no root allowed a protected CAPTURE journal to commit without an application | **Resolved.** Both unchanged negative cases now raise `P0001`, leave zero attempted journals and zero applications. Authoritative operation ownership is resolved before the legacy return. |
| R2-A-IR02 / P1-B: settlement protection follows only NEW payment | An unrelated payment could receive a protected header's item, or replace an existing candidate's payment while changing gross | **Resolved.** Both unchanged cases now raise `P0001`. No invalid item is inserted; rejected retargeting preserves the original payment and gross. Additional full-row checks preserve all original candidate fields. |

The [original REQUEST_CHANGES report](h1-fix-02-b3-2-b2-r2-a-independent-review.md), its four failed regressions/one passing control, earlier setup failures, original `42702` run, blocked execution history and subsequent recovery report are historical evidence. None was edited or relabeled as an original passing run.

## 3. Exact corrections and ownership guarantees

`financial_application_effect_owners` (0010, lines 369–409) replaces protection based only on caller fields/root existence. For journals it reads attempts, refunds, disputes, hold effects, settlement headers, payouts, immutable command authorities and roots, plus owning payments. This lookup does not depend on the claimed business type. Ledger entries resolve both their parent journal's financial owners and their account. Settlement items resolve payment, header, capture attempt/owning payment, optional lot and original CAPTURE journal owners.

The immediate guard (lines 434–475) considers **OLD and NEW** owners. Any implicated enrolled merchant/currency requires the current transaction/backend/principal permit. All non-NULL implicated owners must match that manifest; a protected journal must itself carry its exact merchant/currency. NULL merchant and unsupported/nullable business comparisons cannot authorize an enrolled write. The business/operation predicate uses `IS NOT TRUE`, and every allowed write must match the protected SQL-prepared before/after image. The absent-root cases reach explicit permit refusal instead of a successful empty SELECT/legacy return.

`check_financial_application_item_owner` (lines 411–432) uses `IF NOT EXISTS ... RAISE`, requiring a coherent settlement header, payment, successful CAPTURE attempt and owned POSTED CAPTURE journal. Item currency must match; gross must equal the attempt amount; original journal gross/fee/net must equal the candidate, with positive gross and `G=F+N`. Payment identity alone is insufficient. Current payment totals are not substituted for the original capture amounts. Protected UPDATE also preserves header/payment/attempt/lot/currency and original gross/fee/net. These prospective checks do not rewrite historical candidates or change rounding.

The deferred effect guard (lines 476–505) rereads the final persisted row by identity and resolves protection from queued OLD/NEW and final rows. An enrolled effect requires the current permit, its final manifested image, consistent owners, item-source validation where applicable, and a complete canonical application. Missing permit/application is an error even when no corresponding SQL row was inserted. INSERT and UPDATE both queue this backstop. The correction adds source reads, not a new row-lock protocol; future enrollment still requires maintenance/fencing rather than arbitrary concurrent administrative enrollment.

## 4. Unchanged reviewer regression results

Independently executed [the original suite](../../apps/api/test/integration/financial-application-review.spec.ts) first, without editing its fixtures, assertions, comments or test selection: **5 passed / 0 failed / 0 skipped**. The complete matrix executed it again with the same result. Its negative writes use an authenticated non-superuser, NOINHERIT LOGIN without memberships or permit-table mutation privileges.

| Original case | SQLSTATE and committed-state assertion |
| --- | --- |
| Missing root, wrong merchant | `P0001`; zero attempted journals; zero applications |
| Missing root, wrong currency | `P0001`; zero attempted journals; zero applications |
| Unowned candidate under protected settlement header | `P0001`; zero inserted invalid items |
| Existing candidate retargeted to another payment, gross `10000→9999` | `P0001`; original payment retained, gross remains `10000` |
| Original passing same-scope control | `P0001`; zero attempted journals; zero ACTIVE scopes |

An additional **read-only PostgreSQL transaction** against this run's retained reviewer fixture independently found zero attempted probe journals, zero applications, zero installed operation contracts, zero ACTIVE scopes and exactly one retained coherent USD item. Its original payment still matches its capture/header owner; gross/fee/net remain **10000/300/9700**. Exact fixture identities and installed catalogs are retained in `.tmp/r2a2-rereview-installed.json`. These results are semantic refusals and post-transaction SQL reads, not mocked results or incidental permission errors.

## 5. Supplemental regression coverage

Inspected every assertion in [the ownership suite](../../apps/api/test/integration/financial-application-ownership.spec.ts). Independently executed **33 passed / 0 failed / 0 skipped**, and reran all 33 inside the full matrix.

| Cases | Coverage |
| ---: | --- |
| 8 | Rootless CAPTURE, REFUND, dispute OPEN/CLOSE, settlement, payout reservation/completion and unsupported business type cannot conceal an owned operation behind another merchant |
| 3 | OLD journal merchant, currency and operation identity retain protection on UPDATE; complete saved row remains unchanged |
| 1 | Platform-account entry cannot hide an owned operation behind an incorrectly owned parent journal |
| 5 | OLD settlement header/payment/capture/currency/gross references cannot be changed to erase protection; full saved row remains unchanged |
| 3 | Header, capture and payment owners independently detect mismatched settlement candidates |
| 2 | Same-transaction enrollment after item insertion makes absent permit/application fail at COMMIT and `SET CONSTRAINTS ALL IMMEDIATE`; both item and enrollment roll back |
| 8 | Independent source predicate rejects wrong payment, attempt, currency, gross, fee, net, unconfirmed capture and missing header |
| 1 | Source predicate still recognizes original capture amounts after later captures change payment totals |
| 1 | Deferred journal detection refuses absent root/application after same-transaction enrollment |
| 1 | Genuinely unenrolled legacy items/journals require no R2 permit |

The source-predicate cases call the helper as test administrator to isolate its financial checks. They do not prove successful candidate application under an issued production permit. The ordinary writer remains unable to invoke that helper or manufacture permits. Full operation-specific validation remains a later gate.

## 6. Legacy compatibility evidence

Independently reran [the actual legacy before/after service comparison](../../apps/api/test/integration/financial-application-legacy-compatibility.spec.ts): **14 passed / 0 failed / 0 skipped**, seven scenarios on 0000–0009 and the same seven after 0010. Seventeen populated table fingerprints remain identical across installation. Both phases preserve authorization/capture, signed inbox/API replay, mirrors/lots, refund `2000` with fee reversal `60`, dispute open/win, settlement/replay, payout reservation/completion/replay, matched reconciliation and note-only resolution. No R2 enrollment, root, permit or application is introduced by these workflows.

The separate F01 run executed all six unchanged correct-behavior assertions: **0 passed / 6 failed / 0 skipped**. Names, statuses and complete failure-message arrays are **exactly equal** to retained `.tmp/r2a1-f01.json`. These are preserved legacy financial failures, not six successes or skipped cases. They cover partial/full refund, funded dispute, candidates stale from refund/dispute and mixed settled/pending refund attribution. Original F01 source and historical SQL remain unchanged.

**Separate existing reconciliation defect:** `ReconciliationService.issue` omits the closing SQL parenthesis in its INSERT (current [service line 79](../../apps/api/src/reconciliation/reconciliation.service.ts#L79)). Real discrepancy publication raises **42601**, `syntax error at end of input`, on both 0009 and 0010. The comparison checks one additional FAILED run, no issue row and unchanged financial balances in each phase. Matched reconciliation and seeded note-only issue resolution are separately tested. This remains an unresolved runtime defect, not a new R2-A regression or successful discrepancy publication.

## 7. SQL permit, privilege and finality guarantees

Reviewed the complete migration, not just the ownership helpers. Canonical roots use family/operation/phase/currency uniqueness, typed foreign keys and exact immutable accepted-command identity. Capture/refund share their respective terminal slots; internal/dispute acceptance is explicitly refused until its contract exists. Source/effect links, roots, manifests, permits, applications, dispositions and revision effects have immutable UPDATE/DELETE/TRUNCATE protection. Nullable typed relationships are supplemented by explicit shape checks; checked-in SQL remains authoritative for guarantees the Drizzle mappings do not express, including deferred constraints, triggers and grants. Schema push/generated replacement SQL was not used.

The issuer requires READ COMMITTED, current private inbox claim, account SHARE → canonical advisory → scope NKU → ordered operation/lot/allocation locks, then the shared proof reader and an installed SQL plan. Permit identity comes from `pg_current_xact_id()`, backend PID and authenticated principal. Workers cannot provide trusted before/after calculations, insert protected authority, or use a UUID/GUC as a permit. Actual restricted LOGIN tests cover cross-transaction/backend reuse, savepoint rollback/reissuance, full rollback/retry, one operation per transaction, stale claim/proof/revision, wrong owner and forged authority.

Application→effects checks require final workflow, immutable audit, exact source disposition, whole manifested effects and a complete installed validator. Effect→application checks refuse missing entire applications and final manifested rows at deferred COMMIT. Missing groups and partial dispositions also fail at explicit immediate constraint checks. Guarded revision effects and claim-conditional completion are part of finality. Source acknowledgments are bound to the exact original obligation revision or owned D02 source; contradictory late evidence remains a separate blocker. Delivery recovery and unsupported proof alternatives remain closed. No broad payment-match or note-only financial clearance is installed.

Independent installed-catalog checks found **14 protocol functions** (13 application-owned, one admission-owned revision function), all SECURITY DEFINER with pinned `pg_catalog, pg_temp` and no PUBLIC EXECUTE; **39 enabled effect triggers** on 13 relations, including 13 initially deferred finality triggers; and two restricted NOLOGIN owners with no memberships, schema CREATE, ledger table DML or ledger column DML. The correction's extra grants are SELECT on the authoritative source relations; ordinary writers gain no permit-table or issuance authority. The 35-case foundation suite independently passed, including actual distinct-backend issuer blocking. Existing F02, allocation, B.1/R0/R0.2/R1/D02 role and concurrency suites passed in the full matrix.

The structural suite installs a private administrator-owned SQL probe only in its disposable database. Its full validator returns **false**. It tests the common authority/refusal protocol and cannot approve a real monetary application. PostgreSQL's [deferred trigger semantics](https://www.postgresql.org/docs/18/sql-createtrigger.html), [SECURITY DEFINER guidance](https://www.postgresql.org/docs/18/sql-createfunction.html) and [transaction information functions](https://www.postgresql.org/docs/18/functions-info.html) were consulted; actual PostgreSQL execution supplies the evidence above.

## 8. Migration compatibility

Independently reran [all five migration cases](../../apps/api/test/integration/financial-application-migration.spec.ts): **5 passed / 0 failed / 0 skipped**.

- Fresh eleven-migration installation and repeated migrator no-op leave all nine R2-A relations empty, including contracts/enrollment.
- The original `42702` payment-INSERT compatibility regression passes with no permit or enrollment.
- A populated 0009 upgrade retains journal, allocation, original receipt/proof and genuine D02 byte fingerprints, preserves ledger immutability and keeps runtime readiness UNINSTALLED.
- Injected late DDL failure rolls back new relations, owner and added ownership keys without changing financial/source fingerprints; subsequent complete application succeeds.
- A real legacy table writer blocks forward DDL on a distinct backend, observed through `pg_blocking_pids`; after release, migration commits and repeats safely.

Migration 0010 adds four ownership uniqueness keys and nine new relations without rewriting historical financial rows, changing legacy defaults or activating scopes. Existing 0000–0009 SQL and the first ten migration-journal entries remain unchanged relative to the accepted parent. Hosted PostgreSQL 17 and an operational installation/drain window were not tested. The observed DDL wait is not an online-install or universal deadlock-freedom guarantee.

## 9. Exact independent verification

Environment: Windows, **Node 24.19.0**, cached **pnpm 10.26.0**, actual server **PostgreSQL 18.6 on x86_64-windows, MSVC 19.44.35228, 64-bit**, loopback port **55434**. Used the supported approved host-execution mechanism and existing verified configuration, never an alternate path around a denied operation. Each phase created a uniquely named disposable database before migration; migration fixtures created additional disposable databases. No migration targeted a shared/production database. No provider consumer or live reconciliation was started; provider/broker boundaries remained fixtures.

| Independently executed check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Original reviewer suite, focused | 5 | 0 | 0 |
| Supplemental ownership suite, focused | 33 | 0 | 0 |
| Foundation/permit/role/deferred suite, focused | 35 | 0 | 0 |
| Legacy before/after comparison, focused | 14 | 0 | 0 |
| Migration compatibility, focused | 5 | 0 | 0 |
| Complete financial/evidence/admission/migration matrix | **828 / 28 suites** | **0** | **0** |
| Separate original F01 | 0 | **6, baseline-identical** | 0 |
| `pnpm test` | **50 unit cases / 12 suites** | 0 | **834 database opt-outs / 29 suites** |

The matrix's Jest runtime was **216.290 seconds**. Focused runs cover 92 distinct cases already included in the 828; do not add these overlapping totals. Default database opt-outs do not count as PostgreSQL evidence. The web test script prints its existing notice and runs no browser suite.

The full matrix includes capture foundation/integration/migration **30/27/5**, refund **63**, dispute **70**, settlement **73**, integrated accounting **44**, F02 **17**, existing financial concurrency **5**; B.1 evidence/migration **64/6**; R0 admission/original review/migration **50/31/6**; R0.2 conflicts/migration **56/6**; R1 signed HTTP/reviewer **65/15**; D02 observations/native transport/SQL review/original reviewer/migration **51/17/29/4/2**; and the five R2-A suites **35/14/5/33/5**. All 28 suites passed without skips.

Additional executed checks: **`pnpm lint`, `pnpm build`, post-build `pnpm typecheck`, and `node scripts/sync-agent-skills.mjs --check` passed**. No dependency installation or lockfile change was needed. Cached pnpm was selected with task-local COREPACK_HOME and network disabled. Default tests used writable workspace TEMP/TMP; explicit PostgreSQL phases used `--cacheDirectory ../../.tmp/jest-r2a2-rereview`. No execution permission, PostgreSQL configuration, ACL or permanent Jest setting was changed.

Reproduction runner: ignored `.tmp/r2a2-rereview-run.cjs`, copied from the inspected recovery runner with fresh evidence/database/cache names. Executed `node .tmp/r2a2-rereview-run.cjs <phase>` for `reviewer`, `supplemental`, `foundation`, `matrix`, `legacy`, `migration`, `f01`. It sets `RUN_DB_TESTS=1`, `RUN_MIGRATION_TESTS=1` and private disposable URLs; only F01 sets `RUN_F01_PENDING=1`. The matrix selects `test/integration` and excludes only `settlement-f01.pending`; focused phases use `--runTestsByPath`. Exact pnpm/Jest commands and JSON/logs are retained as `.tmp/r2a2-rereview-<phase>.{json,log}`. Secrets are not printed or committed.

Read-only post-phase catalogs cover **60 newly created disposable databases**: **zero ACTIVE scopes, zero enabled financial evidence accounts, zero finalized financial applications**. Source inspection finds R2 financial-application names only in schema mappings, with no registered service/module/controller/job/consumer integration. Fresh-install registries are empty; test-only enrollments/probes do not activate a writer. Older retained databases were not exhaustively recertified. All databases, roles and immutable test history were retained, and the existing local server was left running.

## 10. Remaining limitations and future dependencies

| Boundary | What this review establishes / what remains |
| --- | --- |
| Installed SQL | Independently verified dormant ownership refusal, current permits, finality backstops, restricted roles, migration/legacy compatibility and the executed transaction schedules |
| Dormant common framework | Actual restricted-role preparation/refusal works; no complete successful new-policy monetary application was exercised |
| Operation validators | No production contract is installed. Pre-lot capture/auth/void/failure proof and R2-B adapters remain unimplemented; refund/dispute/internal settlement/payout validators, exact grouped journal semantics and typed recovery remain later checkpoints |
| Existing correctness findings | F01's six original failures remain; F04 active-path admission and separate F05/F06 corrections remain open. Numeric/fee-term and mutable account-metadata limitations are not certified away. Reconciliation `42601` remains separately unresolved |
| Operational/hosted evidence | PostgreSQL 17 hosted exact-diff CI, Node 22/24 hosted checks, genuine Stripe/broker/Redis behavior, D03 cohort evidence, complete compatible writer floor, credential/session/restart fencing and explicit installation/activation remain separate gates |

Passing legacy tests proves compatibility with existing behavior, including known defects. It does not establish the safety of every future new-era application. This review does not authorize or start R2-B, financial scopes, a live writer, shared/production migration, deployment or real payment.

## 11. Preservation, documentation checks and final verdict

Documentation validation passed for **58 Markdown files / 868 relative links and anchors**, with CI YAML parsed and its structure checked. Nineteen unchanged Mermaid blocks were inventoried, not parsed or rendered. `git diff --check` and direct final-newline/trailing-whitespace checks of the new report and navigation passed.

The final inventory confirms that the only repository changes made by this review are this file and one new link in [the documentation index](../README.md). All other starting repository bytes, including the author's implementation/recovery record, verification edits, all tests, migration 0010, historical 0000–0009 and prior reviews, remain identical. All 40 saved marker contents were restored after retaining this run's database identities separately. Existing result JSON/logs remain identical, apart from the running local server's own appended log: its entire original prefix was independently hash-matched and retained. The first inventory assertion flagged that live-log growth; after distinguishing append-only server output from edited evidence, preservation validation passed. No historical log was truncated or restored over new history. HEAD remains unchanged and the index is empty.

The only intended review deliverables are this report and its navigation link. Ignored `.tmp/r2a2-rereview-*` holds this run's runner, private markers, new logs/JSON, installed catalogs, preservation inventory and summary. The six expected F01 failures and separate reconciliation `42601` are reported explicitly above; no financial assertion was weakened, deleted or skipped to obtain acceptance.

**APPROVE_DORMANT_R2_A_CHECKPOINT**

Both original P1 ownership defects are independently resolved; all five unchanged reviewer cases pass; no new P0/P1 foundation defect was identified; legacy compatibility, restricted authority and closed unsupported paths are preserved. The corrected foundation is accepted only as a dormant checkpoint pending the owner's subsequent commit decision and hosted PostgreSQL verification. No commit, push, activation, financial writer registration or R2-B work occurred.
