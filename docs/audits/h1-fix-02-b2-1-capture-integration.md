# H1 Fix 02 B2.1: capture accounting integration

Status: implemented, awaiting human review; scopes dormant. Date: 2026-10-09. Owner: B2.1 implementation and verification evidence. Current behavior stays owned by [Payment lifecycle](../payment-lifecycle.md), [Ledger](../ledger.md), [Database design](../database-design.md), [Webhooks](../webhooks-and-idempotency.md), [Concurrency](../concurrency.md) and [Settlement/payout](../settlement-and-payout.md).

**F01 remains unresolved.** This checkpoint integrates only original capture evidence with the [approved Run A contract](h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09) and [committed B1 foundation](h1-fix-02-b1-allocation-foundation.md). Refund/dispute allocations, allocation-aware settlement and financial admission are not activated.

## Initial checkout and scope

Branch `main`; HEAD `5abeef20766f80c8f3c43e5b02c06f02ca7ea400`, `feat(accounting): add capture allocation foundation`. Working tree was clean, including untracked files. B1/B1.1 corrections are committed in migration 0004. Read repository/workflow routing, Run A/B1 records, SQL/helper, financial writers, provider bookkeeping, webhook processor and current domain/concurrency owners before changing capture locks.

Production code changes are confined to [WebhookBusinessService](../../apps/api/src/webhooks/webhook-business.service.ts). [LedgerService](../../apps/api/src/ledger/ledger.service.ts), allocation helper, schema, migrations 0000–0004, refund/dispute/settlement/payout services, provider commands and transport are unchanged. Updated the existing capture unit fixture; added [capture PostgreSQL regressions](../../apps/api/test/integration/capture-accounting-integration.spec.ts). Documentation updates are limited to the owners linked above, task routing/index, the Run A introduction, Verification and this record. Ignored `.tmp` database setup, logs and caches are not deliverables. No commit/push or B2.2 work.

## Capture journal-to-lot transaction

The existing inbox processor locks its one event and invokes the business service inside a READ COMMITTED database transaction. For normalized capture success:

1. Correlate without locking; discover the payment's canonical merchant UUID/currency, validate currency, acquire the existing payout advisory key, ensure a dormant scope exists and lock it. `ON CONFLICT DO NOTHING` preserves REVIEW_REQUIRED and existing exceptions.
2. Update the provider reference mirror, then lock payment with FOR NO KEY UPDATE and the specifically CAPTURE-kind attempt with FOR UPDATE. B2.1.1 changes only the capture-success payment lock; other payment handlers retain FOR UPDATE. Validate merchant/payment/currency, provider reference, amount and remaining authorization. A successful attempt returns before financial writes.
3. Refuse a pre-existing CAPTURE journal on an incomplete attempt. Such history needs review, including when its amounts happen to match; current merchant delay cannot establish historical eligibility.
4. Preserve the existing cumulative payment fee calculation and CAPTURE lines: D PSP_CLEARING gross; C MERCHANT_PENDING net; C PLATFORM_FEE_REVENUE fee. Zero legs remain omitted. `LedgerService.post()` constructs and seals the journal in the supplied transaction, returning its ID.
5. Apply the existing attempt/payment updates. Insert one new lot from `public.capture_accounting_legacy_inventory`'s canonical original evidence, requiring that the actual returned POSTED journal, ownership and G/F/N match this financial effect. The B1 evidence trigger independently checks the original and composite foreign keys enforce ownership.
6. Copy exact PostgreSQL `posted_at` as `financial_captured_at`; freeze `eligible_at` using the settlement delay read with the original fee terms, expressed as elapsed 24-hour days. No JavaScript date conversion loses microseconds. The lot defaults to NEW_CAPTURE, CAPTURE_FIFO_V1, revision 0 and UNSETTLED.
7. Append the existing audit and mark the inbox PROCESSED before committing. Deferred constraints still run at commit. Any lot/audit/inbox/commit failure rolls back all business effects, including mirror changes, journal, scope creation and payment/attempt updates. The processor records retry/dead state separately.

Original lot fees are read from the actual journal; replay never recalculates them from later merchant configuration. Capture fee generation itself remains the existing Number/cumulative payment policy; F03 and fee-term configuration work are not included. Financial time is local journal transaction time, not provider event time. Authorization alone, capture failure, synchronous provider results and unknown command outcomes create no lots.

## Idempotency and retained historical evidence

