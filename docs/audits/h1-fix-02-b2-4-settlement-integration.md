# H1 Fix 02 B2.4 — allocation-aware settlement integration

Status: accepted dormant checkpoint. This record owns B2.4 implementation and executed evidence. [Settlement/payout](../settlement-and-payout.md), [Ledger](../ledger.md), [Database design](../database-design.md) and [Concurrency](../concurrency.md) remain the current behavior owners. [Run A](h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09) owns the approved policy. F01/F04 remain unresolved; no B3 cutover occurred. The implementation and independent review made no commit or push; the owner subsequently authorized both after acceptance below.

## Prerequisite and initial state

On 2026-10-10 the checkout was `main`, clean working tree and index, HEAD `c44b488bfef06f085de4d14581a7c5edf95fc37f` (`feat(accounting): add capture-level dispute accounting`), synchronized with origin/main. The preceding final independent B2.3/B2.3.1 acceptance in this conversation returned **APPROVE**, followed by the user's authorized commit/push. Passing tests were not substituted for that acceptance. The [B2.3 implementation record](h1-fix-02-b2-3-dispute-integration.md) and committed code were inspected together; its checkpoint wording predates that conversation acceptance and remains historical.

Read AGENTS/CLAUDE, task routing, workflow, H1 audit, Run A, B1 and all B2 checkpoint records, current accounting/database/concurrency/provider-inbox owners, financial writers, settlement controller/listing/merchant completion/due scheduler, migrations and regression suites. No pre-existing edits required preservation. Prior records, migrations 0000–0005 and the six legacy F01 assertions are unchanged.

## Defect baseline and new financial oracle

Before editing production code, the unchanged opt-in [legacy F01 suite](../../apps/api/test/integration/settlement-f01.pending.spec.ts) ran on a fresh disposable 0000–0005 PostgreSQL database: **six failed, none skipped**, exit 1. Every failure was a financial assertion rather than a setup error. The same six assertions failed again after B2.4. Legacy `SettlementsService` still releases original gross/net and legacy refunds still choose pooled payment sources.

| Legacy reproduction | Observed incorrect accounts before and after B2.4 |
| --- | --- |
| Partial refund before completion | PSP -5000, cash 10000, pending -4850, available 9700 |
| Full refund before completion | PSP -10000, cash 10000, pending -9700, available 9700 |
| Funded 5000 dispute before completion | PSP 0, cash 10000, pending -5000, available 9700, dispute clearing 5000 |
| Candidate made stale by refund | Cash 10000, pending -4850, available 9700 |
| Candidate made stale by dispute | Cash 10000, pending -5000, available 9700 |
| Settled A4000 + pending B6000, refund5000 | PSP 6000, cash -1000, pending 970, available 3880, fee refunds 150 |

The new [73-case settlement suite](../../apps/api/test/integration/settlement-accounting-integration.spec.ts) exercises the separate allocation-aware service and actual dormant refund/dispute operations. It preserves this distinction from the six legacy reproductions.

## Separate generation and completion

[CaptureSettlementAccountingService](../../apps/api/src/settlements/capture-settlement-accounting.service.ts) is absent from modules, controllers, jobs and webhook dispatch. Its protected production admission requires ACTIVE; the current scope constraint permits only FOUNDATION_ONLY/REVIEW_REQUIRED. Only test subclasses admit isolated dormant fixtures. There is no environment bypass or generic feature flag.

`generate(merchantId?, currency?)` discovers mature unsettled scopes without locks, then uses an independent transaction for each scope. Under common admission/member locks it rereads verified original journals, successful attempts, immutable timing and allocation history. Missing legacy attribution, legacy candidate ownership, inconsistent histories and legacy-origin lots require review; a valid original journal alone cannot authorize legacy history. All OPEN scope exceptions block new candidates. Eligibility uses the lot's frozen timestamp, never today's merchant delay.

Generation creates a private batch, inserts unique capture-owned candidates using INSERT RETURNING, and calculates original gross/fee/net and estimated asset/release totals from the **returned items**. Existing valid pending owners are skipped. A conflicting owner requires retry/review; an all-conflict private header aborts rather than leaving an empty batch. No candidate journal or financial movement is posted. Generation and its audit commit together. Fully refunded mature lots remain candidates so they can receive a durable zero-effect outcome.

