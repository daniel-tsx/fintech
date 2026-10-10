# H1 Fix 02 B2.2: capture-level refund integration

Status: accepted dormant checkpoint, including B2.2.1 provider identity correction. Date: 2026-10-10. Owner: B2.2 implementation/evidence and handoff; current behavior remains owned by [Refunds/disputes](../refunds-and-disputes.md), [Ledger](../ledger.md), [Database design](../database-design.md), [Concurrency](../concurrency.md) and [Webhooks/idempotency](../webhooks-and-idempotency.md).

**F01 remains unresolved. No scope is ACTIVE.** This run uses the expressly authorized isolated dormant-path harness. The new service is absent from Nest modules/controllers/WebhookBusinessService; its default gate requires ACTIVE, which migration 0004 structurally forbids. Tests override only scope admission for synthetic FOUNDATION_ONLY/REVIEW_REQUIRED fixtures. There is no production environment switch. Existing refund/dispute/settlement/payout writers and provider transport remain unchanged. Capture lot persistence from B2.1 remains active independently of allocation-model cutover.

## Prerequisite and inspected state

Initial branch `main`, HEAD `1bd42079f4b3bc4c483db2196547700985ca4502` (`feat(accounting): integrate capture accounting lots`), worktree/index clean. B2.1's final acceptance returned APPROVE in the preceding review; the accepted B2.1/B2.1.1 checkpoint is committed. Its original REQUEST CHANGES/deadlock evidence remains in [the B2.1 record](h1-fix-02-b2-1-capture-integration.md); this run does not overwrite that history.

Read repository/agent/workflow routing, H1 audit, [approved Approach A / Option A contract](h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09), B1/B2.1 records and current accounting/database/concurrency/webhook owners. Traced RefundsService, WebhookBusinessService/Processor, LedgerService, PayoutsService, SettlementsService, DisputesService, provider command/refund construction, idempotency and migration 0004/helper/tests. PostgreSQL owns durable correctness; no Stripe/RabbitMQ network operation runs under these financial locks.

Files: new [CaptureRefundAccountingService](../../apps/api/src/refunds/capture-refund-accounting.service.ts), [refund integration tests](../../apps/api/test/integration/refund-accounting-integration.spec.ts), [0005 migration](../../apps/api/drizzle/0005_refund_accounting_exception.sql), and this record. Updated migration manifest/schema inbox enum, helper's staging comment, existing migration tests, current owners, routing/index and verification follow-up. Historical migrations 0000–0004, legacy writers, F02, six F01 assertions, DTOs, provider/queue boundaries and package dependencies remain unchanged. Ignored setup/cache/log helpers stay under `.tmp`; none is a deliverable. Nothing is staged, committed or pushed.

## Request and provider contract

The separate service retains existing merchant/operation/key idempotency, body comparison, original 202 status/body and `refund:<UUID>` provider key. It discovers canonical merchant/currency, takes shared advisory/scope and payment locks, then prelocks children/lots. It requires verified NEW_CAPTURE ownership/evidence, known eligibility, exact payment capture/refund totals and no OPEN scope exception or unallocated legacy refund/dispute/settlement history. Legacy original-only lots are refused; current terms never supply missing historical eligibility.

FIFO uses financial posting epoch microseconds, then capture-attempt UUID. Capacity subtracts confirmed gross, accepted outstanding reservations, active/planned dispute gross and finalized lost gross. B1's helper computes assignments; rows freeze each refund's attribution. Private refund, whole-intent reservations, one existing outbox command, audit and replay response commit atomically. Later captures cannot retarget an accepted/replayed request. PostgreSQL ownership, aggregate capacity, whole-intent and uniqueness constraints supplement application checks.

The current Stripe adapter calls `refunds.create` with a **PaymentIntent** reference, amount and existing idempotency key. Selected lots must share one nonempty attempt provider reference; incompatible/missing references fail before refund/reservations/outbox commit. Internal FIFO is an accounting attribution, not a claim that Stripe selected those capture attempts. No multi-PaymentIntent orchestration or Charge-based routing was added. Live Stripe/test-account multicapture/refund compatibility is unverified; future activation must reconcile trusted provider references.

Approved **Option A**: request acceptance reserves gross only. It posts no journal, changes no liability and adds no payout hold. Unknown/delayed/lost responses do not release it. Post-payout confirmed refunds can create explained signed available debt/internal cash deficiency; collection, bank clawback, payout cancellation and strict pending-refund protection are not implemented.