The locked successful-attempt guard prevents repeated financial application, including distinct provider events for one capture. Journal business uniqueness and unique lot attempt/journal references are durable backstops. Lot insertion deliberately has no conflict-ignore shortcut: a conflicting/inconsistent lot aborts the transaction instead of accepting divergent evidence. Whole-transaction retries retain operation/provider references and keys; no application mutex is introduced.

Already successful historical attempts return without creating lots or filling unknown eligibility. Existing B1 legacy lots keep LEGACY_ORIGINAL_ONLY and null eligibility, including when later new captures on the same payment receive independent lots. Existing exception rows and review scope status remain unchanged. An incomplete attempt with old financial evidence is rejected for review through the existing domain-error/DEAD path; this run does not implement accounting-exception inbox routing or repair that history.

## Lock order and compatibility review

Before: private inbox → provider mirror → capture attempt → payment → journal/accounts → audit.

Original B2.1: private inbox → unlocked discovery → merchant/currency advisory → scope → provider mirror → payment FOR UPDATE → CAPTURE attempt FOR UPDATE → new journal/accounts → new lot → audit/inbox completion. B2.1.1 retains this order and changes the capture-success payment mode to FOR NO KEY UPDATE.

The advisory expression uses the existing payout key `hashtextextended(merchantId + ':' + currency,0)` with canonical database UUID text. It precedes mirror writes, avoiding a future mirror→advisory reverse edge. No Stripe/RabbitMQ call occurs in this transaction. Scope and payment identity are checked again through locked payment/attempt validation; only one scope is visited.

| Inspected existing writer | Retained order and capture compatibility |
| --- | --- |
| Authorization success, including automatic capture intent | AUTHORIZE attempt→payment; inserts a new private CAPTURE attempt. Capture selects only CAPTURE attempts, never the shared AUTHORIZE child |
| Authorization failure, capture failure, cancellation | Payment→attempt UPDATE. Capture now uses payment→CAPTURE attempt, avoiding the prior shared-row inversion |
| API authorize/capture/cancel | Private idempotency→payment→new private attempt/outbox/audit. Existing authorization references are read without row locks |
| Provider command bookkeeping | Mirror→attempt/refund UPDATE; never subsequently locks payment, lot or advisory. Network call precedes its transaction |
| Refund request / success / failure | Request payment→new refund; success refund→payment→journal; failure refund UPDATE only. Capture never locks refund rows |
| Dispute open / close | Open payment→new dispute→journal; close dispute→journal→payment. Capture never locks dispute rows or their close journals |
| Settlement generation / completion | Generation locks successful attempts with FOR UPDATE SKIP LOCKED, then item insertion takes implicit payment KEY SHARE through its foreign key. Capture's FOR NO KEY UPDATE permits that FK check. Completion header→journal, with no later payment/attempt lock |
| Payout reservation / completion | Reservation advisory→balance→private payout/journal. Same scope serializes capture; completion payout→journal with no later payment/attempt/advisory lock |

The original B2.1 inspection incorrectly concluded that no credible new shared-row inversion existed: it missed generation's implicit payment foreign-key lock. Independent review returned REQUEST CHANGES and reproduced the deadlock described below. No unrelated handler was reordered. The newly inserted lot is private and requires its original journal/successful attempt before insertion. Future operations modifying existing lots must prelock them before posting new financial journals. The table above is not a completed common financial protocol: later refund/dispute/settlement integration must coordinate their child and header order before activation.

PostgreSQL tests use explicit transaction barriers and `pg_blocking_pids`, not timing-only assertions: a duplicate waits on advisory, the payout key blocks capture before mirror mutation, and an existing payment-first writer finishes its capture child update while capture waits for payment. Distinct signed inbox events also process concurrently. Universal deadlock freedom, simultaneous cross-scope account creation and all legacy callback interleavings remain unproven; aborted transactions require whole-operation retry.

## B2.1.1: reviewer-discovered deadlock and correction

The independent review used actual WebhookBusinessService and SettlementsService transactions on disposable PostgreSQL18.6. Generation held the successful CAPTURE attempt; duplicate capture held its payment FOR UPDATE and waited for the attempt. Generation then inserted a settlement item. Its payment FK required KEY SHARE, which conflicts with FOR UPDATE, completing a cycle. The successful-attempt guard comes after both row locks and cannot avoid this wait. Dormant scopes do not help because legacy generation does not take the capture advisory key.

Retained reviewer evidence in ignored `.tmp/h1-b21-review-locks.json` records SQLSTATE **40P01**: capture backend 27276 waited for transaction 7126 owned by generator 18932; generator 18932 waited for transaction 7127 owned by capture 27276. Capture aborted; generation committed. One original CAPTURE journal, one lot and one settlement item remained. A comparison-only FOR NO KEY UPDATE run let both transactions finish. The review did not modify production code or claim that rollback had corrupted financial evidence.