`complete(tx, settlementId)` leaves transaction ownership with its caller, like the other financial effect methods. It discovers scope identity, takes admission, locks the shared header before all payment/child/lot/allocation members, then rereads confirmed financial evidence. It validates original journal ownership, original amounts/timestamps, successful captures, reconciled payment/allocation histories, candidate originals/estimates and pre-existing journal references before writing. It uses current effects and revisions rather than generation estimates. A contradictory pending batch or any unapplied journal with its business ID requires review, including wrong-currency evidence.

Completion is all-or-nothing. The SETTLEMENT journal, item actual amounts/result/revision/hold/timestamp, lot finalization, batch actual amounts/result/timestamps and completion audit commit in the caller's transaction. Journal or audit failure rolls back all effects. No provider reference is manufactured. PostgreSQL's existing deferred finalization constraints validate the entire completed transaction; F02 still seals POSTED headers/entries.

## Exact accounting and zero effect

For a lot with original gross G, fee F, net N=G-F, confirmed refund principal R and fee Q, confirmed loss L, and current OPEN funded holds H (original funding plus append-only adjustments):

```text
asset transfer = G - R - L
surviving merchant entitlement = N - (R - Q) - L
merchant release = max(surviving entitlement - H, 0)
```

Pending refunds reserve gross capacity; under approved Option A they do not subtract a posted asset or liability effect. Exact BigInt values remain exact until validated conversion to LedgerService's existing Number boundary. The combined debit total asset+release is checked as well as individual lines. General F03 money types are unchanged.

Positive asset transfer posts D PLATFORM_CASH / C PSP_CLEARING. Positive release independently posts D MERCHANT_PENDING / C MERCHANT_AVAILABLE. Held merchant entitlement remains in DISPUTE_CLEARING. Original retained fees and explained available debt are preserved; no other capture's pending claim is consumed to fund a shortfall. Asset minus release is not assumed to equal the fee.

Both zero finalizes batch/items/lots as **ZERO_EFFECT**, with zero actual amounts, timestamps/revision/audit and no journal. A mixed batch can contain a zero item and positive items: only positive items reference the batch journal. Asset-positive/release-zero is valid for fully funded exposure or 100% fee; zero liability lines are omitted.

| New service oracle, amounts in minor units | Asset / release | Ending accounts or subsequent result |
| --- | --- | --- |
| A: normal10000/300 | 10000 / 9700 | PSP0, cash10000, pending0, available9700, fee300 |
| B/E: confirmed refund5000/fee150, before or after generation | 5000 / 4850 | PSP0, cash5000, pending0, available4850, fee300, fee refunds150 |
| C: full refund before/after generation | 0 / 0 | ZERO_EFFECT, no journal, cash/available0, fee300, fee refunds300 |
| D/F: OPEN funded5000 before/after generation | 10000 / 4700 | Cash10000, available4700, clearing5000, pending0 |
| G: finalized A4000/120, unsettled B6000/180, FIFO refund5000 | B5000 / 4850 | Before B: PSP5000/cash0/pending4850/available0; after B: PSP0/cash5000/pending0/available4850; A unchanged |
| H: funded5000, settle then win | 10000 / 4700 | Later available9700, clearing0, cash10000; no second settlement |
| I: funded5000, settle then loss | 10000 / 4700 | Later cash5000, available4700, clearing0, fee300 |
| J: gross10000 dispute, hold9700/exposure300 | 10000 / 0 | Later loss cash0, available-300, clearing0, pending0, fee300 |

The financial oracles assert all seven required accounts, and payout cases also inspect PAYOUT_CLEARING. Finalization helpers check batch/item originals and estimates versus actual values, journal legs and POSTED reference, final lot/item link, revision and exactly one generation/completion audit. Original fixtures use real LedgerService CAPTURE journals; two additional USD/EUR cases create the lot through actual WebhookBusinessService capture processing. This is direct service evidence, not full signed dispatcher coverage.

## Lock acquisition and transaction compatibility

```text
private operation wrapper, if any
→ canonical merchant/currency PostgreSQL advisory transaction key
→ accounting scope FOR UPDATE/admission
→ shared settlement header FOR UPDATE (completion only)
→ ALL affected payments, stable ID order, FOR NO KEY UPDATE
→ CAPTURE attempts by ID → refunds by ID → disputes by ID
→ lots by capture attempt ID
→ dispute allocations by lot/ID → refund allocations by lot/ID
→ candidate members / fresh reads → new journals → finalization/audit → commit
```