## Confirmed financial application

`applySucceeded(tx,inboxUUID)` and `applyFailed(tx,inboxUUID)` lock/read the actual immutable normalized Stripe inbox payload. They validate normalized type, positive safe API amount, correlated refund/payment/merchant/currency, known provider refund reference and mirror agreement. An unrelated/unknown owner is rejected without guessed attribution; the original inbox remains, and future runtime integration must retain bounded retry/DEAD handling. Known amount/currency/reference contradictions instead commit durable review evidence.

For each frozen allocation with gross g on capture G/F:

```text
feeDelta = floor(F × (previousConfirmedGross + g) / G) − previousConfirmedFee
netRefund = g − feeDelta
E = G − F − (confirmedGross − confirmedFee) − lostDisputeGross
H = active funded hold, including append-only hold adjustments
unsettled pending debit = min(netRefund, max(E − H, 0))
available debit = netRefund − pending debit
finalized settled pending debit = 0
```

BigInt multiplication/division remains exact, including products above Number precision. No later merchant configuration is consulted. Positive output amounts are checked before conversion into the existing Number LedgerService; global monetary representation/F03 is unchanged. Zero legs are omitted. A disjoint refund that would require reducing funded holds is retained for B2.3 review rather than inventing a funding adjustment; automatic principal overlap is never inferred.

Unsettled lot assets credit PSP_CLEARING; finalized settled lot assets credit PLATFORM_CASH. Merchant pending debit comes only from the affected lot's entitlement, never pooled pending-first selection. Available bears the remainder, including explained debt after payout/loss. Finalized state comes from B1-validated immutable settlement evidence, not any-settled-payment detection.

For A4000/fee120 finalized and B6000/fee180 unsettled, refund5000 produces exactly:

| Account | Debit | Credit |
| --- | ---: | ---: |
| MERCHANT_AVAILABLE | 3880 | 0 |
| MERCHANT_PENDING | 970 | 0 |
| PLATFORM_FEE_REFUNDS | 150 | 0 |
| PLATFORM_CASH | 0 | 4000 |
| PSP_CLEARING | 0 | 1000 |

One unique POSTED REFUND journal, all CONFIRMED allocations with actual gross/fee/journal/event, refund status/provider reference/fee, payment total/status/version, immutable audit and inbox PROCESSED disposition commit in the caller's transaction. Failure after posting or after all service work rolls everything back; the same evidence can retry. Deferred B1/F02 checks run at commit. Original CAPTURE and prior settlement/refund journals are untouched.

## Replay, failure and accounting exceptions

Succeeded replay requires finalized allocations and preserved provider identity; it changes no money, counters, attribution or audit. Concurrent duplicate evidence serializes and produces one journal/audit. Confirmed failure requires whole frozen RESERVED assignments and no existing financial journal, releases only those assignments, marks FAILED/audits/disposes and posts no journal. Duplicate failure returns without modifying terminal allocations. Existing financial evidence cannot be converted into a released reservation.

B1 makes RELEASED allocations immutable. Late success after failure therefore requires review, rather than reacquiring possibly consumed capacity. Failure after success similarly cannot undo the original journal. Contradictory reference/amount/currency, missing trustworthy attribution, inconsistent lifecycle/history, unsupported payment state or unintegrated dispute funding commits/reuses an OPEN `AMBIGUOUS_PROVIDER_NET_EFFECT` exception keyed by scope/category/`webhook:<inboxUUID>`. It links known refund/dispute/lot references and preserves all dispute IDs/provider references in observed-conflict JSON; the original payload remains immutable. Scope becomes REVIEW_REQUIRED and inbox becomes ACCOUNTING_EXCEPTION with no processed timestamp. No guessed journal, financial resolution or automatic capacity release occurs.

ACCOUNTING_EXCEPTION is excluded from existing claim/retry predicates, so ambiguous evidence is not falsely PROCESSED/IGNORED or endlessly retried. Direct tests repeat the same exception evidence and assert one record, retained reservations and unchanged money. Future human authorization/resolution/requeue is not implemented. Marking an exception resolved must not itself claim financial effect application or activate a scope.