This correction uses FOR NO KEY UPDATE **only for capture success/replay**. Capture updates status, captured_amount, platform_fee_amount, captured_at, version and updated_at; it changes none of the referenced id/merchant/currency keys. The new lock conflicts with another payment write lock and with ordinary non-key UPDATE, protecting amount/fee calculations and preventing lost updates. It permits KEY SHARE for the unchanged payment identity, so generation can insert its item and release the attempt even while replay waits. The attempt remains FOR UPDATE. Transaction boundaries, ledger/lot evidence, provider keys, migrations and all legacy accounting calculations are unchanged; no retry was added to mask the cycle.

The permanent capture integration suite adds three cases. Two actual-service schedules acquire generation's attempt first or capture's payment first, then observe capture blocked on generation before permitting item insertion. Each also observes a second duplicate waiting on capture's advisory lock. All three transactions must fulfill without retries; tests assert one CAPTURE journal/lot/item, valid journal/lot/payment/attempt references, exact batch/item 10000/300/9700 totals, and unchanged original ledger entries, lot amounts/timestamps/eligibility and payment state. A third schedule observes actual RefundsService.applySucceeded blocked on capture's payment lock, then verifies both transactions commit, captured 10000/refunded 1000, the existing fee reversal 30 and one refund journal, with unchanged original capture evidence. This tests retained legacy behavior, not B2.2 allocation integration.

The tests have bounded barrier waits, PostgreSQL statement timeouts and per-test deadlines. They attach rejection handlers immediately, release all JavaScript transaction gates in finally and await every transaction's settled result. A failed/deadlocked transaction fails the assertions even if another duplicate succeeds. With original production code, **both acquisition-order regressions failed with 40P01**; their log/JSON remain in ignored `.tmp/h1-b211-before.*`. With the corrected production lock, all 27 capture cases passed.

Focused adjacent inspection found no additional confirmed inversion against the corrected capture path. Authorization success uses a different AUTHORIZE child after mirror bookkeeping; capture failure uses payment→CAPTURE child; refund success uses refund→payment but capture never locks that refund; dispute open uses payment and new private evidence, while close uses dispute→journal→payment and capture never visits that dispute/close journal. Payout reservation shares capture's advisory key before other financial work. These observations do not prove all callback or cross-scope account-creation schedules deadlock-free.

Later coordinated adoption must acquire the shared advisory/scope locks before provider-mirror or shared child writes, then payment rows, existing CAPTURE/refund/dispute children, existing lots/allocations and new journals in stable order. Refund success must move from refund→payment before allocation-aware payment→refund callers are introduced. Dispute close's dispute→journal→payment must be coordinated in its integration run. Generation's current attempt→payment-FK dependency and completion's shared header must be included in the settlement protocol review; completion locks its header before members, while new generation headers are private. No current handler is allowed to bolt an advisory lock on after acquiring its mirror/child locks. These are rollout dependencies, not changes implemented here.

## Dormant activation contract and legacy compatibility

Reuse `capture_accounting_scopes`; its check permits only FOUNDATION_ONLY and REVIEW_REQUIRED. B2.1 neither extends that check nor creates ACTIVE. These states mark installation/review, not financial quarantine, writer capabilities or reconciled balances. No feature-flag framework or migration is needed for this checkpoint.

Refund/dispute/settlement services read no lots/allocations and retain legacy behavior. New frozen eligibility does not influence legacy generation, which still uses attempt timestamps/current merchant delay. Legacy adjustments can make a lot's zero allocation counters diverge from current economic history while dormant. Neither those counters nor a FOUNDATION_ONLY label can admit new-model settlement. Existing payouts can still spend pooled legacy available funds despite review exceptions; F04 and F01 remain open. Existing exception evidence is retained and inspectable in PostgreSQL, with no new administration UI.

Before a future reviewed forward migration can permit explicit per-scope ACTIVE cutover:

1. Every required capture/refund/dispute/settlement writer, retry/replay and financial admission path must implement the approved allocation/lock protocol. Prevent older binaries and in-flight legacy operations from continuing across cutover.
2. Reconcile live capture ownership, original journals, eligibility and complete refund/dispute/settlement history, including new legacy adjustments since 0004. Verify pooled balances/payout effects and pending provider intents; the live inventory view and the initial backfill alone are insufficient. Missing lots or null historical eligibility require verified treatment, never current-term guesses.
3. No unresolved blocking accounting exception may remain. A resolution note or successful new capture must not activate the scope. Admission must address pooled financial effects or refuse activation; a payment flag does not quarantine pooled available funds.
4. Generation/completion must use locked current allocation evidence, unique candidates, actual final revisions and separate surviving asset/release amounts, including ZERO_EFFECT.
5. Required arithmetic, integration, rollback, duplicate and concurrency/cutover regressions must pass before the guarded scope transition. Transition and participating writers must use the same admission lock and recheck prerequisites transactionally; a schema default cannot activate scopes.

