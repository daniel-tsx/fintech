# H1 Fix 02 B3.1: integrated financial correctness verification

Status: verification completed; awaiting human review. Date: 2026-10-10. Owner: B3.1 evidence and cutover prerequisites. Verdict: **READY_FOR_B3_2_DESIGN**. This does not authorize activation, deployment or B3.2 implementation. **F01 and F04 remain unresolved in the current runtime.**

Current behavior remains owned by [Ledger](../ledger.md), [Concurrency](../concurrency.md), [Settlement/payout](../settlement-and-payout.md), [Refunds/disputes](../refunds-and-disputes.md), [Webhooks/idempotency](../webhooks-and-idempotency.md), [Database design](../database-design.md) and [Verification](../verification.md). The [approved accounting policy](h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09) is unchanged. Read the [B1](h1-fix-02-b1-allocation-foundation.md), [capture](h1-fix-02-b2-1-capture-integration.md), [refund](h1-fix-02-b2-2-refund-integration.md), [dispute](h1-fix-02-b2-3-dispute-integration.md) and [settlement](h1-fix-02-b2-4-settlement-integration.md) records for checkpoint implementation/review history.

## 1. Starting Git baseline

Clean `main`, HEAD `a9321d837f3cebd4594e67f27558218817159a46`, accepted allocation-aware settlement checkpoint; `origin/main` matched. No unexplained financial changes were present. Read repository instructions/routing, current owners, all Fix 02 records and actual financial, webhook, outbox, provider bookkeeping, reconciliation, SQL and PostgreSQL test paths.

Deliverables are one [permanent integrated suite](../../apps/api/test/integration/integrated-accounting-verification.spec.ts), this record and small routing/evidence updates. No production source, package, migration, schema, accepted accounting policy or existing assertion was changed. No commit/push. Ignored `.tmp` setup, logs, caches and previous reviewer scripts are not deliverables.

Local execution used Node24.19.0, pnpm10.26.0 and PostgreSQL18.6, disposable database `fintech_h1_b31_1791633607636` on 127.0.0.1:55432. The unchanged Drizzle migrator installed **0000–0005**; migration fixtures created additional retained local databases. No database was reset. Scope CHECK still permits only FOUNDATION_ONLY/REVIEW_REQUIRED; final tests assert six installed migrations and zero ACTIVE scopes.

Final localhost catalog inspection confirmed six migrations, 339 FOUNDATION_ONLY and 77 REVIEW_REQUIRED scopes, zero ACTIVE scopes and zero POSTED journals failing the aggregate balance/minimum-entry/single-currency check. This is structural evidence, not a claim that balanced legacy journals have correct account attribution; the six F01 failures below remain real.

## 2. Current runtime versus dormant architecture

| Operation | Actual runtime and source of truth | B3.1 execution boundary |
| --- | --- | --- |
| Capture acceptance/success | [PaymentsService.capture](../../apps/api/src/payments/payments.service.ts) and [WebhookBusinessService.captureSucceeded](../../apps/api/src/webhooks/webhook-business.service.ts); original POSTED journal, attempt/payment and journal-backed NEW_CAPTURE lot commit together | All new lifecycle captures execute both services, actual LedgerService, lot/evidence triggers and audit. Authorization state/provider confirmation are explicit fixtures |
| Refund | Runtime still uses [RefundsService](../../apps/api/src/refunds/refunds.service.ts); its pooled pending debit/payment-level settlement inference do not consume allocations | [CaptureRefundAccountingService](../../apps/api/src/refunds/capture-refund-accounting.service.ts) executes directly under test-only dormant admission |
| Dispute | Runtime still uses [DisputesService](../../apps/api/src/disputes/disputes.service.ts), original source account and gross hold semantics | [CaptureDisputeAccountingService](../../apps/api/src/disputes/capture-dispute-accounting.service.ts) and shared hold reductions execute directly under the same test gate |
| Settlement | Runtime routes/jobs still use [SettlementsService](../../apps/api/src/settlements/settlements.service.ts), original G/N and attempt/current merchant delay | [CaptureSettlementAccountingService](../../apps/api/src/settlements/capture-settlement-accounting.service.ts) generates/completes actual batches under the test gate |
| Payout | Current [PayoutsService](../../apps/api/src/payouts/payouts.service.ts) reserves pooled available under advisory lock; internal completion credits lab cash | Both methods execute, including one actual [internal outbox worker](../../apps/api/src/outbox/internal-outbox-processor.service.ts) retry. No bank transfer |
| Receipt/claim/dispatch | [Receiver](../../apps/api/src/webhooks/webhook-receiver.service.ts) saves signed normalized evidence; [processor](../../apps/api/src/webhooks/webhook-processor.service.ts) still calls legacy refund/dispute handlers | New suite explicitly supplies normalized evidence and reproduces capture's inbox/business transaction boundary. Existing capture suite runs signed local Stripe fixtures through actual receiver/processor. New-policy signed dispatch is absent |
| Provider commands/outbox | PostgreSQL intent/outbox, RabbitMQ relay/consumer, Stripe provider port; durable local effects are PostgreSQL-owned | Inspected actual implementations, existing unit mocks and capture unknown-outcome regression. No live publisher, consumer or provider call |
| Reconciliation | [ReconciliationService](../../apps/api/src/reconciliation/reconciliation.service.ts) compares referenced PaymentIntents and records reviewed issues | Source inspection and existing mocked unit checks. It does not reconcile capture allocations, exceptions, historical accounting or pooled cash |