**This does not quarantine pooled funds in current runtime.** Legacy settlement/payout/refund can still proceed despite a REVIEW_REQUIRED scope. Default admission blocks this service everywhere; the harness deliberately tests future financial behavior on isolated synthetic evidence. No new-policy evidence is finalized against legacy journals.

## Actual locks and cutover blockers

New service order:

```text
private inbox/idempotency
→ merchant/currency advisory transaction lock (existing payout/capture key)
→ scope FOR UPDATE
→ payment FOR NO KEY UPDATE
→ CAPTURE attempts by ID → refunds by ID → disputes by ID
→ lots by capture-attempt ID → refund allocations by lot ID
→ new private journal → workflow/audit/final disposition → commit
```

Non-key payment updates retain writer serialization while permitting settlement-item FK KEY SHARE. Shared child parents are prelocked before B1 triggers revisit them; newly accepted refund/journal rows are private. The service reads provider mirrors without updating/locking them, avoiding an additional mirror wait edge. Future webhook dispatch must acquire admission **before** mirror mutations and preserve the service's returned disposition instead of blindly writing PROCESSED. Current processor remains on the legacy path.

| Existing path | Required coordinated adoption before activation |
| --- | --- |
| Capture success | Already advisory/scope→mirror→payment NKU→CAPTURE attempt; controlled actual capture/refund schedule passes |
| Authorization | AUTHORIZE attempt→payment remains legacy; new refund prelocks CAPTURE children only; do not add admission after a child lock |
| Capture failure/cancellation | Payment→child remains legacy; scope admission and in-flight state behavior need cutover review |
| Legacy refund success | Refund→payment would invert new payment→refund; replace/coordinate every callback/replay, never register both paths for a scope |
| Dispute open/close | Close's dispute→journal→payment inverts new payment→dispute; B2.3 must coordinate admission/mirror/payment/children/funding effects |
| Settlement generation/completion | Generation holds attempt then implicit payment FK; NKU retains B2.1 compatibility. B2.4 must coordinate admission, existing headers/members, lots and current revisions before journals |
| Payout reservation/completion | Reservation takes same advisory key; controlled reservation/refund schedule passes with signed debt. Completion and full pooled admission/F04 need independent combined review |

No legacy handler was mechanically reordered. Current code introduces no partial live protocol because the service is disconnected and fails closed. Higher isolation, all callback permutations, cross-scope shared account creation, stale workers and universal deadlock freedom remain B3 work. Deadlock/serialization/transient errors require whole-transaction bounded retry with stable keys, never a new provider key or application mutex.

Activation still requires all writers/dispatch/retry/admission paths coordinated, old binaries and in-flight legacy work drained, legacy ownership/history/eligibility/provider intents/pooled balances reconciled, no unresolved blocking exceptions, allocation-aware settlement completion and required regressions. A reviewed forward migration and transactional cutover would be needed to permit ACTIVE. This run does not add that transition.

## Migration and compatibility

0005 only appends ACCOUNTING_EXCEPTION to `public.inbox_status` and manifest/schema. It uses an enum-object lock, not financial-history maintenance scans; run the normal transactional migrator and use the label only after migration commit. Fresh 0000–0005 install, repeated migrator no-op and populated 0004 upgrade preserve original journal/entry fingerprints and dormant state. Existing B1 legacy backfill/refusal/rollback tests remain. Historical SQL/functions/triggers and existing enum values/defaults are unchanged.

Application rollback leaves the additive enum/evidence installed; do not drop the label or destructive migration history. Older claim predicates exclude the new state but older binaries must not be used for future activated scopes. No production/shared database was migrated/reset.

## Executed verification

Windows, Node24.19.0/pnpm10.26.0/PostgreSQL18.6; new isolated database `fintech_h1_b22_1791543547639` at 127.0.0.1:55432, migrated fresh with the checked-in Drizzle migrator. Migration fixtures create/retain additional UUID-named local databases. Set RUN_DB_TESTS=1, RUN_MIGRATION_TESTS=1, DATABASE_URL to that disposable database and MIGRATION_ADMIN_URL to its localhost cluster for the green PostgreSQL command. Default checks run without opt-ins; TEMP/TMP point to ignored workspace `.tmp`. No provider consumer/network service is started.