Generation's new header is private, created after member locks; it never takes a shared header lock after lots. Plain reads of existing candidate ownership do not add such a reverse edge. Item triggers revisit an already-held completion header. Refund/dispute/lot parent revisits find parents held before allocation writes. Main journal account resolution is ordered by account code. Financial methods perform no provider/broker network operations and no provider-mirror UPDATE. Capture's existing admission-before-mirror and NO KEY UPDATE behavior is unchanged.

NO KEY UPDATE serializes competing payment writers while permitting payment-FK KEY SHARE; no payment keys are changed. The accepted two-order B2.1.1 legacy-generation/capture regression remains green. New service tests hold the **first actual transaction after its work**, start the competing real method, observe `pg_blocking_pids`, then release the barrier. They await every started operation and release gates on failure.

Twenty concurrency cases execute **22 controlled schedules**, including both acquisition orders for generate/refund, generate/open, complete/refund, complete/open, complete/close for both outcomes, duplicate generation/completion, complete/exception, generation/capture replay and complete/payout. Account and historical finalization outcomes are asserted for valid orders. Refund after settlement debits cash/available; refund first reduces actual completion. A close after settlement preserves the saved restricted release while changing the current financial state. Payout schedules reserve only existing available funds; they do not establish F04 closure.

No universal deadlock freedom is claimed. Legacy refund→payment and dispute→journal→payment reverse edges still prohibit mixed live dispatch with the new protocol. Old settlement jobs can consume policy-tagged batches unless drained/rerouted at cutover. Cross-scope platform-account creation, all old-worker/mirror schedules and complete payout admission remain B3 dependencies.

## Replay, exceptions and inbox prerequisites

Unique candidate capture ownership and SETTLEMENT business references are durable database guarantees, not application mutexes. Completion replay takes admission/member locks and validates saved successful evidence: original lot/item identity, final lot owner, selected≤applied≤current revision, saved totals/result/timestamps, and exact historical journal accounts/owner/currency/legs. Later refunds or close outcomes can advance current revision and change current entitlement; replay validates the immutable **saved snapshot**, not today's recomputed amounts. Replay posts no journal/audit, alters no final item and cannot turn ZERO_EFFECT into a positive settlement. Contradictory successful evidence raises ACCOUNTING_INTEGRITY_CONFLICT rather than a silent early return.

All OPEN scope exceptions conservatively block pending completion; one item exception blocks the entire multi-item batch. Existing evidence/resolutions are preserved, never automatically resolved. New eligibility conflicts create idempotent INTERNAL SETTLEMENT_ELIGIBILITY_CONFLICT records and one audit, with payment/lot/attempt/original journal references in observed_conflict. Multi-payment conflicts use a scope record and JSON references instead of falsely assigning one payment to every exception-lot composite key. Returned ACCOUNTING_EXCEPTION must be committed by a future caller to preserve review evidence; an operational abort rolls it back with the transaction. Successful finalized replay remains an evidence-only no-op despite a later OPEN exception.

Known correlated STRIPE refund-success/dispute-open/close inbox rows in PENDING/PROCESSING/RETRY/DEAD cause ACCOUNTING_PREREQUISITE_PENDING before generation/completion, including zero effects. The check reads direct payment/refund and STRIPE mirror object references; it does not claim receipt/claim scheduling coverage, unknown-reference discovery or a barrier against a receipt arriving after the check. Those are B3 runtime admission dependencies. Manual service fixtures begin IGNORED and processing applies their retained row through the real dormant refund/dispute methods; no signature or queue proof is inferred from that harness.

## Schema, compatibility and future interface

No schema or migration changes. Existing 0004 original/estimate/actual/revision/finalization fields, composite FKs, immutable candidates/finals, unique capture ownership and deferred whole-batch constraints suffice. Historical migrations 0000–0005, F02 function contexts and B2.2 inbox label remain byte-for-byte unchanged. No new migration lock window or historical rewrite is introduced. Prior maintenance/drain requirements for installing the chain still apply.