The PostgreSQL ledger owns financial movements; immutable lots/allocations/items identify their attribution and finalized evidence. Payment workflow and provider mirrors are separate. Queue IDs, ACKs, broker confirms and Redis locks are not financial uniqueness authorities. Test subclasses override only `assertActiveScope`; no production switch, ACTIVE scope or functioning cutover is supplied.

## 3. Financial invariant inventory

Abbreviations: **A** application, **D** database constraint/trigger, **L** transaction locking, **U** durable unique/idempotency key, **T** executed regression, **P** externally supplied provider assumption. SQL enforcement is in [0004](../../apps/api/drizzle/0004_capture_accounting_foundation.sql) plus [F02 sealing](h1-fix-01-posted-ledger-immutability.md). It exceeds the descriptive Drizzle schema.

| Invariant | Enforcing layers and verification | Limit |
| --- | --- | --- |
| One lot per newly confirmed capture; original G/F/N, ownership and journal time agree | A capture inventory INSERT; D canonical evidence/composite FKs; U attempt/journal lot uniqueness and journal business key; L scope/payment/attempt; T capture 27 + all new lifecycles | Historical successful-attempt early return does not certify/create trustworthy missing lots |
| Failed/unknown capture invents no money; replay cannot double-post | A confirmed event branch/success guard; U journal/lot keys; L competing payment writers; T capture suite unknown/failure/duplicate/rollback + new R04 | P verified provider outcome/identity; stale failure workflow remains F05-related work |
| Frozen FIFO refund principal and exact cumulative fee reversal | A BigInt chronological FIFO and cumulative floor per lot; D frozen fields/capacity/fee division/effect checks; L parents/lots; U refund/lot pair; T foundation/refund + L07/L08/R02/C04 | Financial history must be verified; integer allocation does not cure general Number API/payout limits |
| Capacity cannot be consumed twice; unknown reserves, confirmed failure releases | D R + reservations + active/planned disputes + lost principal bounds; L lot revision/parent locks; A explicit outcome handling; T refund/foundation + R03/C04 | Approved Option A reserves gross capacity, not immediately available funds |
| Confirmed refund applies once with correct PSP/CASH and PENDING/AVAILABLE sources | A current lot state/entitlement; D finalized allocation journal/owner/amount/effect; U journal key; L common scope; T refund + L02/L06/L08/R01/R04/R05 | New dispatcher must preserve disposition and provider evidence before mirror synchronization |
| Gross dispute exposure differs from funded hold; hold ≤ surviving entitlement | A funding formula; D principal/hold/current entitlement bounds; L lots/parents; T dispute + L04/L05/L09/L10/L17/L19/C03 | Untrusted overlap is retained as exception, not inferred net loss |
| Win restores current liability; loss reduces correct asset and explains unfunded debt | A lot settlement state, main journal and reductions; D attributed journal/effect checks; U close/effect keys; T dispute + L04/L05/L10/L13/L17/L18 | Provider close identity/outcome is P; no bank/cash sufficiency promise |
| Hold adjustments are append-only, referenced and not duplicated | D immutable adjustment evidence, unique journal and allocation/effect key; A cause ordering; L parent/lot serialization; T C03/L19 and dispute suite | Correct account meaning/order still requires participating writers |
| Candidate estimates are not final financial authority | A completion rereads after locks; D selected/applied revision and original/candidate evidence; L batch/all member rows; T settlement + L11/L12 | Pending candidates need explicit recovery/refusal at cutover |
| Independent asset transfer/release; held claims stay restricted; zero effect valid | A A/E/H formulas; D item/batch sums, journal evidence and zero reference rules; T settlement + L03–L19 | Completion rejects unrepresentable combined Number totals rather than fabricating a journal |
| Journal/item/lot/batch/audit finality and replay coherence | D posted/finalized protections, matching item/lot references; U business journal; A saved-snapshot replay; L header/members; T F02/settlement + R01/R04/L19 | Later allocations legitimately differ from saved finalization revision; replay validates history, not recalculated current economics |
| Payout uses posted available for its own merchant/currency, avoids concurrent over-reservation and refuses debt | A posted balance read; L common advisory for payout and dormant refund/dispute; U request replay/business journals; T financial concurrency + C01/C02/L06/L15/L16 | Balance conversion is Number. Live legacy refund/dispute writers lack common advisory; F04 remains open |
| Exceptions block new-policy settlement, preserve evidence and do not claim financial application | D exception lifecycle/evidence and finalization check; A history/admission refusal; T foundation/refund/dispute/settlement + R05/A02 | Current payout has no exception/scope gate; REVIEW_REQUIRED is not quarantine |

