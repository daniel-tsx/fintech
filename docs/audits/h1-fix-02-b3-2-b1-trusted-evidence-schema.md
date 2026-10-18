# H1 Fix 02 — B3.2 B.1 trusted evidence schema

Status: **IMPLEMENTED, DORMANT — READY_FOR_INDEPENDENT_REVIEW**. Recorded 2026-10-18. No commit, runtime integration, scope activation or deployment is performed in this run.

[Database design](../database-design.md) owns current schema behavior. The normative design remains [Run A.1 section 21](h1-fix-02-b3-2-runtime-cutover-design.md#21-run-a1-corrective-revision-trusted-correlation-evidence), its [independent acceptance](h1-fix-02-b3-2-design-review.md#14-run-a1-independent-correlation-evidence-acceptance-review), and the [approved human decisions](h1-fix-02-b3-2-human-decisions.md). Their history is unchanged. This record owns implementation evidence and the remaining staged dependencies.

## 1. Baseline and authorization

Started on clean `main`, HEAD `b8658f4893c4dc8b69094471d7c54745253b8725`, tracking local `origin/main` at the same revision, with an empty index and worktree. That decision commit is available locally. All 12 decisions are approved as design policy; the specific authorization is B.1 schema/SQL/tests only, with a separate independent review before commit.

Consulted agent/routing/workflow and required H1/B1/B2/B3.1 records; inspected the current receiver/normalizer/processor, accepted command and mirror references, financial schema, migration journal and allocation validators. Current refund/dispute/settlement runtime remains legacy; the separate allocation-aware services remain disconnected. Historical migrations 0000–0005 and original design/review/decision records are unchanged.

H05's D01 evidence contract and H08's conservative historical treatment drive this change. H02/H11 prohibit automatic activation; H07 informs limited function ownership without rotating any existing credential. H03/H04/H06 admission and payout policy are preserved for later implementation. This checkpoint implements none of their runtime guards, worker fencing or cutover.

## 2. Changed files

| Path | Change |
| --- | --- |
| `apps/api/drizzle/0006_trusted_financial_evidence.sql` | Forward evidence storage, SQL projection/sealer, immutable protections, narrow function owner and closed financial-reference gate |
| `apps/api/drizzle/meta/_journal.json` | Append index6, tag `0006_trusted_financial_evidence`, timestamp1792281600000; earlier entries unchanged |
| `apps/api/src/database/schema.ts` | New table declarations, bytea mapping, additive financial proof references and closed-floor constraints |
| `apps/api/test/support/trusted-evidence-fixtures.ts` | Explicit isolated SDK-signed receipt and trusted result fixtures, accepted outbox/capture provenance |
| `apps/api/test/integration/trusted-financial-evidence.spec.ts` | 64 SQL/provenance/role/rollback/concurrency cases in a separately retained disposable database |
| `apps/api/test/integration/trusted-evidence-migration.spec.ts` | Six fresh/upgrade/history/rollback/DDL-lock cases, each using disposable databases |
| `apps/api/test/integration/capture-accounting-migration.spec.ts` | Seven-migration count/title only; financial assertions preserved |
| `apps/api/test/integration/integrated-accounting-verification.spec.ts` | Migration count6→7 only |
| `apps/api/test/integration/settlement-accounting-integration.spec.ts` | Seven-migration count/title only; financial assertions preserved |
| `docs/database-design.md` | Owning schema description and staged enforcement/privilege limits |
| `docs/verification.md` | Commands, isolated-database/role requirements and local verification record |
| `docs/README.md` | Current design decision status and this checkpoint link |
| This record | Implementation/verification handoff and review priorities |

No live service, controller, module, provider command, broker transport, job, payout writer, money type, dependency or historical migration changed. Temporary database setup, migration-copy fixtures, cache and logs remain ignored under `.tmp/`.

## 3. Exact schema additions

| Relation | Durable purpose and keys |
| --- | --- |
| `financial_evidence_accounts` | Configured `(provider,provider_account)` intake identity; immutable `runtime_enforcement='UNINSTALLED'`. Migration inserts no configured account. It supplies only narrow evidence-publication/sealing serialization, not settlement/payout admission. |
| `provider_financial_receipts` | One original inbox UUID; exact signed bytea body/signature, headers and normalization snapshot/version, restricted publisher attestation/version, received and verified timestamps. FK to configured account and original inbox. |
| `provider_financial_observations` | Immutable COMMAND_RESULT/PROVIDER_LOOKUP source identity, exact object, owned command/outbox/key snapshot and child/amount/currency/PI/Charge facts where applicable. Unique provider/account/source-kind/source-key. |
| `provider_financial_object_owners` | Unique provider/account/object-kind/external-ID → owned refund or natural provider dispute identity, payment/merchant/currency/principal. Composite ownership FKs; no uniqueness on capture PaymentIntent. |
| `webhook_financial_evidence` | One sealed proof per inbox, revision1/contract1, typed operation/object/owner/amount/outcome, binding, optional owned refund witness/internal dispute, frozen original capture sources and attempt revision. Unique `(inbox,revision,payment,merchant,currency)` target. |
| `financial_evidence_reviews` | Append-only, idempotent `(inbox,review_key)` unresolved/contradictory/unsupported observations, including unknown ownership without a fake merchant. No field claims financial resolution or clears admission. |

Existing refund allocations gain `evidence_contract_version` and `proof_revision`. Dispute allocations gain the version plus separate open/close inbox/revision references. Hold effects gain the version and proof revision. Composite FKs target the same owned proof tuple; reference indexes are installed. **All new financial references are forced NULL and all versions forced0 in B.1.** They are not a partially working version1 application path.

Capture source JSON is generated by SQL from protected lots, successful attempts, immutable POSTED originals and trusted capture-command observations. Amounts in that JSON are decimal strings to preserve exact values across JSON consumers; the projection's financial amount is PostgreSQL bigint with the current safe ledger/API bound. Reader validation checks source IDs, owned amounts, journal identity, financial capture timestamp and immutable observation relationships. Source arrays are checked by SQL rather than implemented as array-element FKs; the referenced lots, journals and observations have deletion protections. This merits focused review.

## 4. Original receipt and trust boundary

The existing inbox UUID/provider-event uniqueness is unchanged. Signed request bytes are never reconstructed from normalized JSON. A trusted publisher must verify with Stripe's SDK outside database financial locks, then publish the original bytes/signature and actual normalization snapshot. In tests that verification genuinely runs locally with generated test signatures; no HTTP provider request occurs.

PostgreSQL checks declared attestation structure, immutable lineage, raw/normalized agreement and a version1 event/object/status allowlist. It does **not** verify Stripe HMAC, authenticate an external command response, or infer verification from a pre-existing inbox row. Restricted receipt/result publishers are declared trusted inputs; B.1 supplies no live publisher or login grants. A database owner/superuser remains outside ordinary-role guarantees.

Receipt insertion locks its private inbox before account intake SHARE and compares original provider/signature/headers/payload. All retained fields are immutable. A separate narrowly owned header trigger protects receipted inbox headers without changing the original payload trigger or requiring status-only legacy workers to read private receipt tables. Tests exercise an ordinary legacy role with no such SELECT grant. Mutable lease/status fields remain available.

Publication also performs `UPDATE webhook_events SET updated_at=updated_at` under that private lock. This creates a row version so a stale repeatable-read header writer aborts with40001 instead of missing the newly committed receipt in its old snapshot. The value of updated_at and all original fields remain unchanged; the regression compares timestamp text without JavaScript precision loss. Current UPDATE triggers only check original evidence; the headers-only guard is not fired by the timestamp-column write. There is no DB timestamp/version counter setter or automatic audit trigger here. Future triggers require review of this intentional same-value write.

## 5. Object ownership and trusted provenance

Refund correlation starts with a signed `re_` object. An explicit signed refund ID identifies the accepted refund/command/key/amount/currency and frozen capture attribution even when other optional metadata is absent. With refund ID absent, an exact immutable COMMAND_RESULT witness must link that object to that accepted refund. A mutable PI/amount match or PROVIDER_LOOKUP row cannot substitute. Conflicting witnesses/explicit metadata are rejected; otherwise-proven callbacks do not require an already-populated refund mirror.

Disputes use signed `dp_` identity and uniquely owned original capture evidence. There is no invented dispute command. PI or Charge-only discovery uses qualified successful capture-command observations; multiple payment owners remain unresolved. Existing internal dispute ownership/principal and terminal outcome must agree. First-open proof may have no internal dispute UUID; no financial dispute row is created speculatively.

At sealing, current owned mirrors are checked before any synchronization and cannot authorize proof on their own. Original capture gross/fee/net/time come from the immutable financial originals, never current merchant fees. Two captures sharing one PI are explicitly tested, preserving two original journals and frozen sources. Signed account/amount/currency/PI/Charge/explicit owner contradictions fail closed.

## 6. SQL reader, sealer and replay

`financial_receipt_facts(inbox)` validates retained original facts and supported confirmed classification. `build_financial_evidence(inbox,refund_observation)` derives canonical evidence from references, not arbitrary caller owner/amount objects. The controlled `seal_financial_correlation(inbox,expected_attempt_revision,refund_observation)` writes one immutable object binding and proof; repeat sealing returns the original proof. A supplied replay witness must match the saved owner rather than silently replacing provenance.

`load_effective_financial_evidence(inbox,proof_revision,expected_operation)` is the shared typed SQL interpretation. It rejects NULL arguments, absent/wrong event/revision/operation, explicit original contradictions and invalid ownership/provenance. It joins the original receipt and immutable binding, verifies the frozen capture chain, and leaves original evidence unchanged. Historical reading does not depend on today's mutable mirror status. Current contradiction/admission handling is still a B.2 responsibility; a valid immutable projection is **not** permission to apply money.

Proof revision is fixed at1. Additional observations may support the first seal, but a sealed proof is not edited or retargeted, including before application. A bad sealed mapping requires separately reviewed recovery. The sealer performs no journal, state transition, audit, disposition or resolution write. Failures abort the caller transaction; later review recording must be a separate safe transaction, not a catch that commits partial financial work.

## 7. Locking and isolation

Sealing uses one private inbox → configured account intake UPDATE → canonical merchant/currency advisory → scope → payment NO KEY UPDATE → ordered capture/refund/dispute children → ordered lots/allocations → one immutable object owner/proof. Discovery is revalidated after financial parent locks. Receipt/observation publishers take the account lock in SHARE mode, with receipt inbox first. There is no proof UPDATE lock, second-scope acquisition or network call.

The sealer rejects non-READ-COMMITTED transactions instead of asserting fresh discovery under unsupported snapshots. The reader can return immutable historical proof; it grants no cached financial permit. Both-order private-inbox and conflicting cross-scope ownership schedules observe distinct backend PIDs and `pg_blocking_pids`, use explicit pre-commit gates, bounded observation waits and awaited cleanup. No deadlock is swallowed or retried into a pass.

This sealer owns its prefix and requires entry **before** any shared intake or later financial locks. B.2 must use a separate correlation transaction, followed by reader-only admitted application, or review a coordinated replacement. Calling this B.1 sealer after taking intake SHARE/A/S would introduce a forbidden lock upgrade; it is not an integration shortcut. Committed proof can remain truthful/unapplied across a later application rollback, as the approved two-transaction design permits.

This prefix is **dormant**, not the completed H04/H05 admission floor. Legacy refund/authorization/mirror reverse edges still exist and prohibit calling it from partially integrated live paths. B.2 must coordinate intake modes/current policy/epochs/claim authorization and every writer before activation. The account row alone does not guard existing settlement or payout. The [PostgreSQL locking reference](https://www.postgresql.org/docs/17/explicit-locking.html) informs the reviewed order; the reported wait observations are local executed evidence, not universal deadlock freedom.

## 8. Immutability and privileges

All six new evidence relations reject UPDATE/DELETE/TRUNCATE. Ordinary workers receive no table INSERT rights to receipts, observations, bindings or proof by default. New function PUBLIC EXECUTE defaults are revoked. No live worker/publisher login or existing membership/credential is modified.

Migration creates a per-database `fintech_evidence_<md5(database)>` **NOLOGIN/NOINHERIT**, non-superuser/non-CREATEROLE/non-BYPASSRLS owner for the sealer and narrow header guard. It can SELECT required original evidence and INSERT only bindings/proofs. Necessary row-lock permissions are limited to nonfinancial timestamp columns. It has no ledger INSERT/UPDATE/DELETE/TRUNCATE or schema CREATE rights after installation. Functions pin `pg_catalog, pg_temp` and qualify persistent objects. Seven other new routines are invoker-based. See [function security](https://www.postgresql.org/docs/17/sql-createfunction.html) and [role attributes](https://www.postgresql.org/docs/17/sql-createrole.html).

Tests run receipt/result publication, valid sealing/reading and negative table/function permissions under real restricted non-owner roles using SET LOCAL ROLE. They inspect the non-login owner attributes, every ledger write privilege and lack of worker membership. Owner-only fixture setup is not substituted for those checks. Existing F02 functions remain invoker-based and unchanged.

Installation requires an administrative migration identity with CREATEROLE and function ownership authority; ordinary runtime credentials should not carry that capability. No runtime credential separation/rotation, receipt publisher implementation, operator grants or old-worker/session fence was executed. An application still configured with an unrestricted owner login does not gain ordinary-role isolation merely by applying this migration.

## 9. Migration, historical compatibility and the closed gate

`0006_trusted_financial_evidence`, journal index6, is appended after the six existing migrations. Transactional installation takes ACCESS EXCLUSIVE locks on inbox/refund-allocation/dispute-allocation/hold tables in fixed order, with a 10-second lock wait bound. These locks cover additive columns/FKs and validation scans and can block reads and writes until commit. New indexes are ordinary transactional builds; no concurrent-index or zero-downtime claim. CREATE ROLE also touches cluster role catalogs. An unexpected pre-existing generated owner name refuses installation rather than adopting that role.

Fresh empty-chain installations measured about 0.31–0.55 seconds; the final corrected-chain setup measured323ms. This is not a large-history benchmark. An actual competing writer was observed blocking maintenance DDL before release. A deliberately appended late migration error rolls back tables, columns, functions and the new role together; previous journals/entries/lots/allocations/inbox and function definitions remain unchanged. Repeated migrator execution is a no-op.

Previously valid committed evidence stays under original validation with added nonfinancial version0/NULL metadata. Missing raw signatures, unverified complete-but-unapplied history, or orphan capture evidence receives no attestation/proof/eligibility. No monetary row is rewritten or repaired. Upgrade compares original-row fingerprints excluding only newly added metadata and hashes original validator definitions. Original POSTED entries still reject mutation.

**Staging decision:** replacing 0004 payload readers globally now would break accepted dormant services that cannot yet supply a sealed proof or atomic final disposition. B.1 therefore preserves both original validators and installs a fail-closed DDL boundary instead of a permissive payload fallback:

- Scope status still structurally excludes ACTIVE.
- Every account's immutable enforcement state is UNINSTALLED.
- `assert_financial_evidence_runtime_ready()` unconditionally refuses new-contract application.
- Financial reference constraints require version0 and NULL proof references. Explicit version1, NULL version, or version0 with a proof is rejected, including after journal insertion; the whole transaction rolls back.

Version0 here means **old evidence format**, including new legitimate legacy/dormant-fixture writes; it is not a claim that those rows predate migration or are activation-eligible. Default0 exists only behind the closed foundation gate. Version1 financial success/failure/open/close/hold application is unavailable in B.1, even with valid proof. Existing legacy writers remain lawful under their original contract; their successful regressions are not evidence of new-policy integration.

Opening the gate requires a separately reviewed forward migration and coordinated adapters, not an ordinary UPDATE/feature flag. Before permitting any new-contract reference it must install protected historical-era stamping/default1/no-version0-insert-or-downgrade guards, original payload replacement through the shared reader, whole-effect/audit/workflow/inbox deferred linkage in both directions, and current policy/admission/claim enforcement. No intermediate mixed writer deployment is authorized. Removing only a CHECK or changing an account string is insufficient.

## 10. Application/SQL coverage and explicit B.2 dependencies

| Current validator/path | B.1 treatment | Required later gate |
| --- | --- | --- |
| `prepare_capture_allocation_write`, refund final/released original IDs/type/currency | Original strict function unchanged; future composite proof reference exists but is closed | Replace ownership interpretation for version1 with the shared reader; preserve parent version writes, frozen attribution and lot revision |
| `check_capture_allocation_effect`, original refund amount and journal/group checks | Original strict function unchanged; new proof reader validates exact original facts independently | Replace amount/evidence interpretation consistently, preserving all fee/capacity/common-journal checks |
| Dispute open/close | Separate future inbox/revision references installed, forced NULL | Require correct whole-operation open/close proof/outcome, including zero-funded/open and zero-release/win evidence |
| Hold reduction cause | Future proof revision/composite ownership FK installed, forced NULL | Bind actual causing refund success/dispute loss, including another held dispute |
| New financial effect/application/disposition | Refused by closed gate; no partial v1 application path | Deferred checks on relevant financial and inbox/application rows: no orphan new effect, false APPLIED/PROCESSED, missing audit, mixed group or partial state |
| Refund/dispute consumers and processor | Production sources unchanged, still payload-based; no new runtime registration | Pass caller TX/current permit/inbox/revision to shared reader and preserve exact service disposition/claim generation together |
| Mirrors/command results/reconciliation (D02) | Immutable source schema and accepted-command validation exist; no live producer/lifecycle | Trusted publisher capabilities, stable duplicate/conflict comparison, confirmed non-inbox blocker before callback, later webhook linkage/clearance and no note-only resolution |
| Historical unsupported/ignored evidence (D03) | No manufactured signed body/attestation or automatic proof backfill | Real inventory, trusted recovery where available, continued exclusion/review where unavailable |

E01/E02 and E07–E19 SQL/provenance/immutability/compatibility families have B.1 coverage. E03–E06 actual version1 service/application and monetary replay are not implemented; existing v0 financial suites prove compatibility only. E20–E22 cover closed-reference rejection and transaction/F02 abort, not the future full v1 disposition validator. E23 full claim fencing, E25 epochs, E26 receipt/settlement and E27 payout admission remain unimplemented. E24's B.1 test is sealer versus reader plus refused application; it is not a runtime-admission race. E28 and cross-scope object-owner sealing have actual controlled waits. Do not report the complete E01–E28 runtime plan green from these 64 cases.

## 11. Verification results and exact commands

Local Node24.19.0, pnpm10.26.0, PostgreSQL18.6. Existing disposable cluster only, bound to127.0.0.1:55432. Main final database is recorded in `.tmp/h1-b32b1-db.txt`; pending evidence has a separate retained database recorded in `.tmp/h1-b32b1-evidence-db.txt`. Migration tests retain additional UUID-named databases. No immutable histories are deleted.

| Command | Result |
| --- | --- |
| `node .tmp/h1-b32b1-fresh.cjs` | Fresh unchanged 0000–0005 plus new0006 installed; final representative empty-chain time323ms |
| `pnpm lint` | Passed API/web |
| `pnpm typecheck` | Passed API/web |
| `pnpm test` | Passed50 unit cases;410 database cases skipped by default, separately executed below; web test script is a notice |
| `pnpm build` | API/web production builds passed with permitted local output writes |
| Green PostgreSQL command below | **404 passed, 11 suites, 0 failed, 0 skipped**: existing334 plus new64 evidence +6 migration |
| F01 command below | Expected **six financial assertion failures**, exit1, 0 skipped; original file unchanged |
| `node .tmp/validate-docs.cjs` | Passed39 Markdown files/514 relative links and anchors; CI YAML structure checked;19 existing Mermaid blocks extracted, not parsed/rendered |
| `git diff --check` and direct untracked-file whitespace checks | Passed; staged index empty; no unrelated line-ending normalization |

Green PostgreSQL command from repository root, with RUN_DB_TESTS=1, RUN_MIGRATION_TESTS=1, DATABASE_URL naming the disposable main database and local MIGRATION_ADMIN_URL:

```text
pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-integration.spec.ts test/integration/refund-accounting-integration.spec.ts test/integration/dispute-accounting-integration.spec.ts test/integration/settlement-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts test/integration/integrated-accounting-verification.spec.ts test/integration/trusted-financial-evidence.spec.ts test/integration/trusted-evidence-migration.spec.ts --cacheDirectory ../../.tmp/jest-b32b1 --json --outputFile ../../.tmp/h1-b32b1-all-pg-final.json
```

Existing suite counts are capture27, refund63 (including B2.2.1), dispute70 (including B2.3.1), settlement73, foundation30, migration5, F02 sealing17, concurrency5 and integrated44. Only three expected migration counts/titles changed from six to seven; no accepted financial assertion was weakened.

Separate F01 command with RUN_DB_TESTS=1 and RUN_F01_PENDING=1:

```text
pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-b32b1 --json --outputFile ../../.tmp/h1-b32b1-f01.json
```

Full command output/JSON, build/static/unit logs and database setup remain ignored under `.tmp/h1-b32b1-*`. PostgreSQL17 is **NOT RUN**: its installed directory has data only, no executable binaries. No hosted CI, real Stripe/RabbitMQ/Redis, HTTP receipt/dispatcher, external reconciliation, deployment, production/shared migration, real credential/session change or large-history benchmark is claimed.

## 12. Initial failures and corrections

- Default Corepack attempted a network lookup; reruns used the installed offline cache via `COREPACK_HOME=C:/Users/Daniel/AppData/Local/node/corepack` and `COREPACK_ENABLE_NETWORK=0`, with no installation/dependency change.
- Sandbox localhost access initially returned EACCES, then startup recovery briefly returned ECONNREFUSED/rejecting connections. The existing isolated cluster recovered after a permitted start. Database checks ran only after readiness.
- Initial0006 install found a PL/pgSQL CASE-expression syntax error; parenthesized comparison fixed it before the passing fresh install. Historical SQL was untouched.
- Initial static checks found untyped fixture query results and incorrect use of an idempotent result instead of `.value`; corrected fixture typing/access, then reran static checks.
- First full new evidence run passed49/50; its F02 rollback fixture lacked required account name/header description and failed before the intended deferred boundary. Corrected fields; the actual deferred rollback case subsequently passed.
- Initial combined green run passed401/403: legacy global inbox pollers consumed deliberately pending B.1 fixture evidence before their own capture receipts. The B.1 suite now creates a separately retained disposable database. It preserves PENDING receipts and every old financial assertion, eliminating fixture-order dependence; the fresh combined rerun passed403/403.
- Final snapshot review found receipt publication's row lock alone did not invalidate a stale repeatable-read header writer. The new ordinary transaction regression failed before correction because the stale UPDATE committed. The same-value inbox version write fixes that schedule without changing evidence/timestamps; final complete execution passed404/404, including the new regression. Its retained failing baseline is `.tmp/h1-b32b1-header-before.{log,json}`.
- Initial default `pnpm test` ran no cases because sandbox Jest transform-cache rename hit EPERM. Setting TEMP/TMP to ignored workspace `.tmp/b32b1-jest-temp` allowed the passing50-unit rerun. Build used permitted filesystem execution; no live service started.

## 13. Dormancy, limits and review gate

The successful suites assert zero ACTIVE scopes; the final catalog check covers both the main and separate evidence databases. Scope constraints remain unchanged; every configured evidence account stays UNINSTALLED, proof references cannot be applied, no new dispatcher is registered and no runtime producer calls the new routines. DDL/role changes were exercised only on disposable local databases, not production/shared roles or sessions.

**READY_FOR_INDEPENDENT_REVIEW** as a dormant evidence checkpoint. This is not application/SQL integration completion, a deployable partial writer floor, F01/F04/F05/F06 closure or permission to start B.2. Main financial behavior remains legacy, and F01's six regressions remain intentionally red.

Focused independent review should verify:

1. The closed gate/default0 staging cannot be mistaken for new-policy enforcement; the later protected era/default1/operation-policy and deferred-effect gate is mandatory before activation.
2. Raw/normalized/account/outcome agreement, exact accepted refund command and capture provenance, ambiguous/reused objects, optional metadata and no mutable-mirror authority.
3. The sealer's role grants/owner safety, PUBLIC revocation, pinned qualification and the absence of ledger mutation; operational publishers/credentials remain unavailable.
4. Immutable proof/binding/receipt/review data, replay reference checks, frozen decimal-string sources and composite reference shapes.
5. Explicit/implicit lock acquisition, READ COMMITTED restriction and scope/account/inbox orders; no partial live adoption with legacy reverse edges, and no entry to this self-locking sealer after intake SHARE/A/S.
6. Existing history/function fingerprints, atomic late migration/role rollback, lock duration and fresh/repeated installation.
7. Actual coverage limits: all positive new-contract financial application, full claim/disposition, receipt/spending admission, runtime producer and epoch/cutover tests still belong to later authorized checkpoints. Review the intentional receipt-parent row-version write and its before/after repeatable-read evidence.

## 14. Final catalog and scope evidence

Read-only checks after the final404-case run found:

| Database | Migration rows | ACTIVE scopes | Evidence accounts outside UNINSTALLED | Receipts / sealed proofs |
| --- | --- | --- | --- | --- |
| `fintech_h1_b32b1_1792295854793` | 7 | **0** | **0** | 0 / 0 |
| `fintech_b32b1_evidence_a9aa143d4229401c9dc3b76c5685992c` | 7 | **0** | **0** | 66 / 35 |

Catalog output is retained in `.tmp/h1-b32b1-catalog-final.json`. All nine new routines have pinned `pg_catalog, pg_temp`; the two narrowly owned routines are the sealer/header guard and seven are invoker-based. Built Drizzle declarations match all six migrated evidence tables' column names/nullability. PostgreSQL migration regressions preserve original validator definitions and monetary rows. The historical migration/design/review/decision/F01 files match their Git-normalized HEAD contents, and all six existing journal entries are preserved. An initial raw-byte comparison incorrectly treated an existing CRLF checkout of the human decision file as changed; the corrected comparison normalized line endings in memory only, without modifying files.

Final documentation checks passed39 Markdown files and514 links/anchors; CI YAML structure was checked and19 Mermaid blocks extracted without parsing/rendering. Tracked `git diff --check` and direct new-file whitespace checks passed. Manual scope inspection confirms13 intended files, no staged changes, no runtime writer/transport/dependency edits and no temporary files among deliverables. The original financial tests remain intact except three migration-count/title updates. No commit or push is performed. The local test cluster is shut down after verification; retained databases, logs and non-login fixture roles remain available for the independent reviewer.
