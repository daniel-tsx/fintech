# H1 Fix 02 B1: capture accounting allocation foundation

Status: implemented B1/B1.1 checkpoint, dormant at runtime; finalized for the owner-authorized local commit. Date: 2026-10-09. Owner: B1 implementation, migration evidence and B2 handoff. [Database design](../database-design.md), [Ledger](../ledger.md), [Concurrency](../concurrency.md) and the existing flow documents retain current behavior ownership.

**F01 remains open.** B1 installs schema, deterministic helpers and regressions. It does not change capture/refund/dispute/settlement writers, payout admission, inbox processing, Stripe or RabbitMQ. All new settlement columns remain null for legacy writers. Local commit authorization does not activate the foundation or authorize a push.

## Inspected checkout and scope

Branch `main`, HEAD `d1b9ef841552082823043c90d95930c16b1e59f6` (F02). Initial worktree: modified `docs/README.md` and untracked [Run A design](h1-fix-02-settlement-design.md), both preserved and updated under this instruction. Historical migrations 0000–0003 remain unchanged.

Read agent/workflow routing, the H1 audit, F02 and Run A records, all relevant accounting/database/concurrency owners, schema/migrations and the capture, ledger, refund, dispute, settlement, payout, webhook/inbox/outbox and reconciliation implementations. Existing reconciliation issues are run-associated provider drift snapshots with editable resolution notes; they cannot cleanly supply immutable event-scoped conflict evidence and capture relationships. The narrow new exception table is therefore justified. No general reconciliation administration product was added.

Created: migration 0004; `ledger/capture-allocation.ts`; allocation unit tests; foundation, migration and opt-in F01 integration suites; shared accounting fixtures; this checkpoint record. Modified: migration manifest, Drizzle schema, Run A approval record, documentation index/routing, Database design, Ledger, Concurrency and Verification. Ignored setup/cache/log helpers remain under `.tmp`; they are not deliverables. Unrelated existing work was not removed.

## Approved contract represented

[The human-approved Run A contract](h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09) is Approach A: each capture owns original gross G, fee F and net N=G−F from its immutable CAPTURE journal. Refund attribution is chronological FIFO by financial posting microseconds, then capture-attempt ID; acceptance freezes attribution. Later captures cannot retarget a replay.

For cumulative confirmed refund gross R:

```text
returnedFee(R) = floor(F × R / G)
feeDelta = returnedFee(newR) − previouslyConfirmedFee
remainingPrincipal = G − confirmedRefunds − reservations − activeDisputes − lostDisputes
```

The [pure helper](../../apps/api/src/ledger/capture-allocation.ts) uses BigInt for inputs, multiplication and division, including products larger than JavaScript's safe integer range. New database calculations multiply `numeric` and use `pg_catalog.div(numeric,numeric)` for the integer quotient. For nonnegative inputs and positive gross this matches BigInt; numeric `/` followed by `floor` can round incorrectly and was corrected in B1.1 below. New Drizzle financial columns use bigint mode; existing global Number/API representation remains unchanged (F03).

Examples: 1000/fee101 with refunds333,333,334 returns fee33,34,34. A fixed fee100 on gross10000 returns 30 at refunded gross3000 and the remaining70 at full refund. Mixed captures A4000/fee120 and B6000/fee180 allocate refund5000 as A4000+B1000, with fee120+30. Unit results do not establish live writer integration.

**Pending Option A:** gross reservations consume capacity but do not reduce ledger entitlement or block payout. Unknown outcomes remain reserved; only correlated confirmed failure can release them. Confirmed success changes accounting. A post-settlement/post-payout confirmation may create signed debt under the approved lab model. Strict pending-refund payout protection remains separate.

Dispute principal and funded liability are separate. Gross10000 with net9700 can record hold9700/exposure300, not an invented hold10000. Funded holds cannot exceed surviving merchant entitlement. Adjustments are append-only financial effects, not overwrites of original funding. Automatically supported principal is disjoint; contradictions require retained evidence and explicit review, without guessed net losses/corrections.