Application conventions remain necessary: full handler transaction boundaries, correct account-code/type selection, common advisory participation/canonical scope, provider correlation, sorted cross-table acquisition and honoring returned disposition. SQL does not force every legacy writer or receipt path to join that protocol. General account metadata protection, payout Number precision and end-to-end provider certainty are outside this checkpoint.

## 4. Full lifecycle regression matrix

The permanent suite has **44 cases**: 23 lifecycle cases, 10 concurrency cases, 9 recovery/replay cases and 2 explicit admission-gap observations. All sixteen requested lifecycle families execute actual capture accounting, actual dormant financial writers and current payouts where relevant. Tests use constant minor-unit oracles, never the production allocation calculation for expected values.

| Requested family | Permanent cases | Durable/account proof |
| --- | --- | --- |
| 1 capture/settle/payout | L01 | One original lot; final A/release, completed clearing/cash |
| 2 partial refund/settle/payout | L02 | Confirmed allocation/fee/refund journal; surviving asset |
| 3 full refund/zero | L03 | ZERO_EFFECT and no settlement journal |
| 4–5 dispute/settle/win or loss | L04/L05 | Funded hold, current available/cash destination |
| 6 settled refund/debt | L06 | Payout preceding confirmation; signed debt and refused next payout |
| 7 multiple partial refunds | L07 | G=101/F=3, refunds 33/33/35, independent fees 0/1/2 |
| 8 multiple captures/FIFO/mixed settlement | L08 | Actual API second capture; exact 4000/120 and 1000/30 frozen attribution; saved first item unchanged |
| 9 multiple disputes/reductions | L09/L19/C03 | Both hold-loss orders, unique immutable -300/-180 effects where required |
| 10 valid refund/dispute orders | L10 both orders | Disjoint gross, adjustment only when prior funding requires it |
| 11–12 generate/adjustments/complete | L11/L12 | Estimates cannot release held entitlement; current completion evidence |
| 13 complete/close/payout | L13 | Only surviving 4700 available is paid |
| 14 multiple payments/shared scope | L14/C01/C02 | Per-lot own pending claim and pooled advisory admission |
| 15 merchants/shared platform accounts | L15/C05 | Separate merchant liability, one platform cash account; real unique-index wait |
| 16 merchant/multiple currencies | L16/C06 | USD debt cannot consume EUR liability; EUR commits independently |
| Additional prior reviewer scenarios | L17 four orders, L18, L09/L19 | Mixed-lot 5000 dispute, zero assets with retained-fee debt, both hold losses |

Every account oracle also checks account owner/currency, original canonical journal/lot G/F/N/time/eligibility, cumulative confirmed fee evidence, confirmed refund journal identity, final lot/item reference, batch/item final sums and exactly one completion audit. More detailed negative ownership, frozen-delay and snapshot/immutability assertions remain in the executed baseline suites. The new suite does not replace them.

## 5. Account-level financial results

Balances below are debit-normal for assets/expenses and credit-normal for liabilities/revenue. `PSP`, `Cash`, `Pending`, `Available`, `Payout`, `Hold`, `Fee`, `Fee returned` cover all eight account codes. Platform contributions are filtered by **journal merchant and currency**; actual platform accounts remain shared. Expected amounts are independent constants. Negative cash/available expresses lab debt, not an external overdraft instruction.

| End state | PSP | Cash | Pending | Available | Payout | Hold | Fee | Fee returned |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| L01 paid 9700 | 0 | 300 | 0 | 0 | 0 | 0 | 300 | 0 |
| L02 refund 5000, pay 4850 | 0 | 150 | 0 | 0 | 0 | 0 | 300 | 150 |
| L03 fully refunded | 0 | 0 | 0 | 0 | 0 | 0 | 300 | 300 |
| L04 win after settlement | 0 | 10000 | 0 | 9700 | 0 | 0 | 300 | 0 |
| L05 loss after settlement | 0 | 5000 | 0 | 4700 | 0 | 0 | 300 | 0 |
| L06 payout then refund | 0 | -4700 | 0 | -4850 | 0 | 0 | 300 | 150 |
| L07 tiny full refund | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 3 |
| L08 mixed FIFO refund | 0 | 5000 | 0 | 4850 | 0 | 0 | 300 | 150 |
| L09/L19 one loss, remaining win | 0 | 5000 | 0 | 4700 | 0 | 0 | 300 | 0 |
| L10 disjoint refund/loss | 0 | 0 | 0 | -180 | 0 | 0 | 300 | 120 |
| L11/L12 remaining hold | 0 | 6000 | 0 | 0 | 0 | 5820 | 300 | 120 |
| L13 loss then payout | 0 | 300 | 0 | 0 | 0 | 0 | 300 | 0 |
| L14 two payments after payout | 0 | 450 | 0 | 0 | 0 | 0 | 600 | 150 |
| L17 mixed capture win / loss | 0 | 10000 / 5000 | 0 | 9700 / 4700 | 0 | 0 | 300 | 0 |
| L18 loss + remaining refund | 0 | 0 | 0 | -150 | 0 | 0 | 300 | 150 |