| Exact command | Result |
| --- | --- |
| `pnpm lint` | Passed API/web |
| `pnpm typecheck` | Passed API/web |
| `pnpm test` | Passed: 12 unit suites / 50 tests; 136 database cases skipped by default and executed separately below; web script is a notice |
| `pnpm build` | Passed API/web production builds |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/refund-accounting-integration.spec.ts test/integration/capture-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts --cacheDirectory ../../.tmp/jest-h1b22 --json --outputFile ../../.tmp/h1-b22-pg.json` | Passed: 6 suites / 130 tests, none skipped: 46 refund, 27 capture, 30 foundation, 5 migration, 17 F02, 5 existing financial concurrency |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-h1b22 --json --outputFile ../../.tmp/h1-b22-f01-pending.json` with RUN_DB_TESTS/RUN_F01_PENDING=1 | Six unchanged assertions fail as expected; exit 1, none skipped/weakened |
| `node .tmp/validate-docs.cjs`; `git diff --check` | Passed: 32 Markdown documents / 320 relative links and anchors; CI YAML parsed; 14 Mermaid blocks extracted, not rendered; whitespace clean |
| `node .tmp/h1-b22-scope.cjs` | Passed: 17 intended unstaged files; empty index; unchanged main/HEAD/historical migrations/legacy writers/provider transport/six F01 assertions; tracked and untracked whitespace checked |

New regressions cover single/multi-capture FIFO, exact ties, later captures, API idempotency, competing requests/over-capacity, owner/currency/amount/reference rejection, pre/post/mixed settlement source legs and individual balances, full/partial/zero-fee/zero-net refunds, fixed original fees, large BigInt products, reordered confirmations, duplicate outcomes, journal and surrounding business rollback/retry, unknown real command-handler outcome, immutable allocation/F02 compatibility, retained contradiction/legacy overlap evidence, funded hold refusal and finalized loss/debt. Five controlled concurrency schedules observe actual PostgreSQL blocking for competing requests, distinct/duplicate success, actual B2.1 capture and actual payout reservation. Synthetic finalized settlement/dispute fixtures satisfy B1 constraints but do not implement B2.3/B2.4 runtime.

During development, typecheck caught command-envelope/mock return typing; lint caught untyped SQL test-result sinks and rejected unknown throws. These were corrected. The first refund run passed 33/34; the tie fixture incorrectly supplied a timestamp different from the journal and was rejected by the intended constraint. It now creates genuine journals in one transaction with equal posting times and asserts the tie before checking order. Intermediate combined runs passed 123 and 126 tests before final provider-evidence coverage. No failure was relabeled as an expected F01 regression. Final lint/typecheck/default tests/build and all 130 green PostgreSQL cases were executed after the final code changes. Logs/JSON remain ignored under `.tmp`; the disposable cluster is stopped with databases retained.

## Remaining work and review readiness

**B2.3:** integrated dispute principal/funding/adjustment/closure and coordinated locks, trustworthy overlap/review behavior. **B2.4:** allocation-aware generation/completion, ZERO_EFFECT, live inbox disposition/admission integration and reviewed scope cutover; old refund/dispute/settlement writers must not coexist in an activated scope. **B3:** combined accounting/race matrix, all rollback/reordered evidence, funding reductions, legacy reconciliation, activation/rollback/old-worker cases, account creation and independent F04 admission verification.

F05/F06 remain specific state/evidence dependencies: a confirmed accepted refund in an unsupported concurrent payment state is retained for review, not silently dropped or applied through a redesigned state machine. F03/general money API, F04 closure, debt recovery and pending liability/payout protection are outside scope. The six F01 settlement assertions remain red until B2.4; this checkpoint does not fix live settlement accounting.

No new accounting-policy/provider-contract decision is required for this dormant checkpoint: it uses approved Approach A/Option A, refuses incompatible provider objects and defers unintegrated effects. B2.2 is ready for focused independent review as a dormant checkpoint; no commit/push authorization is inferred. Hosted CI/PostgreSQL17/Node22, Docker, live Stripe/RabbitMQ/Redis, complete signed receiver→runtime dispatcher refund flow, human exception resolution, migration-scale performance and production workloads were not executed. No claim of production readiness, F01/F04 closure or live refund compatibility is made.

## B2.2.1: independent review and provider identity correction

