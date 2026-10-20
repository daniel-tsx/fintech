# H1 Fix 02 — B3.2 B.2-R2-A: independent foundation review

Status: completed evidence-preservation review, **2026-10-20**. **Verdict: REQUEST_CHANGES.**

Migration 0010's corrected dormant draft still has two P1 database integrity defects: an operation's protected scope can be missed when a journal has different ownership and no canonical root, and settlement-item protection can be missed through its payment reference. The retained final reviewer run contains **four failing regressions and one passing control**. The earlier 790-case compatibility result does not establish these missing ownership guarantees.

This finalization reads existing source and saved results only. The interrupted PostgreSQL authorization experiments were not resumed or repeated. No database connection, SQL execution, role change, additional probe, financial test, service startup or scope activation was performed in this continuation. No platform restriction was circumvented. Implementation and reviewer fixtures remain unchanged.

## 1. Baseline, scope and authority

Checkout: `C:\Work\Learning Projects\learn-fintech`, branch `main`, HEAD **449df0392f0fbffdcffe535c493ea9f1321e33bb**. The starting index was empty. The working tree already contained **18 uncommitted paths**: 12 modified tracked files and six untracked files, including the reviewer suite. These are existing work, not changes made by this finalization.

Read the repository AGENTS/CLAUDE guides, README, package scripts, [task matrix](../AGENT_START_HERE.md), [documentation index](../README.md), [verification](../verification.md), and the ledger/database/concurrency/settlement references. Review authority is the [R2 design](h1-fix-02-b3-2-b2-r2-financial-application-design.md), especially §§5.2, 5.3, 7 and 11, as refined by the [accepted independent design review §10](h1-fix-02-b3-2-b2-r2-design-review.md#10-proposed-r2-implementation-sequence). R2-A owns closed common structures and both directions of effect/application enforcement; complete operation validators belong to later checkpoints. Their absence cannot permit an unsupported protected write.

Inspected the complete [0010 SQL](../../apps/api/drizzle/0010_financial_application_foundation.sql), migration journal/schema diff, [current reviewer suite](../../apps/api/test/integration/financial-application-review.spec.ts), its fixture/harness, and the relevant original settlement constraints in migrations [0000](../../apps/api/drizzle/0000_cheerful_sunset_bain.sql) and [0004](../../apps/api/drizzle/0004_capture_accounting_foundation.sql). The [implementation record](h1-fix-02-b3-2-b2-r2-a-financial-application-foundation.md) retains the failed R2-A run and R2-A.1 correction history. Those histories and the approved design are not rewritten by this verdict.

The saved pre-interruption review inventory, `.tmp/r2a-review-start-hashes.json`, contains 250 files; all still matched before this documentation edit. This continuation also fingerprinted 316 repository/evidence files, including the current reviewer source and retained R2-A JSON/logs. Only the documentation changes listed in §7 are intended.

## 2. Existing evidence and its limits

The retained final result is `.tmp/r2a-review-adversarial-final.json`, corroborated by its `.log`: **5 tests, 4 failed, 1 passed, 0 skipped**, one failed suite, 20.961 seconds. These results were collected before the interruption; they were inspected, not rerun here.

The suite's administrator creates isolated fixtures and DORMANT enrollment. Writes under review use a separate authenticated NOINHERIT, non-superuser LOGIN with no role memberships and explicit limited ledger/item DML. The setup asserts no INSERT/UPDATE/DELETE privilege on `financial_application_permits`. Enrollment is a test fixture; the migration itself enrolls no scope. This demonstrates failures at the intended limited-writer database boundary, without claiming a reachable public API or a production credential configuration.

| Existing regression / source lines | Required assertion | Recorded final result |
| --- | --- | --- |
| Missing canonical root, different merchant; reviewer lines 61–67 | `P0001`, zero new journals, zero applications | `00000`, one new journal, zero applications |
| Missing canonical root, different currency; same parameterized case | Same rejection and rollback | `00000`, one new journal, zero applications |
| Protected settlement header with an unowned legacy-shaped candidate; lines 69–74 | `P0001`, zero new items | `00000`, one new item |
| Existing candidate retargeted to another payment; lines 76–83 | `P0001`, original payment and gross `10000` retained | `00000`, different payment persisted and gross `9999` |
| Actual protected journal scope; lines 85–89 | `P0001`, no new journal, zero ACTIVE scopes | Passed |

`00000` is the fixture helper's success marker, not a server-raised error. The journal helper inserts balanced platform-account entries and seals the journal as POSTED before transaction completion. The saved assertions count the resulting journals/applications; they do not independently print every entry or assert a merchant balance. The two item cases demonstrate committed candidate integrity failures, not successful settlement completion or a payout.

An earlier `.tmp/r2a-review-adversarial.json` has **five setup failures**, each caused by missing required `settlements.available_on`. It is not five additional confirmed integrity defects. The current pre-existing fixture supplies `available_on=now()`; the subsequent final run reaches the financial assertions above. Both runs remain retained. This continuation changes neither fixtures nor assertions.

Evidence identifiers (SHA-256):

| Artifact | Hash |
| --- | --- |
| Current migration 0010 | `f30cfb4fa18e1c13d1f8a77b5acfff9ab5095aaa01cb3dc4b88d0d4fb9c70ef4` |
| Current reviewer suite | `eceacfe6e4635958d279c5e406a13d18eb1ceca3e2f555f751a8bf7e7b8e3e17` |
| Final reviewer JSON | `c37dda2db7db34c2903f3539560bd0e3389535639d25e68042b3d04823a62a2c` |
| Final reviewer log | `d067ba2df6bbe2cd7de470867899ab2abb3b8febac9f0bf5120dd8116de04e46` |

Ignored `.tmp` artifacts are retained local evidence, not portable repository deliverables. The committed handoff should eventually retain this report and the unchanged reviewer regressions; no commit is made here.

## 3. Must fix: R2-A-IR01 — journal protection depends on claimed scope or an existing root [P1]

Location: `public.guard_financial_application_effect()`, migration 0010 lines 367–406, particularly 374–393; `public.check_financial_application_effect_finality()`, lines 407–419. Trigger bindings are `application_effect_permit` and deferred `application_effect_complete`, installed on financial relations at lines 426–434.

The immediate guard starts from the row's JSON `merchant_id` and `currency`, including raw OLD fields for updates. Its enrollment predicate is:

```sql
WHERE (merchant_id,currency)=(merchant,cur)
   OR (merchant_id,currency)=(prior_merchant,prior_cur)
```

For `ledger_transactions`, the only additional operation-based detection is:

```sql
FROM public.financial_application_roots root_row
JOIN public.financial_application_scope_authority scope_row
  ON (scope_row.merchant_id,scope_row.currency)=
     (root_row.merchant_id,root_row.currency)
WHERE root_row.operation_id=(n->>'business_id')::uuid
```

If neither predicate detects protection, `IF NOT protected THEN ... RETURN NEW` precedes `current_financial_application_manifest()`, the exact operation/business-type comparison, and the SQL-prepared before/after check. The guard does not resolve a CAPTURE business reference through its `payment_attempts`/payment ownership when its canonical application root is missing.

**Confirmed:** the retained merchant and currency cases reference a CAPTURE attempt owned by enrolled merchant A/USD, but supply another merchant or EUR on the journal. No root is created. Both commit one journal without an application. The ledger-entry branch first checks the claimed parent-journal scope and, if unenrolled, falls back to ledger-account ownership; the balanced platform accounts in these fixtures have NULL merchant ownership. That fallback supplies no protected merchant scope in these cases. Balance/currency checks and journal uniqueness cannot establish the accepted operation's ownership.

The deferred function does not repair the missing detection. It calls `validate_financial_application(m.root_id)` only when a current transaction/backend permit is found **and** its effect manifest names the row. With no permit it returns without validation. Application-side checks likewise cannot reject an application row that was never inserted. This is why closed operation contracts alone do not close the reverse implication.

**Affected invariant:** an effect referencing an owned operation in an enrolled scope must require current database authority and a complete canonical application, regardless of caller-supplied journal ownership, format, or omission of the root/application. A balanced POSTED journal is insufficient financial evidence. This violates R2 design §§5.2 and 7's prohibition on orphan effects and wrong ownership.

**Smallest correction:** derive protection and validate ownership from the authoritative typed operation/business reference as well as the journal fields. A missing root for an otherwise protected operation must refuse, rather than select the legacy return. Validate relevant OLD and NEW references on updates. Keep a commit-time backstop that cannot silently succeed solely because the permit/application is absent. Preserve genuinely unenrolled legacy behavior, F02 sealing, balance checks and business uniqueness; do not fix this by weakening the regression or enrolling all legacy history.

Only CAPTURE's two variants are experimentally confirmed here. Corresponding refund/dispute/settlement/payout paths require ordinary corrective review against their typed mappings; this report does not assert additional reproduced failures or a privilege escalation into trusted permit tables.

## 4. Must fix: R2-A-IR02 — settlement-item protection follows only the NEW payment [P1]

Location: `public.guard_financial_application_effect()`, migration 0010 lines 369–391, particularly the `settlement_items` branch at 381–382. Related ownership key: `application_settlement_item_scope` at line 14; application effect-link FK at line 124.

The branch derives its scope only with:

```sql
SELECT p.merchant_id,p.currency INTO merchant,cur
FROM public.payments p WHERE p.id=(n->>'payment_id')::uuid;
```

It does not derive protection from the settlement header or capture attempt. On UPDATE, `prior_merchant` was read from `to_jsonb(OLD)->>'merchant_id'`; settlement items have no `merchant_id` column. The OLD payment's owner is never resolved. Consequently changing the payment to an unenrolled one can make both enrollment comparisons miss the protected original candidate.

**Confirmed:** the saved insert uses an enrolled A/USD settlement header and A's capture attempt with merchant B's payment; it commits without a permit. The saved update starts with an A-owned legacy-shaped candidate, then enrolls A/USD and retargets the candidate to B's payment while changing gross `10000→9999`; both changes persist. The latter is especially significant because the original candidate already existed when the scope became protected. DORMANT enrollment cannot allow subsequent ordinary mutation to escape through a different reference.

The existing database layers do not close these specific paths:

- Migration 0000 lines 338–340 has separate existence FKs for header, payment and capture attempt, not a combined ownership relationship. A unique capture-attempt reference does not prove its payment or header owner.
- Migration 0004's `settlement_item_lot_scope` is a composite lot/attempt/payment/currency FK. These fixtures have NULL `capture_lot_id`. `settlement_item_evidence` invokes `protect_accounting_foundation_evidence()` only when NEW lot is non-NULL; its identity protections are therefore not reached here. `check_accounting_settlement_evidence()` returns for an item with NULL lot, and for a legacy header with NULL accounting policy. This describes the existing compatibility boundary, not a request to remove those original checks.
- Migration 0010's new unique `(id,payment_id,currency)` key and application-side item FK establish a relationship only when an application link exists. Neither requires the missing link nor binds the candidate to its header/attempt owner.

**Affected invariants:** candidate/header/payment/capture ownership and currency must agree; an enrolled candidate cannot become unprotected through reference updates or NULL legacy-shaped fields; protected candidate writes require a current exact manifest and complete application. Candidate uniqueness and balanced future journals cannot substitute for those relationships.

**Smallest correction:** determine protection from all authoritative implicated owners, including header and capture/payment references, with OLD and NEW ownership considered on updates. Reject mismatched ownership and unpermitted protected changes before returning to legacy compatibility. Enforce the coherent header/payment/attempt/currency relationship for protected candidates through reviewed database checks/constraints, including legacy-shaped rows; retain existing finalized and historical bytes. Scope any additive constraint to the approved prospective boundary after inspecting legacy compatibility, rather than rewriting incompatible history.

The SECURITY DEFINER owner's SELECT list at 0010 lines 447–454 includes payments and ledger relations but omits `payment_attempts`, `settlements` and `settlement_items`. Ownership lookup corrections and their deferred validation must receive the minimum required SELECT grants. This omission is confirmed in source; its full runtime consequences were not established by the interrupted authorization testing. Do not claim those later paths passed, or treat an incidental permission error as successful semantic validation. No grants are changed in this finalization.

## 5. Preserved implementation and verification history

The following are **previously collected evidence**, not checks executed by this continuation. Local records identify PostgreSQL 18.6 on Windows, Node 24.19.0 and pnpm 10.26.0; the reviewer PostgreSQL log corroborates the server version. The records distinguish the original defective draft, corrected implementation and later independent regressions.

| Retained evidence | Result / interpretation |
| --- | --- |
| Original R2-A matrix, `.tmp/r2a-matrix.json` | 34 passed / 741 failed / 0 skipped, 25 suites. The retained failure inventory attributes 740 to the PL/pgSQL `r` alias ambiguity (`42702`); one new upgrade fixture lacked frozen refund allocation. Original failure remains history. |
| R2-A.1 correction, implementation §§14–20; `.tmp/r2a1-original-0010.sql`, `r2a1-original-red.json`, `r2a1-reproduction.json` | Original red path retained; variable/alias correction and proper allocation fixture documented. This resolves the recorded compatibility problem, not the newly found ownership defects. |
| Author's corrected full matrix, `.tmp/r2a1-matrix.json` | 790 passed / 26 suites / 0 failed or skipped. Final focused subset: 54 passed / 3 suites. These are overlapping coverage, not 844 distinct tests. |
| Prior independent matrix, `.tmp/r2a-review-matrix.json` and `.log` | 790 passed / 26 suites / 0 failed or skipped, 195.392 seconds. Its result inventory excludes both the new five-case reviewer suite and the separate F01 pending suite. It cannot supersede the later four failures. |
| Separate preserved F01, `.tmp/r2a1-f01.json` | Six expected financial failures / 0 skipped. Original assertions remain red; no F01 closure is claimed. |
| Prior reviewer lint/build/typecheck logs, `.tmp/r2a-review-{lint,build,typecheck}.log` | PASS API/web. Static/build evidence does not prove the missing database ownership invariants. |
| First prior reviewer default test, `.tmp/r2a-review-test.log` | 39 suites failed before tests ran: Jest transform-cache EPERM rename error. Retained as an environment failure, not silently reported green. |
| Prior default-test retry, `.tmp/r2a-review-test-retry.log` | 50 units passed / 12 suites; 801 database cases / 28 suites skipped, 851 total discovered. Default opt-outs are not PostgreSQL evidence. |
| Initial reviewer fixture / final reviewer regressions | Five setup errors, then four assertion failures and one passing control, as detailed in §2. Both JSON/log pairs remain intact. |

R2-A.1 also records the independent existing reconciliation issue-publication syntax error `42601` on both accepted 0009 and corrected 0010. It remains a separate runtime defect. This review neither attributes it to 0010 nor fixes it. F01/F04/F05/F06 and prior correction/acceptance records retain their existing boundaries.

## 6. Permanent regression requirements and next checkpoint

Recommended next implementation checkpoint: **R2-A.2 — authoritative effect ownership and settlement-candidate integrity correction**, separately authorized and still dormant. Fix these two common database predicates before proceeding to R2-B. This report supplies requirements for ordinary corrective engineering; it does not authorize resuming the interrupted experiments.

1. Keep all four existing failing assertions and the passing same-scope control unchanged in `financial-application-review.spec.ts`. The correction must make the expected refusal/rollback assertions pass, not replace them with the observed successful writes, skip them, or mask them with setup/permission errors. Preserve limited authenticated writer coverage and no permit-table write authority.
2. Add focused corrective coverage for authoritative operation ownership with an omitted root/application, mismatched merchant/currency, and relevant OLD/NEW business references. Ensure ledger entry/parent references cannot erase a protected scope. Keep unsupported contracts closed and preserve truly unenrolled legacy posting.
3. Cover settlement header/payment/capture/currency consistency and existing-item updates using both old and new owners, including NULL lot/policy rows. Require rejected changes to retain original item bytes and no partial application/effect. Retargeting the header, payment or attempt must not erase protection. These are acceptance requirements, not additional failures reproduced here.
4. Verify both immediate and deferred/COMMIT integrity with the necessary least-privilege reads. A deferred check must establish protected effect→complete application even when the application or permit is entirely missing. Keep application→complete effects, claim/revision checks, source-specific dispositions and immutable history intact. Missing operation validators still refuse finalization.
5. In a separately authorized corrective run, verify fresh installation/populated upgrade and unchanged historical SQL/F02 assertions, legacy before/after workflows, existing structural/role/migration/concurrency coverage, and the four permanent regressions. Report the original six F01 failures separately. Do not use a broad “green” matrix that omits the reviewer suite. Any concurrency-sensitive correction needs relevant disposable PostgreSQL evidence, not unit mocks.

The correction must preserve account → advisory → scope → shared header → payment/children → lots/items ordering, including implicit FK waits. New lookup/grant/constraint work is not proof of safe lock ordering by itself. No new lock schedule was executed here, and no universal deadlock-freedom claim follows.

**Incomplete verification:** the interrupted authorization investigation did not complete; this finalization adds no PostgreSQL evidence or fresh catalog audit. Successful new-era monetary application, all future operation paths, every grant composition, full recovery/replay and complete lock schedules are not certified. The earlier zero-ACTIVE/zero-application catalog in implementation §20 describes that earlier pass only; current cluster state, sessions, marker restoration and shutdown were not inspected or changed here. No claim is made that the interrupted review cleaned up those resources. Retained databases/history must be preserved; any necessary local lifecycle cleanup should be handled separately with its state established first.

Hosted exact-diff PostgreSQL 17/Node 22/24, live provider/broker/Redis, operational grants and old-worker fencing, D03 cohort evidence, F05/F06 corrections and explicit activation remain later gates. No production/runtime reachability or real-money exploit was demonstrated. The confirmed local integrity failures alone are sufficient to block this checkpoint's acceptance.

## 7. Finalization changes and checks

Exact documentation changes in this continuation:

- Added this independent review report.
- Updated the current banner and appended §22 of [the implementation record](h1-fix-02-b3-2-b2-r2-a-financial-application-foundation.md), preserving §§1–21 and the original failed/corrected histories.
- Updated the existing R2-A entry and added this report's link in [docs/README.md](../README.md).

No implementation, schema, migration metadata/SQL, assertion, review fixture or retained R2-A evidence file was edited. No staging, commit or push occurred. Runtime lint/build/test results in §5 remain inherited.

| Executed finalization check | Result |
| --- | --- |
| Read-only documentation validator, with its unrelated generated-file write omitted | PASS: 57 Markdown files / 839 relative links and anchors; existing CI YAML parsed and structure checked. Nineteen unchanged Mermaid blocks inventoried, not parsed/rendered. |
| First documentation-validator wrapper | Failed on Node cross-VM-realm array identity during a CI assertion. The same read-only validator then passed in one JavaScript realm; no repository defect or financial test was involved. |
| `git diff --check` and direct checks of all three documentation files | PASS: whitespace and final newlines. |
| File fingerprints | Of 316 starting repository/evidence files, 314 remain byte-identical; only the implementation record and index changed, plus this new report. The reviewer suite, implementation and retained R2-A evidence are unchanged. |
| Original implementation record preservation | Restoring only the prior banner in memory and excluding appended §22 reproduces its exact starting SHA-256, including §§1–21 and their original verdicts. |
| Git and financial execution | HEAD unchanged, index empty; no database/runtime tests, probes, migration, activation, commit or push. |

**REQUEST_CHANGES.** R2-A.1 is not accepted. Complete the minimal R2-A.2 database ownership correction and its permanent regressions, then obtain independent re-review before R2-B. This review authorizes no installation, payment execution, writer registration, financial scope activation or cutover.