L15/L16 separately assert the L06 debtor tuple and the L01 tuple for the other merchant/currency. They also prove that the debtor's next payout is refused and another merchant's legitimate liability remains spendable.

With per-lot original G/F/N, confirmed refund R and fee Q, closed loss L and current funded hold H: surviving asset is G−R−L; entitlement is N−(R−Q)−L; release is max(entitlement−H,0). H is restricted independently of asset transfer. These formulas explain L10/L18's retained-fee debt and the independent finalization legs. No current merchant fee/delay is substituted for frozen original evidence.

## 6. Cross-writer lock graph

All financial tests use actual READ COMMITTED transactions. A fresh statement reads current evidence after waiting. Operation-private inbox/idempotency locks may precede the financial protocol; no network call runs under financial locks.

| Writer | Actual acquisition/effect order |
| --- | --- |
| Capture success/replay | Private inbox if processed → unlocked correlation → canonical merchant/currency advisory → scope → provider mirror → payment NO KEY UPDATE → specific CAPTURE attempt UPDATE → new journal/accounts/entries → new private lot → audit/disposition |
| Dormant refund reservation | Private API idempotency → advisory/scope → payment NO KEY UPDATE → all CAPTURE attempts by ID → refunds by ID → disputes by ID → lots by attempt ID → dispute allocations by lot/ID → refund allocations by lot/ID → private refund/allocations/outbox/audit |
| Dormant refund success/failure | Own inbox UPDATE → same scope/member order → read-only provider evidence → ordered hold reductions → new refund journal when successful → terminal allocations/workflow/audit/disposition |
| Dormant dispute open/close | Own inbox UPDATE → same scope/member order → correlated evidence → reductions/main journals → immutable attributed effects/workflow/audit/disposition |
| Settlement generation | Discovery without locks → advisory/scope → ALL payment parents in ID order → ordered children/lots/allocations → fresh financial/prerequisite reads → new private header/items/audit |
| Settlement completion/replay | Discovery → advisory/scope → shared header UPDATE → ALL payment parents/children/lots/allocations → item locks/fresh reads → journal/finality/audit; no shared header acquired after lots |
| Payout reservation | Private idempotency → common advisory → posted available read → private payout/new journal/outbox/audit. No payment/lot acquisition |
| Payout completion | Payout UPDATE → private completion journal/accounts. No later advisory/payment/lot lock |
| Exception insertion | Current dormant writer already holds scope; BEFORE trigger updates scope REVIEW_REQUIRED; deferred settlement check revisits same scope parent |

Implicit edges are included: journal business unique index; platform/merchant account functional uniqueness; INSERT/ON CONFLICT account waits; FK KEY SHARE on unchanged financial parents; F02 same-value parent UPDATE for entry insertion; allocation BEFORE triggers revisit refund/dispute parents and increment lot revision; item writes revisit batch parent; deferred balance/capacity/effect/finality checks run before commit. Prelocked parents/lots/headers make trigger revisits follow the same protocol. LedgerService resolves accounts in input-line order; dormant main journals sort codes, while capture and hold adjustments retain their explicit orders. This is not a global database-enforced account-order contract for arbitrary writers.

Capture payment NO KEY UPDATE conflicts with other payment writers while permitting settlement-item payment FK KEY SHARE. Both controlled capture/legacy-generation schedules reran in the 27-case suite without the old 40P01 cycle. Authorization success still locks AUTHORIZE child before payment; capture targets a distinct CAPTURE child. Non-capture callbacks, API payment intents, command bookkeeping and current legacy writers have not adopted the full protocol.

**Mixed deployment remains prohibited.** Dormant payment→refund can invert legacy refund→payment; dormant payment→dispute can invert legacy close's dispute→journal→payment. A scope advisory added after a provider mirror/shared child write can introduce mirror/child→advisory reverse dependencies. Old settlement generation/completion and payout admission must be considered together at cutover. Production account semantics, broad historical multi-scope writers, READ REPEATABLE/serializable execution and every callback permutation are not proven by this lock graph.

## 7. Controlled concurrency evidence

The new C01–C05 harness gates the **first actual service transaction after its work but before commit**, records both backend PIDs, starts the second service and observes `firstPid = ANY(pg_blocking_pids(secondPid))`. Both results are awaited and errors fail the test unless the specified payout denial is expected. Gates/timeouts are released in finally. No deadlock retry conceals an aborted transaction. C06 uses a held USD transaction and proves EUR completion commits before its release.