The independent B2.2 review returned **REQUEST CHANGES** for one P1 finding. With frozen capture PaymentIntent A, relevant refund mirror PaymentIntent B and no optional event PaymentIntent, the real service committed success as one REFUND journal/CONFIRMED allocation/payment increment/PROCESSED inbox, or failure as FAILED/RELEASED/PROCESSED. Neither created an exception. A matching mirror control succeeded normally. The review independently passed 130 PostgreSQL tests and ran the six unchanged F01 assertions, all red; those tests missed the contradictory-mirror/absent-event combination. The original review JSON and reproduction helper remain ignored in `.tmp/h1-b22-review-cases.*`; they are local evidence, not deliverables.

B2.2.1 started on unchanged `main`/`1bd42079f4b3bc4c483db2196547700985ca4502`, with the 17 existing B2.2 files unstaged and the index empty. It preserves those changes. Only the new refund service, its PostgreSQL tests, this record and the owning refund/verification notes receive the correction. No migration is needed; 0000–0005, capture accounting, FIFO/fees, settlement/dispute/payout writers and provider transport are unchanged.

### Identity contract and provenance

The root cause was making both comparisons conditional on `data.paymentIntentId`. The corrected service establishes the one known PaymentIntent of the frozen allocations, independently validates every present event/mirror PaymentIntent against it, and checks identity before terminal replay, reservation release or any journal construction. It never selects a reference merely because it matches another source.

- Capture provenance is the allocated lot, its original CAPTURE journal/attempt ownership and the stored successful CAPTURE attempt provider reference. Existing child/lot locks protect the read; no reference or frozen allocation is rewritten. Missing/incompatible allocated capture references require reconciliation.
- A trusted mirror must be STRIPE/REFUND, attached to this refund and the existing stable `refund:<UUID>` command key. Its provider refund object, payment, merchant, currency and accepted amount must also agree. Other operations, keys, providers or refund IDs are not identity authority. No latest-record or payment-wide fallback is introduced.
- A present event PaymentIntent must match the frozen identity even when no mirror exists yet. A known relevant mirror must match independently, even when the event omits its optional field. Missing event identity is legitimate when that mirror establishes the relationship. If neither source supplies a trusted PaymentIntent, the explicit outcome is `Provider PaymentIntent relationship is unresolved`, retained for review without financial effects.

Identity exceptions include event PaymentIntent, relevant mirror row/object/refund/payment/merchant/operation/key/amount/currency and PaymentIntent, plus frozen allocation/lot/attempt IDs and capture PaymentIntent in immutable `observed_conflict.providerIdentity`. The original inbox payload and existing provider records remain unchanged. The existing OPEN exception/lot-link/ACCOUNTING_EXCEPTION path returns a disposition rather than throwing after rejecting the financial effect, so normal contradiction processing commits evidence without posting/reversing journals, changing refund/payment financial state, releasing capacity or finalizing allocations. Repeating the same inbox evidence creates one exception.

An operational abort after writing the exception rolls back that transaction's exception/disposition too; it does not erase the separately persisted original inbox. Real transaction tests assert this rollback, then retry the same evidence and commit one OPEN exception. This is evidence retention and safe retry, not a claim that a failed transaction can independently commit its exception. Live dispatcher retry/disposition integration and explicit human reconciliation remain future activation requirements.

### Permanent regressions and verification

Seventeen new PostgreSQL cases cover both success/failure with absent-event/conflicting-mirror identity; explicit conflicting event identity; matching references with/without optional event identity; terminal replay validation; missing trusted identity; unrelated operation/key provenance; unrelated conflicting mirror isolation; and exception rollback/retry. They inspect journal headers/entries, exact normal refund account legs, payment/refund state, frozen allocations/reservations, audits, original inbox payload/disposition, exception references/provenance and scope state. Ordinary fixtures already supplied explicit matching PaymentIntent; that behavior is preserved and a named absent-identity fixture now makes omission deliberate. No webhook field becomes universally required.

Before the service correction, the targeted new test group recorded 12 failures and 5 passes; the original success/failure cases returned PROCESSED instead of ACCOUNTING_EXCEPTION. Other baseline failures include missing provenance/unsafe unresolved identity and the rollback tests' exception precondition. After the correction, all 17 passed. The targeted filter deliberately excluded the 46 existing refund cases; the complete combined run below must execute every green PostgreSQL case without that filter. Logs/JSON are retained under `.tmp/h1-b221-*`, alongside the original review evidence.