## Schema and transactional guarantees

[Migration 0004](../../apps/api/drizzle/0004_capture_accounting_foundation.sql) adds seven tables:

| Table | Evidence owned |
| --- | --- |
| `capture_accounting_scopes` | Merchant/currency installation/review gate; only FOUNDATION_ONLY or REVIEW_REQUIRED |
| `capture_accounting_lots` | Unique successful capture and original journal, immutable G/F/N/timestamp/policy, eligibility, allocation revision and settlement identity |
| `refund_capture_allocations` | Unique refund/lot, frozen reserved gross, RESERVED→CONFIRMED or RELEASED, exact confirmed amounts, journal/event |
| `dispute_capture_allocations` | Case/lot principal, immutable original funding/exposure, PLANNED→OPEN→CLOSED and outcome/journals |
| `dispute_hold_effects` | Append-only per-allocation effect key, signed hold delta, journal, event and causal refund/dispute |
| `accounting_exceptions` | Immutable scoped source/conflict evidence, stable idempotency key and explicit reviewed resolution |
| `accounting_exception_lots` | Immutable exception/capture ownership links where attribution is known |

Composite foreign keys prevent cross-payment/merchant/currency references within the new foundation. Unique original journal/attempt references prevent duplicate lots. Positive principal and gross/net/funding checks supplement deferred aggregate checks. Original lot values must match a canonical POSTED CAPTURE with successful, matching attempt; journal correction is never an original-value overwrite.

Allocation writes serialize through an intent parent and a real shared lot revision UPDATE. Deferred validation covers the whole accepted refund/case, confirmed fee totals, disjoint principal capacity, remaining funded entitlement and matching POSTED business journals. Final refund/dispute effects are immutable; hold effects cannot be updated/deleted. Deletion/TRUNCATE of new financial evidence is rejected. Scoped source journal checks supplement F02 sealing rather than replacing it. Eight invoker functions pin `search_path=pg_catalog, pg_temp` and qualify persistent objects; no privileged execution was introduced.

SQL evidence linkage is not cryptographic webhook verification, provider authentication or authorization of a human resolver. Existing signature verification owns authentic receipt; B2 must validate correlation before writing effects/exceptions. Foundation tests use explicit local evidence fixtures excluded from worker claiming, not provider delivery proof.

Settlement/item additions retain original gross/fee/net and separately store policy, estimated asset/release, selected revision, final asset/release, restricted hold, applied revision, final journal/time and POSTED/ZERO_EFFECT. Candidate totals equal actual items. Finalized lots/items/batches agree and freeze their financial evidence. Initial finalization reconciles confirmed allocations, mature eligibility and journal amounts. A real fully refunded candidate can finalize ZERO_EFFECT without an empty journal or zero entries. Later allocation revisions do not rewrite earlier finalization. These are fixture/constraint capabilities, not activated completion logic.