| Schedule | Evidence executed during B3.1 |
| --- | --- |
| Different-payment refund success ↔ pooled payout | C01 both orders; refund-first leaves available 14550 and rejects 15000; payout-first reserves 15000 then leaves available -450. Pending refund Option A remains unchanged |
| Different-payment dispute open ↔ pooled payout | C02 both orders; hold-first leaves available 14400 and rejects 15000; payout-first leaves -600 available, 15000 reserved and 5000 held |
| Refund success ↔ settlement completion | Existing B2.4 both orders rerun; final accounts converge, saved finalization amounts describe the actual first operation |
| Dispute close ↔ completion | Existing B2.4 executes both orders for win and loss, four schedules |
| Concurrent refunds sharing lot | New C04 both orders on G101/F3; frozen capacity and cumulative fees telescope to exactly 3 |
| Concurrent hold reductions | C03 refund/loss both orders on one lot; one referenced -180 reduction and remaining claim 2820 |
| Completion ↔ exception creation | Existing B2.4 both orders rerun; prior exception refuses finality, later exception does not rewrite finalized history |
| Capture replay ↔ generation | Existing B2.4 both orders and both original legacy FK schedules rerun |
| Different scopes/shared platform accounts | C05 proves real new PLATFORM_CASH account uniqueness blocking and two complete committed batches. Swapping identical completion operations is symmetric; other mixed platform-writer orders remain unverified |
| Different currencies | C06 proves independent USD/EUR completion, separate account identities and balances |

The 73-case settlement baseline contains 20 concurrency cases executing **22 controlled schedules**, not 22 different invariants: close/complete performs both internal orders in each outcome case; duplicate generation/completion order labels are symmetric. New B3.1 adds ten schedules, nine observed blocking and one demonstrated independent commit. Thus **32 settlement/B3.1 schedules** reran, plus existing capture/refund/dispute/foundation/concurrency schedules counted only within their owning suites. No universal deadlock-freedom claim, no F04 closure and no production mixed-dispatch verification.

## 8. Failure and replay verification

| Boundary | Executed evidence and transaction result |
| --- | --- |
| After journal insertion | New R01 throws after actual refund LedgerService.post; payment/lot/allocations/journal/entries/audit unchanged; original inbox remains IGNORED fixture; whole operation retries once successfully |
| After allocation writes | R01 audit fault after refund allocation/workflow writes produces same rollback. Existing capture/settlement fault regressions also reran |
| Deferred commit validation | R01 adds an ordinary unbalanced POSTED test journal in the same transaction after successful refund work; commit-time F02 validation aborts all refund effects. Existing allocation/finality deferred tests reran |
| Duplicate confirmed events | R04 capture success after refund/settlement, refund replay and settlement response-loss replay preserve complete financial snapshot; existing concurrent duplicate cases reran |
| Contradictory success/failure | R05 retains successful refund/confirmed financial journal and creates OPEN exception/ACCOUNTING_EXCEPTION on later failure; no compensating outcome is invented |
| Dispute close before open | R06 original trusted close retries with no financial effect, then applies after actual open. B2.3.1 pending-capture prerequisite cases reran |
| Unknown provider outcome | R03 has only accepted intent: full reservation, no refund journal, no speculative success. Existing actual command-handler capture test uses UnknownProviderOutcomeError and creates no lot |
| Accepted refund then later capture | R02 uses actual second capture and preserves the first lot's frozen 2000 gross/60 fee attribution |
| Exception with rejected effect | A02 mismatch retains original inbox, OPEN exception and RESERVED refund evidence, with no confirmed refund financial effect; R05 retains success rather than reversing it |
| Settlement response lost | R04 invokes completion again after committed success; same journals, lot/item/history and one audit |
| Worker disappears after payout commit | R07 retains stale PROCESSING internal outbox, executes actual drain/claim/replay, marks PUBLISHED and retains exactly one PAYOUT_COMPLETION journal. Test positions its own work first and drains one item, avoiding fixture-order dependence |

Receipt is its own durable commit; inbox claim is another; mirror/business/financial/evidence/audit/disposition commit together in processing; failure bookkeeping follows separately. Provider command execution calls the network before its mirror transaction. RabbitMQ publication and outbox PUBLISHED bookkeeping are separate; broker ACK follows handler bookkeeping. None is a distributed transaction with Stripe. Original keys/evidence must survive these gaps. Actual broker reconnection/ACK loss, process termination and live provider uncertainty were not exercised; R07 deterministically constructs the durable crash boundary, not a killed operating-system process.

## 9. Provider/inbox exception limitations

[CaptureSettlementAccountingService.checkInboxPrerequisites](../../apps/api/src/settlements/capture-settlement-accounting.service.ts) currently makes a plain READ COMMITTED query for correlated STRIPE refund-success/dispute-open/close evidence in PENDING/PROCESSING/RETRY/DEAD. It rejects known unapplied evidence; it does not synchronize receipt or resolve unknown references. OPEN exceptions independently block completion. Completed replay validates saved final evidence even if later evidence now requires review.

| Evidence state | Current behavior / required activation treatment |
| --- | --- |
| PENDING / PROCESSING / RETRY / DEAD, correlated financial confirmation | Query blocks participating settlement when visible. DEAD is not proof of no provider effect; reconcile/replay or refuse admission |
| ACCOUNTING_EXCEPTION | Not claimed by legacy processor; OPEN financial exception blocks new-policy settlement. Preserve resolution lifecycle, never acknowledge it as financially applied |
| Uncorrelated/missing payment/provider reference | The correlated settlement query cannot reliably locate the affected scope. Resolve from trusted provider references or conservatively refuse applicable activation/admission; do not silently ignore |
| Late receipt | A01 gates real completion after all financial writes, inserts confirmed PENDING refund evidence in a separate transaction and commits both. Observed batch final A=10000/release=9700 while refund remains RESERVED and inbox PENDING; later application yields cash5000/available4850 |
| Stale worker | Processor compares payload ID, not lease owner/generation/status; its separate failure UPDATE is not claim-fenced. Current unconditional PROCESSED assignment also cannot honor a new service's ACCOUNTING_EXCEPTION return. These are inspected coordination dependencies, not a reproduced new incorrect financial journal |
| Unresolved candidate | Immutable selected estimate cannot authorize inconsistent history. Keep/refuse candidate until audited reconciliation; unsafe Number totals abort completion unchanged rather than finalize |