Verification uses a new disposable PostgreSQL18.6 database, `fintech_h1_b221_1791548727899`, migrated fresh through 0005 on the existing localhost cluster. Node24.19.0/pnpm10.26.0 and workspace TEMP/TMP/cache placement are unchanged. No shared/production database, live Stripe, broker, consumer or runtime refund dispatcher is used.

All checks below were executed after the final service/test correction; no result is inherited from the original B2.2 implementation. For PostgreSQL set RUN_DB_TESTS=1 and DATABASE_URL to the new disposable database; the combined run also sets RUN_MIGRATION_TESTS=1 and MIGRATION_ADMIN_URL to the localhost cluster. The pending F01 command additionally sets RUN_F01_PENDING=1. Root Node checks run without database opt-ins.

| Exact command | B2.2.1 result |
| --- | --- |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/refund-accounting-integration.spec.ts --testNamePattern 'B2.2.1 provider identity consistency' --cacheDirectory ../../.tmp/jest-h1b221 --json --outputFile ../../.tmp/h1-b221-identity-after.json` | 17 passed; 46 existing cases excluded by the explicit filter and executed in the next command |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/refund-accounting-integration.spec.ts test/integration/capture-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts --cacheDirectory ../../.tmp/jest-h1b221 --json --outputFile ../../.tmp/h1-b221-pg.json` | Six suites / 147 passed, none skipped: 63 refund (46 existing + 17 new), 27 capture, 30 B1, 5 migration, 17 F02, 5 existing concurrency |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-h1b221 --json --outputFile ../../.tmp/h1-b221-f01-pending.json` | Six unchanged accounting assertions failed as expected; exit 1, none skipped/weakened |
| `pnpm lint`; `pnpm typecheck` | Passed API/web |
| `pnpm test` | 12 unit suites / 50 passed; 153 PostgreSQL cases skipped by default, all executed separately as 147 green + six pending red; web notice unchanged |
| `pnpm build` | Passed API/web production builds |
| `git diff --check`; `node .tmp/h1-b22-scope.cjs`; `node .tmp/validate-docs.cjs` | Whitespace/scope/documentation checks passed; 17 intended unstaged files and empty index, unchanged HEAD/legacy writers/historical migrations/F01 assertions |

The first post-edit static checks caught missing JSON-compatible evidence typing and untyped test SQL payload/audit results. The targeted suite could not compile until these were corrected; no financial test failure was relabeled. Final lint/typecheck, targeted/combined PostgreSQL, unit tests and builds above all passed after those corrections. The deliberately red before-fix baseline is retained separately in `.tmp/h1-b221-identity-before.*`; it is distinct from the six still-open F01 assertions.

No new provider/payment locks, mirror writes or network calls were added. The plain mirror read adds no wait edge; advisory/scope/payment NO KEY UPDATE/child/lot/allocation ordering and its documented future writer dependencies remain intact. Future dispatcher admission must precede mirror mutation. All scopes remain dormant, the service remains unregistered, F01/F04 remain open and B2.3/B2.4/B3 dependencies above remain. This correction is for final acceptance review, not activation or commit authorization.

## Final acceptance and checkpoint handoff (2026-10-10)

Final independent review returned **APPROVE** for committing B2.2/B2.2.1 as a dormant checkpoint. The review inspected the complete diff, transaction and provider identity checks, lock dependencies, migration and regression assertions. No release-blocking finding remains in this checkpoint's scope. The owner subsequently authorized commit and push; this authorization does not activate accounting scopes or authorize B2.3 work.

The acceptance review migrated a fresh disposable local PostgreSQL database through 0005 and reran the complete six-suite PostgreSQL command above with acceptance cache/output paths: **147 passed, none failed or skipped**. The six unchanged F01 pending assertions were rerun separately: **six failed as expected, none skipped**, confirming F01 remains unresolved. Acceptance evidence is retained under ignored `.tmp/h1-b22-acceptance-*`. The preceding successful lint, typecheck, 50-unit-test and build logs were inspected, not rerun during acceptance. Whitespace, intended-file scope and documentation link checks passed.

The service remains absent from runtime dispatch and all scopes remain dormant. Coordinated legacy writer locks, dispatcher admission and identity validation before mirror synchronization, B2.3 dispute accounting, B2.4 settlement/cutover and B3 verification remain required before activation. F04, live Stripe and RabbitMQ, and the full signed-webhook runtime path remain unverified by this checkpoint.