Fresh/no-op chain, populated 0004 upgrade, valid 0000–0003 legacy upgrade with clean/pending/completed/refunded/disputed inventory and invalid/unscoped ownership refusal are exercised by the unchanged five migration tests. The new suite also reruns the migrator over current positive/zero finalized, refunded and pending legacy records with complete before/after fingerprints. Existing pending/completed legacy batches are refused by the new service and retained; historical captures without reconciled lots cannot authorize new candidates. No legacy policy or eligibility is inferred from current merchant terms.

Inspected live controller, list(), completeForMerchant(), completeDue(), settlement-poll and module registration remain on SettlementsService. Future coordinated callers can use `generate(merchantId?,currency?)` and transaction-owned `complete(tx,id)`, but must preserve merchant authorization, policy-aware due selection and exception/retry dispositions. Original `grossAmount/feeAmount/netAmount` continue to mean original captured evidence. Future API work must expose distinct exact minor-unit strings for estimated/final asset transfer and merchant release, plus policy/result/journal/timestamps, rather than relabel original fields as current funds. No API response, dashboard or scheduler behavior changed here.

## Executed verification

Local Windows, Node24.19.0, pnpm10.26.0, PostgreSQL18.6. The retained isolated localhost cluster used port55432 and fresh database `fintech_h1_b24_1791620911023`. Additional migration fixtures create and retain new databases; no existing database is reset or dropped. COREPACK_HOME selects the installed offline cache with COREPACK_ENABLE_NETWORK=0; TEMP/TMP point to ignored workspace .tmp. Database access used permitted localhost execution. No service secrets were printed or committed.

Database commands below use RUN_DB_TESTS=1, the disposable DATABASE_URL and, for the combined run, RUN_MIGRATION_TESTS=1 with localhost MIGRATION_ADMIN_URL. RUN_F01_PENDING=1 is set only for the separate six-case legacy command; it is not silently removed from that run or used in the green one.