Categories: **A** is confirmed incorrect financial application (the six legacy F01 results, section 12). **B** is incomplete provider evidence: missing identity, unknown outcomes, contradictory/overlapping confirmations or unfinished historical reconciliation. **C** is missing runtime coordination: A01 late receipt, A02 payout admission, old dispatcher/disposition/lease behavior. A01 establishes an incomplete financial view at commit, not a claim that its internally posted settlement was unbalanced or that every later refund must have been known earlier.

Minimum atomic admission contract for B3.2 design:

1. Define a linearization/cutoff rule for receipt versus financial admission. Durable correlated receipt/admission markers and participating financial checks must serialize on the canonical merchant/currency admission authority (or a reviewed equivalent epoch protocol). A plain event query after acquiring advisory is insufficient when receipt ignores it.
2. Validate/recheck trusted event ownership/correlation and original verified evidence; handle unknown scope explicitly. Keep network identity resolution outside financial locks; do not invent a provider outcome.
3. Scope transition, generation, completion and payout reservation must recheck blocking evidence under the same admission boundary. Preserve Option A: unknown pending refund intent alone is not a newly invented payout hold, but confirmed/unresolved financial evidence needs a defined admission rule.
4. Workers must fence claim ownership/retry disposition, dispatch only to the scoped participating writer and preserve ACCOUNTING_EXCEPTION. Do not lock shared inbox rows after scope while another worker holds inbox then waits for scope; use a consistent private-inbox protocol/admission marker.
5. Drain/fence old binaries, in-flight legacy writers, stale claims and candidates before enabling any scope; refusal must be durable and reviewable. A schema enum addition or FOUNDATION_ONLY→ACTIVE edit cannot supply these guarantees.

## 10. Legacy reconciliation inventory

Migration 0004's live inventory and migration tests distinguish clean original, adjusted, settled, invalid and orphan evidence. Later legacy writers can introduce additional divergence after the migration. B3.1 did not scan or repair production history; below is the code-derived inventory that a future operator must evaluate against actual scoped records.

| State | Evidence-based treatment before activation |
| --- | --- |
| Clean historical original / LEGACY_ORIGINAL_ONLY, eligible_at NULL | Verify attempt/journal owner/GFN/time; establish historical eligibility from trustworthy terms. Null eligibility/current terms cannot activate it automatically |
| Historical success without lot / capture skipped by older binary | Reconcile immutable original and every subsequent effect; current successful-attempt replay returns early, so it does not certify missing lot evidence |
| NEW_CAPTURE lot followed by live legacy refund/dispute | Origin does not certify complete new-policy attribution. Reconcile immutable journal, legacy parent history and pooled balance; no automatic allocation fabrication |
| Pending legacy settlement item, capture_lot_id NULL/policy NULL | Drain/fence legacy completion; refuse new candidate ownership; explicit reviewed treatment, never change immutable originals to make it look new-policy |
| Completed legacy settlement | Verify its actual historical journal and per-capture effects; keep history; compensating journal only if audited accounting is wrong |
| Legacy refund / dispute without allocations | Recover verified original intent/provider confirmation and source effects. Manual review where FIFO/net outcome cannot be proven |
| Orphan CAPTURE journal / invalid ownership or original lines | Migration refuses unscopable orphan; invalid scoped evidence becomes review/exception. Refuse activation; resolve identity from verified evidence, never destructive journal rewrite |
| Known misposted legacy F01 journals | Reconcile whole financial effect and pooled liability/cash, append approved compensating journals. Marking an issue RESOLVED does not financially repair it |
| OPEN exception / unknown provider outcome / overlapping financial evidence | Preserve all event/journal/provider references and capacity. Manual review/reconciliation, then separately verified financial resolution; no note-only financial clearance |
| Pending provider command / inbox RETRY/PROCESSING/DEAD / stale worker | Preserve original idempotency keys; drain/fence and define replay owner. DEAD and queue ACK do not prove a cancelled financial outcome |
| Dormant finalized new-policy lot/item/batch alongside legacy writers | Validate saved journal/items plus every subsequent effect; prevent old writer from mutating workflow without allocation evidence. Dormant test success is not a deployment classification |
| Negative debt / pooled payout reservation/completion | Reconcile merchant/currency liabilities and platform assets, explain debt and outstanding reservations; no assumption of payoutable balance from a lot/scope flag |