This is a prerequisite contract for the full B2 rollout, not implemented activation automation. Unreconciled legacy/review scopes remain ineligible for future activation. Application rollback can leave the additive schema/evidence installed but stops lot accumulation; any later activation review must detect that gap. Historical migrations and journals are untouched. Fresh install/valid legacy upgrade use the committed 0000–0004 chain; B1 maintenance-lock/large-history considerations remain unchanged.

## Original B2.1 regression evidence and commands

These are retained implementation-run results before the independent review; passing checks did not cover the missed settlement FK dependency. B2.1.1 results are recorded separately below.

Local Windows, Node24.19.0/pnpm10.26.0, disposable PostgreSQL18.6 on 127.0.0.1:55432. Created `fintech_h1_b1_fresh_1791526552037` with the checked-in Drizzle migrator; separate migration fixtures create and retain fresh UUID-named local databases. No shared/production database was reset or migrated.

Set `RUN_DB_TESTS=1`, `RUN_MIGRATION_TESTS=1`, DATABASE_URL to that disposable migrated database, and MIGRATION_ADMIN_URL to its localhost cluster for the green database command. Default Node checks run without these opt-ins. Logs/cache/JSON evidence stay ignored under `.tmp`.

| Exact command | Result |
| --- | --- |
| `pnpm lint` | Passed after correcting new test typing/unused import |
| `pnpm typecheck` | Passed |
| `pnpm test` | Passed: 50 unit tests, 86 database cases skipped by default (executed separately below); web script is a notice |
| `pnpm build` | API/web passed; first sandbox invocation failed creating Next output with EPERM, permitted retry passed |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts --cacheDirectory ../../.tmp/jest-h1b21 --json --outputFile ../../.tmp/h1-b21-all-pg.json` | Passed: 5 suites / 80 cases: capture 24, B1 foundation 30, migration 4, F02 17, financial concurrency 5 |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-h1b21 --json --outputFile ../../.tmp/h1-b21-f01-pending.json` with RUN_DB_TESTS/RUN_F01_PENDING=1 | All six unchanged assertions failed as expected; exit 1, none skipped or weakened |
| `node .tmp/validate-docs.cjs` | Passed: 31 Markdown files / 300 relative links and anchors; CI YAML parsed/structure checked; 14 Mermaid blocks extracted, not rendered |
| `git diff --check` | Passed using repository line-ending configuration; new-file whitespace also checked. A temporary command-only `core.autocrlf=false` override misread existing CRLF as whitespace; no files/config were normalized |

New capture cases cover single/partial captures, G/F/N including zero fee/net, frozen exact timestamps/eligibility despite term changes, duplicates, failure/authorization/unknown command boundaries, cross-owner/currency rejection, injected post-journal rollback and real PostgreSQL lot-constraint rollback/retry, refusal of old journals for incomplete attempts, preserved review exceptions, old/mixed legacy eligibility, three controlled lock schedules, concurrent signed inbox processing and F02/original-lot immutability. The first test invocation exposed a text/UUID comparison in the new audit-count fixture; that fixture was corrected. An initial 20-case capture pass and subsequent 79-case combined pass preceded the final mixed legacy/new regression. No production correctness failure was concealed as an expected F01 failure.

## B2.1.1 verification, 2026-10-09

Initial branch/HEAD and the 14 unstaged B2.1 deliverables were preserved. This correction changes only the capture-success payment lock, adds three tests to the existing capture suite, and corrects this record and the current Concurrency owner. Local tools remain Node24.19.0/pnpm10.26.0/PostgreSQL18.6. Created and migrated a new disposable localhost database `fintech_h1_b211_1791539658317` with unchanged migrations 0000–0004; no existing database was reset. Reviewer evidence remains intact.

For the database commands set RUN_DB_TESTS=1 and DATABASE_URL to that migrated disposable database; the migration suite additionally uses RUN_MIGRATION_TESTS=1 and MIGRATION_ADMIN_URL for the localhost cluster. The F01 command uses RUN_F01_PENDING=1. Default checks run without these database opt-ins. Corepack uses the already installed pnpm cache; default Jest uses ignored workspace `.tmp` for TEMP/TMP. No dependencies were installed.