| Exact command | Executed result |
| --- | --- |
| `node .tmp/h1-b24-fresh.cjs` | Fresh isolated database created, unchanged six-migration chain applied |
| `pnpm lint` | API/web passed after test typings were corrected |
| `pnpm typecheck` | API/web passed |
| `pnpm test` | 12 unit suites / 50 passed; 296 database cases skipped by default, separately executed as 290 green plus six legacy red below; web is a notice, not a browser suite |
| `pnpm build` | API/web production builds passed on permitted retry after sandbox EPERM creating Next output |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-accounting-integration.spec.ts --cacheDirectory ../../.tmp/jest-h1b24 --json --outputFile ../../.tmp/h1-b24-settlement-final.json` | Intermediate dedicated run: 71 passed; final two additional integrity cases are included in the full 73-case run below |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-accounting-integration.spec.ts test/integration/dispute-accounting-integration.spec.ts test/integration/refund-accounting-integration.spec.ts test/integration/capture-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts --cacheDirectory ../../.tmp/jest-h1b24 --json --outputFile ../../.tmp/h1-b24-full-postgres-final.json` | Eight suites / **290 passed**, none failed/skipped: 73 settlement, 70 dispute, 63 refund, 27 capture, 30 foundation, 5 migration, 17 F02, 5 existing concurrency |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-h1b24 --json --outputFile ../../.tmp/h1-b24-f01-before.json` | Before implementation: six unchanged accounting assertions failed, exit1, none skipped |
| Same legacy command with `--outputFile ../../.tmp/h1-b24-f01-after.json` | After implementation: same six assertion failures, exit1, none skipped/weakened |

The initial dedicated run passed63/64: the remaining test expected an invented error name instead of existing LEDGER_AMOUNT_UNREPRESENTABLE. Corrected that assertion; no financial guard was weakened. Initial lint found unused/unsafe test types and an unknown thrown error, subsequently corrected. The first combined run passed288/288; final inspection added pending-batch-original consistency and wrong-currency unapplied-journal admission tests, followed by the full290/290 rerun. These failures are distinct from expected legacy F01 failures.

Final `node .tmp/h1-b24-scope.cjs` confirmed the initial main/HEAD, empty index, exactly twelve deliverables, unchanged historical migration/legacy writer/prior checkpoint/F01 files, passed targeted secret-pattern check and PostgreSQL18.6 catalog with six migrations and **zero ACTIVE scopes**. Helpers, caches, retained logs and disposable databases remain ignored; they are not deliverables. `git diff --check` and new-file whitespace checks passed. `node .tmp/validate-docs.cjs` checked 34 Markdown files, 369 relative links/anchors and CI YAML; fourteen unchanged Mermaid blocks were extracted, not parsed/rendered. No Mermaid-render verification is claimed. The isolated cluster was stopped cleanly with pg_ctl after verification, preserving its test databases and evidence.

Deliverables are the new service, settlement suite and this record; current [task routing](../AGENT_START_HERE.md), [index](../README.md), [concurrency](../concurrency.md), [database](../database-design.md), [ledger](../ledger.md), [refund/dispute](../refunds-and-disputes.md), [settlement/payout](../settlement-and-payout.md), [verification](../verification.md) and [webhook/idempotency](../webhooks-and-idempotency.md) owners. The complete new files and owner diff were inspected for scope. No unrelated files, dependencies, generated exports, scripts, commits or pushes are included.

## Activation and remaining B3 work

No ACTIVE scope is created; the new service has no runtime registration and active legacy semantics are unchanged. Capture-lot persistence remains part of the active capture transaction from B2.1, while allocation-aware settlement remains dormant. REVIEW_REQUIRED does not quarantine pooled available funds or block legacy payout/settlement admission.

B3 must reconcile trusted original ownership, eligibility and adjusted historical capture/refund/dispute/settlement/payout evidence and old mispostings; historical correction needs separately reviewed compensating journals. It must drain old workers and in-flight accepted commands, coordinate scope admission and refund/dispute/settlement dispatch before mirrors/shared locks, preserve inbox identity/retry/exception dispositions, distinguish legacy versus new batch due selection, and require no unresolved blocking exceptions. A reviewed forward ACTIVE migration, rollout/rollback/drain plan, complete cross-flow and payout/F04 matrix, platform-account creation schedules and hosted compatibility are prerequisites. An application rollback must retain immutable allocation/finalization/exception evidence.

Hosted CI, PostgreSQL17/Node22, live Stripe multicapture/charge/refund/dispute/settlement behavior, RabbitMQ/Redis, full signed new refund/dispute dispatch, receipt/scheduler races, real money/bank payouts and production-size migration timing remain unverified. No reconciliation UI, automatic financial repair, deployment, B3 activation or F01/F04 closure is claimed. Implementation ended ready for independent review; the subsequent acceptance below does not authorize production cutover.

## Final acceptance and checkpoint handoff (2026-10-10)

The independent B2.4 correctness review returned **APPROVE** for this dormant checkpoint, with no release-blocking finding. It inspected the complete twelve-file diff, actual settlement/refund/dispute/capture/ledger services, legacy runtime routing, migration constraints and regression assertions. It confirmed separate capture-owned asset/release calculations, completion-time recalculation, atomic journal/item/lot/batch/audit finalization, explicit ZERO_EFFECT and saved-snapshot replay. The owner then explicitly authorized commit and push; no B3 implementation or activation was authorized.

The review migrated a new disposable localhost PostgreSQL18.6 database, `fintech_h1_b24_review_1791628244209`, through unchanged 0000–0005 and reran the eight-suite integration command above with review cache/output paths: **290 passed, none failed or skipped**, including all 73 settlement cases and 22 controlled schedules. Seven additional ordinary service scenarios passed: mixed finalized/unsettled dispute win/loss before and after completion, loss then remaining refund with zero finalization and explained debt, and either funded hold losing before settlement. These additional helpers remain ignored review evidence, not permanent regressions or signed dispatcher tests.

The six unchanged opt-in legacy F01 assertions were rerun: **six financial assertion failures, none skipped**, exit1. Previous successful lint/typecheck, 50 unit tests and API/web build logs were inspected, not rerun during acceptance. Documentation/link validation and `git diff --check` passed. Final scope inspection confirmed unchanged historical migrations/legacy writers, twelve intended deliverables, empty index, six installed migrations and zero ACTIVE scopes. The isolated cluster was stopped cleanly, preserving review databases and logs under ignored `.tmp`.

The controlled schedules mainly establish actual shared-scope serialization, not universal deadlock freedom. Before activation, B3 still needs coordinated policy-aware dispatch and old-worker drain, transactional exception/payout admission, late/unknown inbox handling, legacy reconciliation, cross-scope account creation, and an explicit range/admission and blocked-candidate recovery contract. F01/F04 remain open. Hosted and external boundaries above remain unverified.