Current reconciliation compares referenced PaymentIntent status/amount/currency; its resolution method writes a note/status/audit. It is not an allocation replay, exception financial resolver or compensating-journal workflow. B3.2 must specify these requirements before cutover tooling, not silently reuse the existing note as clearance.

## 11. Test coverage gaps

| Coverage | Executed evidence | Remaining limit |
| --- | --- | --- |
| Complete small-amount capture-owned lifecycle | New 44, actual capture API/business and all dormant services | Authorization/provider confirmations are fixtures; no activated dispatcher |
| Ownership/fee/capacity/finalized evidence negatives | 30 foundation + 63 refund + 70 dispute + 73 settlement | Many use synthetic capture fixtures; SQL enforcement is real, not full upstream workflow |
| Actual capture, signed receipt and duplicate processor | Existing 27 capture | Signed new-policy refund/dispute dispatch remains absent |
| Migration/legacy refusal and preserved history | Existing 5 migration cases; fresh 0000–0005 installation | No real production history inventory, migration-duration/large-volume benchmark or PG17 execution |
| Journal immutability and competing database writes | Existing 17 F02 + 5 financial concurrency | Account metadata semantics and arbitrary external SQL writer lock orders remain outside the proven schedules |
| Cross-writer orders | Existing 22 settlement + new 10 schedules and adjacent suites | All platform-account writer combinations, callback/mixed deployment permutations, hash collisions and high isolation not universally proven |
| Reviewer scenarios | Seven old ignored cases rerun; equivalent flows now permanent L09/L17/L18/L19 with actual capture | Old script remains ignored and is not a reusable CI artifact |
| Crash/ACK recovery | R01/R04/R07 and provider/relay/consumer unit mocks | No killed process, real broker/Redis, Stripe network, hosted CI or full receipt/stale-worker scheduler test |
| Full monetary range | Existing exact BigInt capacity/fees and settlement Number rejection boundary | General API/ledger balance Number conversion and candidate recovery are unresolved F03/range work |

No skipped test hides F01: default `pnpm test` deliberately leaves database opt-ins off; the green suites and six red cases were executed separately. New tests snapshot financial evidence and inspect all accounts rather than asserting only journal balance. New admission-gap cases are explicitly observations of missing guarantees, not passing acceptance assertions for safe activation.

## 12. Concrete findings with severity

No new incorrect dormant-service financial application or reproduced dormant deadlock was found in the executed cases. No production fix was made. The following confirmed gaps remain required design inputs.

| Finding | Evidence / failure mechanism | Smallest credible next work and blocking boundary |
| --- | --- | --- |
| **B31-C01, high activation risk: receipt not serialized with settlement admission** | Permanent A01; settlement `checkInboxPrerequisites` at line 218, receiver INSERT at line 31. Both committed: full settlement with newly durable unapplied confirmed refund. Ledger and allocations remain internally coherent; provider view is incomplete (C/B) | Separate B3.2 admission design, scoped receipt/marker or reviewed cutoff protocol plus both receipt/claim schedules. Blocks activation, does not block defining that design |
| **B31-C02, high activation risk: unresolved exception does not quarantine pooled payout** | Permanent A02; mismatch leaves OPEN exception/RESERVED allocation/ACCOUNTING_EXCEPTION, while `PayoutsService.request` lines 17–30 still pays 9700. This is documented current behavior (C), not a new-policy success | Design consistent financial admission for pooled scope/payout, preserving Option A and explicit exception resolution. Blocks activation; do not claim REVIEW_REQUIRED means quarantine |
| **Existing F01, high: current legacy settlement misposts after adjustments** | All six unchanged regressions ran and failed. Mixed-lot case expects PSP5000/Cash0/Pending4850/Available0 after refund but observes PSP6000/Cash-1000/Pending970/Available3880 | Reviewed cutover plus evidence-based compensating treatment of any affected historical journals. Blocks F01 closure/runtime correctness claims; dormant integrated tests do not fix live dispatch |
| **Existing range limitation, medium liveness / later readiness** | Executed settlement suite creates MAX_SAFE_INTEGER fee0 candidate; completion rejects combined A+release with LEDGER_AMOUNT_UNREPRESENTABLE, preserves pending evidence. Captures are safe individually; no false finality occurs | Specify admitted aggregate limit and durable candidate refusal/recovery or separately reviewed exact-ledger change. No silent Number precision fix/policy broadening in B3.1 |

Source inspection additionally identifies unfenced stale-worker failure bookkeeping and unconditional processor disposition, the successful historical capture early return, legacy reverse lock edges and incomplete reconciliation. These are precise B3.2/other-audit dependencies, not newly reproduced incorrect journals. They must be tested during their corrective integration run. Do not infer that 334 green cases resolve them.

## 13. Remaining F01/F04 risks

F01 is unresolved because live refund/dispute/settlement writers are legacy, six financial assertions remain red and no scope can be ACTIVE. F04 is unresolved because only current payouts and test-admitted dormant writers share the advisory boundary; legacy confirmed refund/dispute callbacks do not. C01/C02 prove participating-writer serialization at payout admission, not prevention of all later debt. Option A explicitly permits later confirmed effects after a payout, so debt by itself is not a new failure of the approved model.