| Exact command | B2.1.1 result |
| --- | --- |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-integration.spec.ts --testNamePattern='allows settlement generation and duplicate captures' --cacheDirectory ../../.tmp/jest-h1b211 --json --outputFile ../../.tmp/h1-b211-before.json` before production correction | Both selected schedules failed with 40P01; exit 1. The 25 unselected cases were skipped by the explicit name filter. This preserves defect evidence; it is not a green check |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-integration.spec.ts --cacheDirectory ../../.tmp/jest-h1b211 --json --outputFile ../../.tmp/h1-b211-capture.json` | All 27 passed: original 24 plus settlement-first, capture-first and same-payment refund-writer serialization; no skipped cases or transaction retries |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-integration.spec.ts --testNamePattern='allows settlement generation and duplicate captures\|serializes a refund writer' --cacheDirectory ../../.tmp/jest-h1b211 --json --outputFile ../../.tmp/h1-b211-locks.json` | All 3 selected lock regressions passed again after test observer typing cleanup; 24 other cases excluded by the name filter |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts --cacheDirectory ../../.tmp/jest-h1b211 --json --outputFile ../../.tmp/h1-b211-other-pg.json` | All 56 passed / 4 suites: foundation 30, migration 4, F02 17, financial concurrency 5. Together with capture, 83 green PostgreSQL cases |
| `pnpm lint` | Passed after annotating three new Reflect.apply observer results as unknown; first run reported six unsafe assignment/return errors in test code |
| `pnpm typecheck` | API/web passed, including after test typing cleanup |
| `pnpm test` | Passed: 50 unit cases; 89 database cases skipped by default, 83 green and six known-red executed separately. Web script is a notice |
| `pnpm build` | API/web production builds passed |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-h1b211 --json --outputFile ../../.tmp/h1-b211-f01-pending.json` | All six unchanged correct-behavior assertions failed as expected; exit 1, none skipped or weakened. F01 remains unresolved |
| `node .tmp/validate-docs.cjs` | Passed: 31 Markdown files, 300 relative links/anchors, CI YAML parsed; 14 Mermaid blocks extracted, not rendered |
| `node .tmp/h1-b21-scope.cjs`; `git diff --check` | Passed: 14 intended unstaged files, empty index, unchanged HEAD/migrations/legacy financial writers/provider transport/F01 assertions; tracked and untracked whitespace clean |

Tests use the actual services and database constraints; no live provider/broker calls occur. The fix removes the observed lock cycle without swallowing 40P01 or retrying transactions. No claim is made about all possible callback/account-creation interleavings, higher isolation, hosted CI/PostgreSQL17/Node22, live Stripe/RabbitMQ/Redis or production workloads. Financial atomicity/replay evidence remains green; scopes remain dormant. B2.1 with this correction is ready for another final review, not F01 closure or accounting activation. The disposable cluster was stopped after verification, retaining its databases and ignored before/after logs. Nothing was staged, committed or pushed.

## Remaining rollout and verification limits

**B2.2:** frozen refund reservation attribution, confirmed success/failure and approved exact per-capture fee/source accounting. **B2.3:** dispute principal/funding/adjustment/closure integration and retained ambiguous evidence. **B2.4:** allocation-aware generation/completion, ZERO_EFFECT, accounting-exception inbox/admission and guarded scope cutover. These labels describe remaining work; none is started or authorized by this checkpoint's completion.

**B3:** full Run A accounting/race matrix, stale generation/completion, capture/adjustment/settlement schedules, signed debt, funding reductions, all rollback/reordered evidence cases, concurrent account creation, activation/rollback and old-worker races, and reviewed financial admission. Capture tests do not prove those wider invariants. Existing six F01 defects remain demonstrated. General money representation, F04 and other H1 findings remain out of scope.

Hosted CI/PostgreSQL17/Node22, Docker, live Stripe/RabbitMQ/Redis, large migration/lot-query performance and live multicapture behavior were not executed. Provider/broker boundaries are mocked; no external reconciliation/consumer process was started. The original readiness claim was rejected by independent review; the B2.1.1 correction requires another final review, with allocation activation and F01 closure explicitly withheld.

Final scope/whitespace review confirmed 14 intended unstaged files, an empty index, unchanged HEAD/migrations/legacy writers/provider transport and unchanged six F01 assertions. The disposable PostgreSQL cluster was stopped after verification, retaining all test databases. No temporary helper was included as a deliverable; no commit or push was performed.