Foundation finalization and exception creation version the shared scope; earlier exception evidence is seen or a stale repeatable-read snapshot aborts. Current legacy settlement still ignores these tables/gates and remains defective. [Concurrency](../concurrency.md#dormant-b1-allocation-constraints) specifies required parent prelocking and multi-lot order; triggers alone are not a complete future caller protocol.

## Migration, inventory and rollback

Drizzle's normal migrator applies 0004 transactionally after 0000–0003. It locks financial header/entry and workflow tables for maintenance; unique/FK installation can acquire ACCESS EXCLUSIVE locks and block reads. Drain writers and schedule the migration accordingly. Large histories may make the inventory scans/constraint installation expensive; no production-size timing is claimed. Timeout/deadlock/failure requires whole-transaction rollback and retry after review.

`capture_accounting_legacy_inventory` verifies canonical original journals/attempts and reports refund, dispute and settlement-item counts. Only clean, unadjusted, unsettled originals backfill lots; they have `origin=LEGACY_ORIGINAL_ONLY`, with `eligible_at=NULL`. Historical delay/terms cannot be recovered from today's configuration. Any existing refund (even pending/failed), dispute or settlement candidate makes that capture require review; no allocations or fee-policy conversions are invented.

Adjusted, settled, missing/noncanonical original evidence creates LEGACY_ALLOCATION_UNRECONCILED exceptions and REVIEW_REQUIRED scopes. `capture_accounting_orphan_inventory` finds CAPTURE journals without a CAPTURE attempt; scoped orphans create immutable review evidence without guessed payment links. CAPTURE evidence lacking merchant/valid currency refuses 0004 atomically because it cannot be routed to a review scope. All historical journals/entries remain unchanged.

The views are live inspection tools. Their classification may change as legacy writers append history; the initial backfill/review gate must never be treated as an evergreen activation decision. No current service automatically creates lots for new captures or keeps legacy-backfilled lots authoritative.

Repeated **migrator execution** is a no-op; raw SQL 0004 is not independently idempotent and must not be rerun outside the manifest. A failed migration leaves schema/evidence and recorded migration count unchanged. After successful installation, keep the dormant additive schema when rolling application code back; do not destructively drop evidence or remove migration history. Any later recovery/removal needs a reviewed forward migration. No production database was touched/reset.

## Exception lifecycle and B2 admission contract

Sources are WEBHOOK, LEGACY or INTERNAL; categories are REFUND_DISPUTE_PRINCIPAL_OVERLAP, AMBIGUOUS_PROVIDER_NET_EFFECT, LEGACY_ALLOCATION_UNRECONCILED or SETTLEMENT_ELIGIBILITY_CONFLICT. Webhook exceptions require original event FK and `webhook:<inbox UUID>` evidence key, with uniqueness by scope/category/evidence. Known payment/refund/dispute/lot references preserve scope. Observed conflict JSON retains amounts/references; original inbox payload remains separate and immutable. This supplies idempotent exception storage without pretending to know the provider's final net loss.

Lifecycle: OPEN retains evidence and sets the scope REVIEW_REQUIRED; RESOLVED requires a nonempty resolution reference, resolver and timestamp, then becomes immutable. Resolution neither posts a journal nor activates a scope automatically. B2 must enforce human authorization and a reviewed reconciliation transaction with stable effect keys, not arbitrary row editing or fabricated compensation.

Current inbox statuses PENDING/PROCESSING/PROCESSED/RETRY/IGNORED/DEAD do not express accepted receipt with unresolved accounting application cleanly. Smallest proposed B2 addition: **ACCOUNTING_EXCEPTION**, excluded from normal claim/retry. Verified receipt → PROCESSING → effect commit+PROCESSED, or durable exception+ACCOUNTING_EXCEPTION in one transaction. No false PROCESSED/IGNORED or endless retry for ambiguous evidence. Operational/transient failure still uses existing retry behavior. Explicit reviewed resolution may requeue a correlated event using existing business/allocation keys; it must never erase the old conflict or infer failure from timeout. This status/routing is proposed, not added in B1.

Ordinary pending reservations are distinct from conflicting evidence. An unresolved conflict cannot automatically finalize the new foundation, but **B1 does not quarantine already-pooled available funds or block current payouts**. B2/B3 must provide a narrowly tested merchant/currency financial admission guard shared by affected writers/payouts, or refuse activation of that scope. Do not call a payment-specific flag pooled-payout protection; F04 stays open.

## Original B1 executed evidence, before independent review

The original results below are retained as history. They did not cover the defects subsequently found by the independent reviewer. The B1.1 section records their corrections and current verification separately.

Windows, Node24.19.0, pnpm10.26.0, isolated PostgreSQL18.6 at 127.0.0.1:55432. The baseline database `fintech_h1_b1_before_1791520708917` used 0000–0003. Final fresh database `fintech_h1_b1_fresh_1791522348151` used 0000–0004. Migration tests create/retain UUID-named local databases; no production URL, Stripe call or broker service is needed. Disposable history is retained; the local cluster is stopped after verification.

| Check | Status / result |
| --- | --- |
| Pure allocation suite | Passed: 15 new cases, including FIFO/replay/scope/rounding/unsafe products |
| Foundation PostgreSQL suite | Passed: 19 cases, ownership/uniqueness, positive/aggregate bounds, lifecycle, fee evidence, immutable effects, hold adjustments, exceptions, rollback, zero effect, legacy coexistence, RC/RR capacity races and earlier-exception serialization |
| Migration PostgreSQL suite | Passed: 3 cases, fresh/empty/no-op rerun, seeded upgrade, deliberate unscoped-history refusal |
| Existing PostgreSQL suites | Passed: all 17 F02 and 5 financial integration cases, total 44 with B1 |
| Default `pnpm test` | Passed: existing 34 plus new 15 unit tests (12 suites); 50 database/pending tests in 5 suites explicitly skipped by default |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Passed for API and web |
| Opt-in F01 behavioral suite | Failed as expected before and after 0004: all 6 correct-outcome assertions expose unchanged current defects; not a green regression claim |
| `git diff --check` and direct untracked whitespace checks | Passed; manual scope review preserves 0000–0003 and all existing financial service files |
| Existing `.tmp/validate-docs.cjs` | Passed: 30 Markdown files, 277 relative links/anchors; CI YAML parsed/structure checked. Extracted 14 unchanged Mermaid blocks; no parse/render claim |

Upgrade fixtures include clean original, pending settlement, settled capture, partial/full refunds, dispute, balanced noncanonical capture, missing capture journal and scoped orphan journal. Journal/header and entry fingerprints stay identical. All prior function definitions, including F02, remain identical; installed foundation functions are checked for invoker/search-path configuration. No historical fee/settlement allocation is fabricated. Empty fresh install and unscoped refusal check manifest counts and atomicity.

F01 observed pre-fix balances (minor units, scoped fixture journals):

| Case | Expected new policy | Current observed result |
| --- | --- | --- |
| A, refund5000 then settle | cash5000, available4850, pending0, PSP0 | cash10000, available9700, pending−4850, PSP−5000 |
| B, full refund then settle | no SETTLEMENT journal, asset/release0 | cash10000, available9700, pending−9700, PSP−10000 |
| C, hold5000 then settle | cash10000, available4700, hold5000, pending0 | available9700, hold5000, pending−5000 |
| D, candidate then refund/hold | recomputed effects matching A/C | same incorrect original release9700 |
| E, settled A4000 + pending B6000, refund5000 | cash0, PSP5000, available0, pending4850, fee refund150 | cash−1000, PSP6000, available3880, pending970, fee refund150 |

The [opt-in suite](../../apps/api/test/integration/settlement-f01.pending.spec.ts) asserts the correct outcomes without weakened expectations. It requires both RUN_DB_TESTS=1 and RUN_F01_PENDING=1. B2 must turn these failures green through runtime integration; schema tests cannot substitute for them.

Environment/setup failures were visible and corrected: Corepack sandbox bootstrap needed its existing pnpm cache; sandbox local sockets required permitted localhost access; restricted Jest cache and Next output paths hit EPERM and passed on permitted retries. First migration compile hit CASE-expression syntax and was corrected. Initial foundation failure was only an incorrect error-message pattern. The migration harness initially shared Drizzle/application clients, whose JSON serializers differ; it now uses separate clients like the normal migration entry point. Initial lint found two untyped SQL row arguments, corrected with concrete row types. No production financial service was changed to address these test/setup issues.

## Reproduction commands

From the repository root, with a migrated disposable local DATABASE_URL (private values are never printed):

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
# MIGRATION_ADMIN_URL must reference the disposable localhost cluster and allow CREATE DATABASE.
pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts --cacheDirectory ../../.tmp/jest-h1b1
$env:RUN_F01_PENDING='1'
pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-h1b1
# The command immediately above intentionally exits nonzero until B2.
Remove-Item Env:RUN_DB_TESTS,Env:RUN_MIGRATION_TESTS,Env:RUN_F01_PENDING
git diff --check
```

Local pnpm invocations used the already-installed Corepack cache via COREPACK_HOME; no new dependencies or package changes. [Verification](../verification.md) owns general setup and command routing. The existing ignored link/YAML helper also checks this documentation; no Mermaid blocks were changed in B1 and no new parser/render evidence is claimed.

## B1.1 independent review corrections, 2026-10-09

The independent review returned **REQUEST CHANGES**: three P1 financial correctness findings and one P2 fixture-quality finding. It independently passed the then-existing 49 unit and 44 PostgreSQL tests, while ordinary isolated fixtures demonstrated defects that those tests missed. No finding or original execution record was removed.

| Finding / root cause | Correction and regression evidence |
| --- | --- |
| P1: NULL ownership skipped by `bool_and` | Canonical journal/entry predicates now require `IS TRUE` before aggregation. The upgrade fixture retains a balanced historical CAPTURE whose MERCHANT_PENDING account has no merchant, classifies it REVIEW_REQUIRED, creates an OPEN exception and no lot, and still backfills an independent valid capture. History fingerprints remain identical; attempted lot insertion for the invalid original is also rejected |
| P1: final item/lot without final batch | Deferred settlement validation now rejects any finalized item unless its batch also has a final outcome. Existing batch checks then require SUCCEEDED, reconciled totals, matching POSTED journal or genuine ZERO_EFFECT, and no OPEN scope exceptions. POSTED and ZERO_EFFECT partial-finalization fixtures reject at commit and leave batch/item/lot/journal state unchanged. Additional cases reject a completed batch referencing DRAFT and reject zero effect with positive remaining obligations. A positive case constructs batch and lot before final item, inserts/posts its journal last and passes `SET CONSTRAINTS ALL IMMEDIATE`; the existing positive zero-effect case creates no journal |
| P1: rounded SQL fee quotient | `pg_catalog.div` replaces `floor(numeric / numeric)`; multiplication stays numeric to avoid bigint overflow. Stored allocation/POSTED journal tests match the BigInt helper for the exact counterexample, maximum fee=gross, above-Number-safe inputs, 333/333/334 partials and fixed-fee/final-remainder cases. Incorrect fee rejection also checks journal and revision rollback; cumulative reversal stays bounded by the original fee and full refund returns it exactly |
| P2: post-settlement fixture credits PSP | Test confirmation now credits PLATFORM_CASH for finalized lots and PSP_CLEARING for unsettled lots, with the matching available/pending debit. The post-settlement case asserts all affected account balances, finalized allocation, preserved item/batch totals and original capture/settlement journal fingerprints. A mixed A4000 settled/B6000 pending refund5000 verifies cash4000/PSP1000 credits, available3880/pending970 debits and fees120+30, leaving cash0/PSP5000/available0/pending4850 |

The exact arithmetic counterexample is `G=9223372036854775807`, `F=9223372036854775806`, `R=4611686018427387903`. Correct cumulative fee is `4611686018427387902`; the original SQL returned one more. BigInt and the corrected PostgreSQL constraint now agree, including the final remainder. Exact SQL fixtures serialize monetary values as decimal strings and exercise actual allocation triggers; they do not refactor production Number-based APIs or LedgerService.

**Migration decision at B1.1:** 0004 was uncommitted, and all installations recorded in this session were disposable local databases. It was amended as explicitly permitted by B1.1; 0000–0003 and the manifest's original entries remain unchanged. New databases test the amended chain; existing baseline/review databases are retained without rewriting their history. An existing installation of the old 0004 does not get updated by rerunning Drizzle. If that version was applied outside these disposable fixtures, preserve it and use a reviewed forward migration. Maintenance locks, writer draining and transactional rollback requirements above remain unchanged.

The original 0004 baseline database for B1.1 was `fintech_h1_b1_fresh_1791524776291`; the amended full-chain database was `fintech_h1_b1_fresh_1791524864052`. Migration suites additionally create and retain UUID-named databases. The same local PostgreSQL18.6/Node24.19.0/pnpm10.26.0 environment was used.

| B1.1 check | Executed result |
| --- | --- |
| Before SQL correction | Four selected regressions failed for the intended reasons: NULL ownership was accepted; POSTED and ZERO_EFFECT partial finalization committed; the counterexample's incorrect fee was accepted |
| Foundation PostgreSQL | 30 passed: original 19 plus five fee cases, five finalization cases and mixed-source refund; the prior post-settlement case now has stronger account/evidence assertions |
| Migration PostgreSQL | Four passed: fresh installation/no-op rerun, existing seeded upgrade, exact NULL-ownership upgrade and atomic unscoped-history refusal |
| F02 / existing financial PostgreSQL | All 17 F02 and five existing cases passed; total 56 PostgreSQL tests in four suites, no skipped cases in this run |
| Allocation unit / default `pnpm test` | 16 allocation cases; all 50 unit tests in 12 suites passed. The 62 database/pending cases remain explicitly opt-in, and were executed separately as 56 green plus six F01 red |
| Six existing F01 behavioral assertions | All six still fail as expected against amended 0004. Their source/expectations and production financial writers are unchanged; F01 is still open |
| `pnpm lint` / `pnpm typecheck` | API/web passed. Initial lint identified untyped new SQL fixture rows; explicit row types corrected them |
| Initial finalization test assertion | PostgreSQL correctly rejected the DRAFT journal; the new expected-message pattern omitted “immutable”. Correcting only that pattern produced the final 56/56 pass |
| `pnpm build` | API/web passed on the permitted retry. Initial sandbox attempt hit EPERM creating Next's `.next/server/app/reconciliation` directory; no source change was needed |
| Documentation validation | 30 Markdown files and 278 relative links/anchors passed; CI YAML parsed/structure checked. Fourteen Mermaid blocks were extracted only, with no parse/render claim |
| Scope / whitespace | `git diff --check` and direct checks for all 18 B1 files passed; staging remains empty and 0000–0003 are unchanged |

B1.1 changed only 0004, the foundation/migration/unit regression files, this checkpoint and Verification. The allocation helper, Drizzle schema and all production financial services remain unchanged from B1. Ignored logs/cache helpers are not deliverables. The disposable cluster was stopped after verification, with all test history retained; no production database, provider or broker boundary was exercised. No commit or push was performed.

All four review findings are resolved within the tested dormant foundation, which is ready for human review and B2 preparation. This is no claim of integrated financial admission, pooled payout quarantine or F01 closure. B2 still requires its separately authorized run and a coordinated cutover of all affected writers; the original independent REQUEST CHANGES review remains part of this record.

## Remaining work and limits

**B2:** snapshot new-capture eligibility/terms atomically; create lots with capture journals; freeze refund allocations on acceptance; integrate confirmed refund/failure and dispute open/adjust/close transactions; recompute settlement completion and expose compatible estimated/final API fields; implement zero effects, exception/inbox routing and scoped cutover/admission safeguards. Reinspect live inventory, in-flight provider commands, pending refunds/disputes/batches and all writers before activation; unknown legacy eligibility or unreconciled history must refuse it. Do not infer cutover readiness from a clean B1 migration or backfilled original.

**B3:** full Run A arithmetic/regression matrix, controlled multi-capture ordering, stale generation, refund/dispute/settlement/exception schedules, duplicate/reordered provider evidence, rollback/crash/retry, funding reductions, signed debt, cutover races and common admission-lock review. Two capacity schedules and one exception schedule do not prove all races. Hosted PostgreSQL17/Node22 CI, large migration timing and external provider/broker behavior are not run here.

No F01 closure, strict pending liability reservations, production settlement/bank payout, historical repair, system-wide money conversion, F04 resolution, Stripe/RabbitMQ feature change, deployment or push. B1/B1.1 is finalized for the owner-authorized local commit `feat(accounting): add capture allocation foundation`. Preserve migration 0004 in subsequent work and use reviewed forward migrations for B2 schema changes. B2 requires a separate authorized run.