F03 monetary boundaries, F05 non-monotone old callbacks and F06 out-of-order runtime orchestration remain separate audit work. B3.1 did not broaden their implementation. No production-readiness, compliance, bank liquidity or external settlement claim is supported.

## 14. B3.2 cutover prerequisites

1. Design the atomic admission/cutoff, receipt correlation, pending/DEAD/exception handling, payout participation and fenced worker disposition contract in section 9; review the permitted debt behavior explicitly.
2. Specify writer capability/routing and legacy drain/fencing. Preserve the common scope/payment/child/lot/header protocol; identity validation must precede mutable provider mirror evidence. No partial mixed registration.
3. Define scoped legacy reconciliation, original eligibility evidence, pooled balance/settlement/payout reconciliation and manual/compensating treatment. No fabricated backfill and no activation from a resolution note.
4. Define pending candidate/range recovery and replay ownership, exception review versus financial resolution, rollback/old-binary refusal and observability of blocked scopes.
5. Add real dispatcher/receipt/claim/retry and both admission-race schedules, then run all existing/new regressions; obtain PG17/hosted evidence and later operational/provider verification. Only a reviewed forward migration and explicit guarded scope transition may enable ACTIVE after these prerequisites.

Proceeding to **B3.2 design** is justified by the verified dormant accounting flows and explicit gaps. Implementation/activation requires a separate authorized run; significant policy or production changes must receive their own review.

## 15. Exact verification commands and results

All results below were executed during B3.1; previous checkpoint results are context, not substituted reruns. Working-directory commands are repository root; pnpm forwards the named paths relative to `apps/api`. PG commands used RUN_DB_TESTS=1, and migration commands also RUN_MIGRATION_TESTS=1 with local MIGRATION_ADMIN_URL. Database URL pointed only to the disposable database above. RUN_F01_PENDING=1 was set only for the separate red command.

| Exact command | Result |
| --- | --- |
| `node .tmp/h1-b31-fresh.cjs` | Fresh disposable database, unchanged six migrations installed |
| `pnpm lint` | Final pass; initial run found three unsafe-return annotations in new test result queries, corrected with explicit types |
| `pnpm typecheck` | Passed API/web |
| `pnpm test` | Passed **50 unit cases**; **340 database cases skipped by default**, all opt-in green/red suites executed separately; web script is a notice |
| `pnpm build` | API/web passed on permitted rerun; initial sandbox failed Next output mkdir with EPERM |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/capture-accounting-integration.spec.ts test/integration/refund-accounting-integration.spec.ts test/integration/dispute-accounting-integration.spec.ts test/integration/settlement-accounting-integration.spec.ts test/integration/capture-accounting-foundation.spec.ts test/integration/capture-accounting-migration.spec.ts test/integration/posted-ledger-immutability.spec.ts test/integration/financial-concurrency.spec.ts --cacheDirectory ../../.tmp/jest-h1b31 --json --outputFile ../../.tmp/h1-b31-baseline.json` | **290 passed**, 8 suites, 0 skipped: capture27/refund63/dispute70/settlement73/foundation30/migration5/F02 17/concurrency5 |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/integrated-accounting-verification.spec.ts --cacheDirectory ../../.tmp/jest-h1b31 --json --outputFile ../../.tmp/h1-b31-integrated.json` | **44 passed**, 1 suite, 0 skipped; initial narrower suite also passed 38 before adding permanent reviewer cases/stronger evidence |
| `pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-h1b31 --json --outputFile ../../.tmp/h1-b31-f01.json` | **6 failed as expected**, exit1, 0 skipped; assertions unchanged |
| `pnpm --filter @fintech-lab/api exec tsx ../../.tmp/h1-b24-review-extra.ts` | **7 ordinary reviewer scenarios passed**, zero ACTIVE; inherited script inspected before rerun, remains ignored. Not added to permanent count |
| `node .tmp/validate-docs.cjs` | Passed: **35 Markdown files, 405 relative links/anchors**, CI YAML structure checked, 14 Mermaid blocks extracted. No Mermaid parser/render claim |
| `git diff --check` | Passed; new untracked deliverables separately checked for trailing whitespace/final newline |

Ignored evidence is `.tmp/h1-b31-baseline.{log,json}`, `integrated.{log,json}`, `f01.{log,json}`, `reviewer-seven.log`, `lint-final.log`, `typecheck-final.log`, `test-final.log`, `build-permitted.log` and `docs.log`, with the `h1-b31-` prefix on each stem. Database setup/cache/log files were not staged. Production source and migration diffs were confirmed empty against starting HEAD.

PostgreSQL17 was **not executed**: `C:/Program Files/PostgreSQL/17` has a data directory but no postgres/initdb/pg_ctl binaries. Existing CI config names postgres:17-alpine, but hosted CI was not run. PostgreSQL18.6 local tests are the executed compatibility evidence. No live Stripe/RabbitMQ/Redis, bank payout, production migration/data mutation or large-history benchmark was performed. The local cluster was stopped after verification; immutable test histories were retained.
