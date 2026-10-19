# H1 Fix 02 — B3.2 B.2-R2 Run A: independent financial application design review

Status: completed independent **design-only** review, **2026-10-19**. This report reviews the proposed contract, not an installed R2 implementation. No runtime, schema, migration, test, financial data, credential or activation change is included.

No unresolved P0/P1 contradiction was found in the declared automatic accounting boundary. Acceptance is limited to planning separately authorized, dormant checkpoints. The genuine D02 producer comes first; capture needs its own pre-lot evidence and financial application checkpoint before refunds/disputes. Implementation, operational installation and financial activation are separate gates.

## 1. Starting Git baseline

Checkout: C:\Work\Learning Projects\learn-fintech, branch main, HEAD **57867ca497606aac0d1c60fbd384c6908f3dde9c**, subject “feat(accounting): integrate isolated trusted signed receipts”. The index was empty.

Initial worktree:

- Modified docs/README.md, containing the author's one proposed-design navigation link.
- Untracked [financial application design](h1-fix-02-b3-2-b2-r2-financial-application-design.md), 377 lines, author verdict DESIGN_READY_FOR_INDEPENDENT_REVIEW.

The proposed design's starting SHA-256 was **ed2c3656c85aa1e47d187dd6ad460ee750140e8e831eecf31fbfe0c1d420a0dd**. Its clean-start statement describes the author's earlier run, not this review's already dirty starting tree. The design and initial index edit are preserved. This review adds only this report and one further index link. No fetch, staging, commit or push occurred.

Read AGENTS.md, CLAUDE.md, README, the agent reading matrix, workflow, documentation index and package scripts. Node is v24.19.0; packageManager pins pnpm10.26.0. The verification in this run is source/document inspection and documentation integrity checks. No PostgreSQL or financial suite was run, no provider was called, and no service/worker was started. Earlier accepted test results below remain inherited evidence.

## 2. Reviewed design and source inventory

The reviewed object is [R2 design §§2–15](h1-fix-02-b3-2-b2-r2-financial-application-design.md), particularly D02 §§3–4, capture §5.1, application §§5–7, locking §8, recovery/disposition §§9–10 and sequencing §11.

Decision and review inventory:

| Record | Review use |
| --- | --- |
| [Approved settlement policy §16](h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09), [B1](h1-fix-02-b1-allocation-foundation.md), [capture/B2.1](h1-fix-02-b2-1-capture-integration.md), [refund/B2.2](h1-fix-02-b2-2-refund-integration.md), [dispute/B2.3](h1-fix-02-b2-3-dispute-integration.md), [settlement/B2.4](h1-fix-02-b2-4-settlement-integration.md) | Capture-owned FIFO, fee reversal, restricted holds, asset/release separation, Option A and original corrective history |
| [B3.1 integrated verification](h1-fix-02-b3-1-integrated-verification.md), [historical H1 findings](h1-financial-correctness.md) | Actual dormant accounting evidence versus F01/F04/F05/F06 and admission gaps |
| [Runtime cutover design and §21 correction](h1-fix-02-b3-2-runtime-cutover-design.md), [original review and §14 acceptance](h1-fix-02-b3-2-design-review.md), [H01–H12](h1-fix-02-b3-2-human-decisions.md) | Authoritative approved architecture; earlier “awaiting approval” text remains historical |
| [B.1 implementation](h1-fix-02-b3-2-b1-trusted-evidence-schema.md), [B.1 review](h1-fix-02-b3-2-b1-independent-review.md) | Fixed proof1, genuine owned sources, closed financial-reference floor |
| [R0 implementation/correction](h1-fix-02-b3-2-b2-r0-admission-foundation.md), [adverse review](h1-fix-02-b3-2-b2-r0-independent-review.md), [R0.1 acceptance](h1-fix-02-b3-2-b2-r0-1-independent-review.md) | Mandatory obligations, guarded revision/transfer/resolution, contradiction precedence over pending neutrality |
| [R0.2 implementation](h1-fix-02-b3-2-b2-r0-2-conflicting-delivery.md), [review](h1-fix-02-b3-2-b2-r0-2-independent-review.md) | Independent later-delivery witnesses and exact immutable barrier sets |
| [First R1 preflight](h1-fix-02-b3-2-b2-r1-trusted-receipt.md), [post-R0 preflight](h1-fix-02-b3-2-b2-r1-implementation.md), [R1 implementation](h1-fix-02-b3-2-b2-r1-signed-receipt-integration.md), [independent acceptance](h1-fix-02-b3-2-b2-r1-independent-review.md) | Preserve stopped-run history; accepted isolated SDK/SQL integration leaves D02 and financial application unimplemented |

Current owners consulted: [architecture](../architecture.md), [ledger](../ledger.md), [database](../database-design.md), [concurrency](../concurrency.md), [payment lifecycle](../payment-lifecycle.md), [refunds/disputes](../refunds-and-disputes.md), [settlement/payout](../settlement-and-payout.md), [webhooks/idempotency](../webhooks-and-idempotency.md), [outbox/RabbitMQ](../outbox-rabbitmq.md), [Stripe](../real-psp-stripe.md), [reconciliation](../reconciliation.md), [failure recovery](../failure-recovery.md), [security](../security.md) and [verification](../verification.md).

All migrations 0000–0008 were inspected, including their executable trigger/function bodies:

| SQL | Source-supported boundary |
| --- | --- |
| [0000](../../apps/api/drizzle/0000_cheerful_sunset_bain.sql) | Journal business uniqueness, currency/balance checks, original immutability, operational tables/FKs and API/inbox identity |
| [0001](../../apps/api/drizzle/0001_lively_fabian_cortez.sql) | Stripe mirror/attempt/PI/Charge references; external object IDs may repeat across commands |
| [0002](../../apps/api/drizzle/0002_seal_posted_ledger.sql), [0003](../../apps/api/drizzle/0003_pin_ledger_function_context.sql) | DRAFT-only entry insertion with real parent UPDATE, sealed originals, TRUNCATE rejection and pinned function context |
| [0004](../../apps/api/drizzle/0004_capture_accounting_foundation.sql) | Lots, frozen allocations, whole-operation bounds, exact cumulative fee quotient, hold effects, settlement evidence and parent revision writes |
| [0005](../../apps/api/drizzle/0005_refund_accounting_exception.sql) | ACCOUNTING_EXCEPTION enum addition only |
| [0006](../../apps/api/drizzle/0006_trusted_financial_evidence.sql) | Receipt/observation/binding/proof storage, builder/reader/sealer, restricted owner, proof1 and version0/NULL closed references |
| [0007](../../apps/api/drizzle/0007_receipt_admission_foundation.sql) | Enrollment, mandatory obligation, guarded revisions/binding/review, narrow refund recognizer and diagnostic admission reader |
| [0008](../../apps/api/drizzle/0008_conflicting_receipt_deliveries.sql) | Immutable later deliveries/barriers, exact deferred set validation and reader participation; no barrier clearance |

Affected source inspected:

- [Provider port](../../apps/api/src/payment-provider/payment-provider.types.ts), [Stripe adapter](../../apps/api/src/payment-provider/stripe-payment.provider.ts), [command handler](../../apps/api/src/payment-commands/payment-command-handler.service.ts), [consumer](../../apps/api/src/payment-commands/payment-command.consumer.ts), [relay](../../apps/api/src/outbox/outbox-relay.service.ts), [RabbitMQ adapter](../../apps/api/src/rabbitmq/rabbitmq.service.ts) and [reconciliation](../../apps/api/src/reconciliation/reconciliation.service.ts).
- [Trusted receiver](../../apps/api/src/webhooks/trusted-signed-receipt.service.ts), [correlator](../../apps/api/src/webhooks/trusted-receipt-correlation.service.ts), [restricted database composition](../../apps/api/src/webhooks/trusted-receipt-database.ts), [normalizer](../../apps/api/src/webhooks/stripe-event.normalizer.ts), [business handler](../../apps/api/src/webhooks/webhook-business.service.ts) and [processor](../../apps/api/src/webhooks/webhook-processor.service.ts).
- [Capture refund writer](../../apps/api/src/refunds/capture-refund-accounting.service.ts), [dispute writer](../../apps/api/src/disputes/capture-dispute-accounting.service.ts), [settlement writer](../../apps/api/src/settlements/capture-settlement-accounting.service.ts), [FIFO/fee helper](../../apps/api/src/ledger/capture-allocation.ts), [hold helper](../../apps/api/src/ledger/dispute-hold-adjustment.ts), [ledger](../../apps/api/src/ledger/ledger.service.ts), [payouts](../../apps/api/src/payouts/payouts.service.ts) and [internal outbox](../../apps/api/src/outbox/internal-outbox-processor.service.ts).
- Existing payment/refund/dispute/settlement services, state machine, idempotency service, database schema/transaction wrapper, migration journal, runtime modules/jobs and relevant integration fixtures/regression inventory. Installed stripe-node22.6.2 RequestSender and NodeHttpClient response consumption were also inspected.

Distinguish these evidence levels:

| Claim | Assessment at this HEAD |
| --- | --- |
| R1 verifies and atomically retains signed receipts in isolated composition | Supported by source and accepted earlier HTTP/PG results; not rerun here |
| B.1/R0/R0.2 source identity, immutable proof and blockers exist | Supported by SQL; existing financial application is structurally closed |
| Existing dormant accounting implements the approved lot formulas | Supported by source and B3.1/B2 evidence; synthetic admission is not a real permit |
| Genuine D02 producer, pre-lot proof, transaction permit, canonical application and all-writer finalization guards exist | **False today; the proposal correctly labels these future work** |
| Hosted checks passed for the accepted baseline | Supplied author context; not independently fetched or rerun here |
| Future D02 transport provenance, SQL authorization and lock schedules work | Acceptance requirements/assumptions until their respective implementations are independently verified |

## 3. D02 provider observation assessment

The actual chain is API idempotency transaction → accepted attempt/refund + outbox/audit/replay → relay claim/confirm/publication mark → broker delivery → provider call outside SQL → mirror/child transaction → ACK. Neither relay PUBLISHED nor broker ACK is a monetary result. The handler currently checks parsed envelope shape, not full durable accepted-command equality before calling Stripe.

The proposed extension is coherent:

    accepted immutable command/policy/key
      → committed local execution identity
      → provider request outside locks
      → genuine response/error/unknown source envelope
      → restricted SQL publication + obligation/revision COMMIT
      → subordinate compatible mirror bookkeeping
      → broker acknowledgment
      → later real signed receipt/proof
      → admitted financial application

| Required D02 property | Design assessment and implementation gate |
| --- | --- |
| 1. Immutable observation identity | Execution, source and object-projection identities are separated. One invocation can have multiple received observations; replay of one publication compares its full fingerprint. Reinvocation retains the provider key but gets a new execution ID. |
| 2. Command/account ownership | Freeze prospective accepted fields; compare envelope/outbox/child kind/UUID/amount/currency/key before the call. Server configuration establishes account and mode. Same-PI or metadata matching cannot establish command ownership. |
| 3. Trusted provenance | Separate authenticated D02 publisher capability attests an actual API transport/query, distinct from receipt publication. SQL validates its lineage; it does not authenticate TLS or verify a webhook HMAC for an SDK response. |
| 4. Original and normalized result | Retain complete/partial/absent original response body explicitly, actual result/error, HTTP/request context and versioned interpretation. Returned requested amount and actual provider amount remain different fields. |
| 5. Object/principal/currency | A protected projection must reconcile accepted operation and actual object/PI/Charge/account/principal. Truthful contradictory bytes are retained with review, without an authoritative projection. Cumulative PI amounts require attributable capture evidence. |
| 6. Duplicate handling | Exact source replay returns the same immutable row. A changed publication cannot disappear behind ON CONFLICT or overwrite the first source. SDK internal retries also need distinguishable transport lineage in D02-A; broker invocation count is not HTTP attempt count. |
| 7. Contradictions | Terminal/owner/object/principal conflicts append independent causes and invalidate admission. Pending→terminal progression and provably superseded pending are not automatically contradictions. Historical proof stays fixed. |
| 8. Unknown recovery | Prepared means possibly sent. Timeout, incomplete body, 5xx, DLQ and “resource missing” cannot prove no effect. Preserve key/reservations; use safe same-key retry, truthful lookup or review. |
| 9. Publication authority | Separate restricted LOGIN, narrow EXECUTE, NOLOGIN owner, no ledger/proof/receipt writes or owner membership. Audit column/table/default privileges; invoke the guarded admission revision writer rather than granting direct revision UPDATE. |
| 10. Revision compatibility | Keep B.1 proof1 interpretation and frozen source IDs. Prospective source format cannot retrospectively bless old observations. D02 changes current admission revisions, not old proof meaning. |

The existing ProviderResult drops amount/currency/body/request context; storeProviderMirror copies input amount and overwrites status/raw_response. It cannot be promoted into D02. In the installed SDK, RequestSender parses via toJSON before attaching lastResponse; NodeHttpClient consumes the stream as UTF-8/JSON. Neither parsed response-event bodies nor JSON.stringify(result) restores original wire evidence. A supported bounded transport capture must be demonstrated in D02-A, including errors, truncation and SDK automatic retries. This is an explicit design stop condition, not a completed adapter.

The crash window cannot be eliminated by a local transaction. Its consequences are:

| Crash boundary | Permitted recovery |
| --- | --- |
| Before execution preparation commits | No call may have been dispatched through that new execution; retry preparation against the same accepted operation |
| Preparation committed, before/during send | Treat as possibly sent; do not infer failure from the prepared row |
| Provider succeeds, publication fails, copied response survives | Republish those same truthful bytes/source identity; do not call again merely to repair SQL |
| Provider succeeds, process loses response before retention | Preserve prepared/unknown lineage; safe same-key retry may recover a received replay. Otherwise record a new lookup or operator evidence as its actual source kind |
| Source publication commits, mirror/ACK fails | Source/blocker survives. Revalidate durable progress and retry subordinate bookkeeping; any real reinvocation keeps the original key |
| Result is retained but no usable signed event arrives | Keep confirmed obligation blocked. Result-only financial application is outside this automatic contract; reviewed recovery must not fabricate an inbox |

Stripe API v1 may prune idempotency keys after at least 24 hours; cached responses include HTTP 500 responses. Stop unresolved POST retries beyond the safe replay window and reconcile; reusing either an old pruned key or a replacement key can execute another operation. These constraints support the proposal's conservative recovery. [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests), [advanced error handling](https://docs.stripe.com/error-low-level).

A new lookup cannot recover the exact lost historical response or satisfy a predicate specifically requiring COMMAND_RESULT. A received same-key replay is genuine evidence received now and must retain that provenance. If it cannot establish attributable capture ownership/amount, the operation remains review-only. SQL-valid storage is not external authenticity proof.

## 4. Capture-first evidence analysis

The cycle is real in current0006: build_financial_evidence, lines305–415, requires successful attempts, original lots and POSTED journals, then trusted capture COMMAND_RESULT sources. financial_receipt_facts, lines183–250, recognizes only confirmed refunds/disputes. Current0007 classifies payment-intent receipts as unclassified; R1 correlation deliberately does not seal capture. Reusing this builder for a first capture would require the financial effect before its authorizing proof.

Design §5.1 solves that dependency by a distinct immutable payment_operation_evidence companion and shared SQL reader. Minimum forward contract:

1. Capture-success proof references original authenticated inbox/account, accepted CAPTURE attempt/outbox/key/recorded policy, owned D02 execution/object relationship and exact attributable provider gross/currency.
2. Its proof construction has **no dependency on the new lot, journal or successful local attempt state**. It may commit before application while the receipt obligation remains blocked.
3. Application and immediate/deferred guards consume that identical proof selector. Typed obligation FKs/classification distinguish it from refund/dispute proof1; exactly the applicable proof alternative is required even where nullable composite FKs would otherwise skip checks.
4. One terminal application slot per accepted capture attempt excludes success/failure dual finality. Unique CAPTURE business journal and unique lot attempt/journal keys remain backstops.
5. One transaction commits attempt success, one captured/fee increment, exact CAPTURE journal, original lot/eligibility, application, financial audit, source dispositions and claim-conditional inbox finality. No intermediate financial state is committed or exposed as complete.

The new invariant is: **each prospective successful capture effect has exactly one owned pre-lot success proof and complete canonical application; that proof never depends on the effects it authorizes**. Existing lot validation still checks the newly constructed successful attempt and sealed journal within the same transaction; there is no circular proof dependency.

Duplicate application must verify journal/lot/totals/audit/disposition, not just return because attempt.status is SUCCEEDED or LedgerService found a business-key collision. Competing failure/success cannot both occupy the terminal slot. A contradictory later failure retains review and the prior success; failure-first followed by incompatible success also requires review, without reacquiring already released capacity or silently overwriting state. F05 remains a separately accepted correction.

The amount witness remains an implementation gate: captureAmount/captureAttemptId metadata and requires_capture status alone are insufficient. A signed aggregate amount_received cannot automatically be assigned to each capture sharing the PI. R2-B must pin a supported operation-specific interpretation using genuine request/result and cumulative facts, account for already recognized captures and reject ambiguity. Single attributable capture support may proceed independently; unsupported multicapture remains excluded. Requiring this before implementing that branch is ordinary evidence engineering, not a new fee or monetary policy decision.

Authorization, void and capture failure need their disjoint attempt-proof shapes and workflow/no-effect evidence. They cannot masquerade as CAPTURE object observations or use a generic payment failure update. Automatic capture emitted by authorization must be an exact permitted child intent/outbox/audit under recorded policy in the authorization transaction.

## 5. Operation-by-operation accounting review

Use exact minor units: original G/F/N with N=G−F; confirmed refund principal/fee R/Q; closed loss L; remaining funded OPEN holds H; signed entitlement E=N−(R−Q)−L. Lots retain immutable originals; current holds include append-only adjustments. “Pending” below is the affected lot's claim, not pooled pending from another payment.

Common admission/claim/order and full atomic disposition in §§6–7 apply to every row:

| Operation | Authority, approved entries and attribution | Uniqueness, atomicity and recovery |
| --- | --- | --- |
| Capture success | New signed pre-lot proof + owned accepted command/D02. Dr PSP_CLEARING G; Cr own MERCHANT_PENDING N; Cr PLATFORM_FEE_REVENUE F. Preserve cumulative capture-fee delta and frozen posting eligibility. | Attempt terminal slot, CAPTURE:attempt, one lot per attempt/journal. Journal/lot/totals/state/audit/application/disposition share COMMIT. Abort all on any validator failure; complete saved replay only. |
| Refund acceptance | NEW_INTENT permit and verified originals. Freeze FIFO gross by financial microseconds/attempt UUID; capacity G−R−reserved−active/planned disputes−L. Selected lots must fit the current single-PI command. No posted liability hold. | Existing merchant/operation/key replay and payload comparison. Refund/whole RESERVED group/stored policy/outbox/audit/API response commit together. Unknown retains reservations; acceptance clears no confirmed source. |
| Refund success | Exact signed refund proof, accepted refund/key and frozen lots. For each g: q=div(F×(R+g),G)−Q; net=g−q. Reduce other holds first for E−net. Dr pending min(max(E−H_after,0),net) if unsettled, else0; Dr available remainder; Dr fee-refunds q; Cr own PSP if unsettled or cash if finalized, gross g. | One terminal refund application and REFUND:refund. All CONFIRMED rows/fees, main/hold journals, refund/payment totals/status/audit/disposition atomic. Preserve other OPEN disputes and bounds. F06 accepted-operation completion required; released-capacity late success becomes review. |
| Refund definitive failure | Positive signed failed/canceled proof for this accepted refund, no prior success. Whole RESERVED→RELEASED with confirmed-provider-failure reason; FAILED state/audit; no main/hold journal or refunded increment. | Same terminal slot as success. Proof plus complete released group and journal absence establish verified no-effect. Error/timeout/unknown alone cannot release. Replay preserves frozen terminal evidence. |
| Dispute open | Signed dp_ proof, immutable object owner and uniquely owned captures. Freeze disjoint FIFO g. Fund h=min(g,max(E−H,0)); exposure g−h. Dr own pending/available h; Cr merchant DISPUTE_CLEARING h; no asset loss. | Account/object binding plus existing global dispute-ID refusal, unique case/lot and OPEN application phase. Create internal case under proven natural key; complete allocations/workflow/audit atomic. h=0 is applied ZERO_EFFECT, not absent application. |
| Dispute win/close | Signed won proof, prior coherent OPEN application. Dr DISPUTE_CLEARING remaining own h; Cr pending if still unsettled, otherwise available h. No asset or fee reversal. | Exactly one CLOSE application outcome and DISPUTE_CLOSE:case if positive. Zero release still requires complete CLOSED/MERCHANT_WON state/audit/application. Close-before-open waits; replayed open cannot reopen. |
| Dispute loss/close | Signed lost proof and prior OPEN attribution. Dr own remaining clearing h. Reduce other holds to entitlement E−g; debit own surviving pending then signed available for extra g−h. Cr own PSP/cash g; retain original fee revenue. | Same CLOSE slot as win; main and cause-linked reductions atomic with complete CLOSED/MERCHANT_LOST state/audit/disposition. Full principal is accounted once even if own hold is0. Overlap/unknown provider net effect remains review. |
| Caused hold reduction | Exact confirmed disjoint refund/loss cause; normalize other OPEN holds in opened_at/case/allocation order. Dr merchant dispute clearing reduction; Cr lot's current pending/available. Never increase/overwrite original funding. | Unique allocation/effect-key and adjustment journal; every effect belongs to the cause application's manifest. Exclude closing case from surviving holds. Main and all adjustments roll back/replay together. |
| Settlement generation | NEW_CAPTURE mature verified originals and clean scope. Estimate A=G−R−L, release=max(E−H,0). Option A reservations subtract neither posted estimate. No journal. | Unique capture candidate; sum only inserted items. Candidate/header/audit and stored policy atomic, bounded sum(G+N) admission. Preserve owned unsupported candidate and durable reason; no silent supersession/empty batch. |
| Settlement completion | Current clean permit/revisions plus stored candidate and original/adjustment evidence. Recompute A and release independently. Dr cash/Cr PSP A; Dr pending/Cr available release. | SETTLEMENT:batch, one application, final item/lot ownership. Journal/items/lot/batch/audit/finality atomic, or explicit ZERO_EFFECT with no empty journal. Replay reads saved snapshot; later refund/loss must not rewrite it. |
| Payout reservation | NEW_INTENT/RESERVE permit, current own POSTED available sum under common authority. Dr MERCHANT_AVAILABLE; Cr own PAYOUT_CLEARING. Exact comparison, no Number-rounded balance authority. | API replay plus PAYOUT_RESERVATION:payout. Intent/reservation/application/outbox/audit/replay atomic. Existing accepted liabilities survive pause or later refund debt. No receipt clears through this unrelated journal. |
| Payout completion | Accepted owned reservation/internal command, exact recorded amount/currency and permitted recovery. Dr own PAYOUT_CLEARING; Cr PLATFORM_CASH. Local lab accounting only. | PAYOUT_COMPLETION:payout and completion application. Payout/journal/audit/conditional internal-outbox PUBLISHED share transaction at future floor; ambiguous COMMIT uses saved evidence, not another reservation. |

The entries preserve approved F01 policy. A balanced journal alone cannot prove the correct capture, source account, fee allocation or cause. The proposal requires SQL's full grouped entry multiset, including owner/type/currency/side, exact applying inputs and complete effect groups in both directions. Existing0004 aggregate asset-credit checks alone do not establish that result.

Independent arithmetic assessment of proposed examples:

| Scenario | Required result under the approved formulas |
| --- | --- |
| G10000/F300, confirmed refund5000 before settlement | Refund q150/net4850; PSP5000/pending4850; settle transfers5000/releases4850 |
| Full refund before settlement | Asset/release0; settlement ZERO_EFFECT; fee revenue300 and fee-refunds300 remain separate |
| Open principal5000, then settle | Hold5000 remains; asset10000/release4700. Win restores available5000; loss consumes cash5000 without another settlement |
| Settled A4000/F120 + unsettled B6000/F180, refund5000 | FIFO A4000/B1000; Dr available3880/pending970/fee-refunds150; Cr cash4000/PSP1000 |
| Two holds5000/4700 on net9700; second loses gross5000 | Release300 from first, then debit that own pending300 with closing hold4700. Remaining hold4700/PSP5000; no invented300 debt at this boundary |
| Settle10000/9700, reserve payout8000, later refund5000 | Available−3150, accepted payout clearing8000, cash5000 before payout completion; explained later debt, not permission for a stale read |
| G1000/F101, refund333/333/334 | Cumulative quotient gives fee deltas33/34/34 |

These are design calculations, not newly executed financial tests. BigInt/numeric quotient and combined journal-side bounds are mandatory. Existing capture Number products, mutable fee terms/P04, aggregate ranges and account metadata/F09 remain explicit boundaries: reject inconsistent/unrepresentable automatic application; do not silently select a different fee policy or claim those broader findings fixed.

## 6. Atomic financial disposition assessment

The proposed transaction in §5.2 has the necessary unit of atomicity:

    current claim + account/scope authority + exact immutable proof
      → SQL-issued transaction permit and protected applying manifest
      → complete journal/allocation/workflow/audit/application
      → exact source disposition/resolution + obligation clearance
      → deferred validation
      → COMMIT
      → acknowledgment

The permit's protected issuer derives transaction/backend, claim generation, operation, owner, stored policy/epoch, revisions and action from authoritative rows. A caller UUID, session GUC or TypeScript object cannot assert it. One operation per transaction is a reasonable initial limit, with the explicitly constrained authorization child exception. PostgreSQL exposes transaction identity primitives, but that availability is not proof of the proposed permit's security; savepoint and cross-transaction/backend misuse need actual SQL tests. [PostgreSQL transaction information](https://www.postgresql.org/docs/17/functions-info.html).

The essential equivalence is:

- An application may commit only with its exact complete effects/state/audit and final applying-source disposition.
- A prospective effect/workflow finalization may commit only with that complete application, even if a writer omits the application row entirely.
- A clearance may commit only with the exact matching application, affirmative verified no-effect, or verified duplicate acknowledgment of a complete earlier application.

A zero-funded dispute or ZERO_EFFECT settlement is a completed application with real state; failed refund is affirmative no-effect; duplicate acknowledgment is no additional effect referencing existing finality. They must not share an unqualified “no journal therefore clear” rule.

SQL guards must cover initial mutations/preparation and deferred finality. Read final rows by identity after multiple writes; do not validate obsolete queued NEW images. Manifest creation must precede financial mutation and derive original source state itself. Preserve0004/F02 parent version writes and test immediate constraints, nullable comparisons, omitted groups, arbitrary business types, DRAFT collisions and wrong same-inbox revisions.

| Required adversarial case | Design result |
| --- | --- |
| A. Ledger/deferred commit fails | Financial transaction, application/audit/disposition/clearance and revision deltas all roll back. Previously retained source/proof/blocker survives. |
| B. Effect commits, acknowledgment interrupted | Exact canonical application and source disposition already committed together. Fresh replay validates them and acknowledges; no repeat journal/totals/audit. Ambiguous COMMIT is read/revalidated. |
| C. Worker crashes after provider result | D02 crash rules in §3 apply. No unretained remote result becomes a local success/failure; no speculative journal or clearance. |
| D. Proof exists but application cannot proceed | Scoped AWAITING_APPLICATION or review stays blocking. A proof, RETRY/DEAD, note or elapsed lease cannot clear it. |
| E. Duplicate receipt after application | Equivalent same event preserves original; distinct event/source gets exact duplicate acknowledgment to the canonical application without retargeting first-applied proof/allocation references. |
| F. Later contradictory provider outcome | New immutable cause/blocker; original proof/application/journals remain. No automatic reversal or reuse of old resolution to absorb the contradiction. |
| G. Unknown owner becomes correlated | Account UPDATE then destination A/S; verify owned proof and atomically replace broad blocker with scoped unapplied blocker. Neither can disappear first. |
| H. Resolution races new evidence | Same authority serializes revision/CAS checks. Resolution covers only its frozen cause; later evidence retains its own barrier. Resume is a separate current check. |

Current0007 resolve_receipt_obligation recognizes exact original-event refund success/failure only. It can see same-transaction rows, but is not a universal R2 finalizer. Split self-locking entry points from permit-checked locked cores; do not call the existing resolver/sealer after financial suffix locks. R0.2 and D02 need independent immutable resolution children. Already-cleared R0 obligations can be reblocked; their first unique resolution cannot be overwritten or reused as a new cause's clearance.

## 7. Lock graph and concurrency matrix

This graph is a review of the intended protocol and installed trigger effects, not an executed R2 wait trace:

    one private inbox / API idempotency / internal-outbox claim wrapper
      → financial_evidence_accounts rows: chosen SHARE or UPDATE at entry
      → canonical merchant/currency transaction advisory
      → capture_accounting_scopes: NO KEY UPDATE
      → shared existing settlement header / own payout where applicable
      → ALL payment parents by UUID: NO KEY UPDATE
      → attempts by UUID → refunds by UUID → disputes by UUID
      → validated mirror rows in stable key order, when written
      → lots by capture-attempt UUID
      → dispute allocations by lot/UUID → refund allocations by lot/UUID
      → settlement items
      → immutable source/binding/proof reads and private application/journals
      → ledger account resolution/entries, complete financial audit/effects
      → exact obligation/exception/resolution rows and guarded revisions
      → source wrapper CAS finality, deferred checks, COMMIT

Original inbox identity is protected before the financial prefix. Shared source evidence is immutable/read-only; an application must not acquire another worker's inbox FOR UPDATE after scope. New source acknowledgment FKs must not introduce that reverse edge. D02 publication acquires account authority before shared scope/entity work; execution/outbox source references do not justify taking an operational lease row late.

| Actual PostgreSQL/installed SQL detail | Consequence for the proposed graph |
| --- | --- |
| Row SHARE conflicts with row UPDATE/NKU; KEY SHARE is compatible with NKU but conflicts with UPDATE | Choose account mode before scope; retain payment NKU for non-key changes and settlement FK compatibility |
| FK validation can take KEY SHARE on referenced parents; unique inserts can wait for transaction completion | Include inbox/account/admission/proof/payment/child/lot/journal/batch/exception parents and speculative/business-key waits |
| Allocation BEFORE triggers UPDATE refund/dispute and lot revision; hold insert revisits OPEN allocation | Prelock parents/lots/allocations in common order; the row being mutated is already locked before its trigger runs |
| Settlement-item trigger versions batch; finalization validator revisits scope | Existing batch must precede members; deferred revisits must find the scope already held |
| Entry INSERT updates DRAFT journal parent; POSTED is sealed | New journals are private. Conflicting old journal lookup must verify ownership/status/effects, not append or treat collision as success |
| Exception insert currently revisits scope; resolution touches cause/exception/audit links | Acquire authority before exception mutation; rescue APIs use exact checked source, never scope→another private inbox |
| financial_evidence_accounts and receipt_intake_authority are different rows | The former remains the first serialization authority; guarded revision-row updates do not replace its lock |

The current B.1 sealer uses own inbox → account **UPDATE** → A → scope **UPDATE** → payment NKU → children/lots/allocations. It must stay a separate fresh transaction. The installed R0 reader uses account SHARE → A → scope NKU. Unknown binding uses account UPDATE from entry. R0.2's narrow nonfinancial conflict publisher sorts all implicated accounts before any derived scopes. Its recovery must cover that complete frozen authority set; ordinary monetary application remains one scope.

After any wait, use fresh READ COMMITTED statements for authority/evidence/balance. A lock alone does not refresh an earlier snapshot or invalidate a stale higher-isolation aggregate; preserve real parent writes. [PostgreSQL lock modes/deadlocks](https://www.postgresql.org/docs/17/explicit-locking.html), [statement snapshots](https://www.postgresql.org/docs/17/transaction-iso.html).

Required controlled schedules, with “first” meaning the transaction that obtains the shared local authority and commits:

| Schedule | Permitted H03 outcomes and forbidden result |
| --- | --- |
| 1. Confirmed receipt versus payout | Receipt-first: block until exact application/resolution. Payout-first: reserve against then-current available; later confirmed debit may create approved debt. No receipt admission COMMIT inside the protected read/reserve interval. |
| 2. Refund application versus payout | With settled available9700, refund-first leaves4850 and rejects8000; payout-first reserves8000 then refund leaves−3150. Test different payments sharing the scope. Earlier confirmed-but-unapplied admission must block payout even before application starts. |
| 3. Dispute hold versus settlement | Hold-first: asset10000/release4700 with hold5000. Settlement-first: full release, later hold debits available. No release of already held funds and no asset loss at opening. |
| 4. Settlement completion versus later confirmed refund | Receipt-first prevents completion until applied; transfer/release5000/4850 thereafter. Completion-first freezes10000/9700, later refund uses finalized cash/available. Never rewrite saved settlement. |
| 5. Two workers apply one observation | Same source waits on claim/inbox; distinct associated source waits on scope. Commit-first yields one application and verified duplicate; rollback-first permits one later application. Stale-generation failure affects zero rows. |
| 6. Original receipt versus command-result observation | Result-first commits a confirmed blocker. Receipt-first lacking D02 remains blocked; genuine later result enables proof. Matching completed outcome is acknowledged; contradicting ownership/outcome remains a separate blocker. Neither source is relabeled as the other. |
| 7. Unknown-account barrier versus scoped admission | Unknown publisher/binder chooses account UPDATE first; spender chooses SHARE first. Barrier-first refuses; spender-first may commit before later evidence. Unknown→known transfer installs scoped blocker in the same commit that removes broad ambiguity. No SHARE upgrade. |
| 8. Exception resolution versus new evidence | New evidence first invalidates stale revision/resolution. Resolver-first clears only its cause; new evidence then reblocks. Multi-cause partial progress leaves uncovered barriers. Separate resume rechecks current state. |
| 9. Provider failure versus previous success | Success-first retains success and blocks contradiction. Supported definite-failure-first finalizes only that operation's verified no-effect; incompatible later success goes to review. No two terminal applications or F05 total increment replay. |
| 10. New capture proof versus lot creation | Proof/sealer needs no lot; application waits on authority/attempt and creates lot once. Second worker observes committed complete application or first-worker rollback. Lot failure rolls back journal/totals/clearance. No speculative lot to make sealing succeed. |

Each future schedule needs distinct backend PIDs, observed pg_blocking_pids, explicit gates in both relevant orders, bounded waits, awaited cleanup and exact committed account/source/revision assertions. An observed40P01 cannot be retried into a passing concurrency schedule. Production recovery may retry whole aborted transactions with unchanged business/provider keys; it must discard stale permits/manifests and revalidate claims/admission.

Potential cycles remain at the legacy boundary: authorization attempt→payment against payment→attempt; refund→payment against payment→refund; dispute→journal→payment against payment→dispute; mirror→child against child→mirror; header-after-lot against header-before-member; late source/inbox FK acquisition; and shared cold ledger-account/unique-key acquisition across scopes. The payment UPDATE/settlement FK cycle is historically reproduced and corrected to NKU in B2.1.1. The proposal preserves that fix and requires all-writer coordination plus cold-account tests. **No universal deadlock freedom is claimed**, and a speculative cycle is not reported as a newly reproduced defect.

## 8. Recovery and reconciliation assessment

Confirmed provider evidence and financial proof may remain unapplied indefinitely if a genuine dependency is missing; durability alone does not establish recovery liveness. D02 must retain enough invocation/request/account history for safe investigation, and R2-F must supply bounded scheduling/escalation and authenticated resolution paths before operational reliance.

Safe automatic recovery is limited to unchanged-source publication retry, within-contract same-key execution retry, fresh SQL admission/application after rollback, exact complete replay, and owned unknown→scope binding. It never infers a monetary outcome from an error class, missing object, queue ACK or mutable mirror.

Operator/reconciliation work is required for exhausted/expired unknown requests, lost response with no provable operation-specific recovery, missing signed application evidence, contradictory terminal outcomes, misbound ownership, released-capacity late success, overlapping refund/dispute principal and historical misposting. An actual lookup is stored as PROVIDER_LOOKUP with target/account/query/run context; it does not become a lost COMMAND_RESULT. Provider-side request discovery may be necessary when this platform lacks an object reference.

ReconciliationService.resolve currently writes issue note/status/audit only. It must remain unable to issue a financial resolution/certificate merely by marking RESOLVED. Accounting exception resolution needs exact original source, owner/lot/effect or positive no-effect evidence, actor/audit, current revision and immutable cause-specific history. Resume is separately guarded. Arbitrary monetary correction, payout cancellation and historical compensation remain outside the automatic contract.

Rollback is forward recovery after the first new-policy intent/candidate/reservation: pause through compatible code, preserve additive evidence/schema and accepted keys/liabilities. Restoring an old binary or downgrading evidence/policy cannot undo that boundary. Installation failure before COMMIT rolls back transactional DDL; post-install rollback is not a destructive down migration.

## 9. Legacy compatibility and H01–H12 alignment

| Approved decision | Alignment / remaining boundary |
| --- | --- |
| H01 maintenance/drain | Dormant checkpoints and coordinated enforcement installation retained; no partial live writer adoption |
| H02 policy/mode/epoch/revisions | Orthogonal stored policy/admission, protected permit and certificate inputs proposed; migration defaults remain legacy/dormant |
| H03 local ordering / Option A | Both transaction orders remain valid; pending/unknown alone creates no posted hold or automatic payout blocker |
| H04 unknown ownership | Correct account-level barrier and atomic narrowing; legacy broad-barrier impact remains separately constrained; operational owner/deadline/escalation still required |
| H05 shared dispatcher/floor | Every intent/callback/result/mirror/manual/due-job/payout path must join; stored accepted policy/key never reinterpreted by today's scope |
| H06 pooled payout | Exact POSTED available and scope-wide blockers; legacy scoped guard waits for complete legacy writer coordination; no cancellation of accepted payouts |
| H07 old-worker fence | Separate restricted compatible credential, retired old reconnect/restart paths, no old writable sessions/prepared work and restarted-old-artifact refusal remain activation gates |
| H08 first cohort | Fully verified NEW_CAPTURE history and all subsequent effects; no pending legacy command/candidate/reservation or untrusted ownership |
| H09 candidates | Durable retryable/blocking-review/terminal-unsupported reasons, bounded new admission and preserved immutable candidate ownership |
| H10 resolution/resume | Positive effect/no-effect and actor/audit; exact independent causes; separate fresh resume |
| H11 F01/F04/F05/F06 | No closure from dormant tests. Compatibility starts with first new-policy durable intent/candidate; F05/F06 need separate accepted corrections |
| H12 evidence | Actual PG18/17, signed HTTP, external test-mode/broker/Redis, hosted exact-diff and mixed-worker gates remain distinct; none newly executed here |

Option A is preserved if the implemented blockers follow the proposed predicates: genuine pending/requires_action source is tracked as nonblocking AWAITING_CONFIRMATION; accepted gross reservations consume refund capacity, not posted availability. A confirmed terminal result, contradiction or unresolved financially relevant owner can block. Distinct terminal-followup links must not mutate a pending row into a fictitious failed/no-effect proof or feed it through0007's confirmed-proof FK. A generic “any unresolved D02 execution/refund” spending predicate would violate this approved policy and must be rejected in its independent review; changing that policy would require a new explicit human decision.

Historical compatibility is intentionally conservative:

| History | Treatment |
| --- | --- |
| Missing raw receipt/D02 proof or success without lot | Preserve bytes/IDs that exist; no reconstructed originals or automatic eligibility. New lookup can report current facts only. |
| Incorrect posted journal | Retain original; separately approve evidence-backed compensating treatment. Balance or issue RESOLVED is not repair. |
| Existing legacy settlement/candidate | Keep original policy/ownership/finality; exclude from first cohort. Do not recompute a completed legacy journal under R2. |
| Pending pre-cutover provider command | Drain/reconcile using original key and recorded policy. D02 must not silently stamp a legacy command with today's policy. |
| Unverified owner or conflicting accounts | Keep broad/scoped review according to trusted evidence; metadata cannot choose scope. |
| Unresolved payout reservation | Preserve clearing liability and accepted recovery; exclude first-cohort activation, no retroactive cancellation. |
| Refund/dispute overlap | Freeze available evidence/reservations, retain exception, no guessed net loss or automatic release/compensation. |
| New lot followed by legacy adjustments | NEW_CAPTURE origin alone is insufficient; verify every later effect and pooled liabilities. |

Version0 currently permits new legacy-format writes; it is not a protected historical epoch. The design correctly requires prospective no-NULL/no-version0/no-downgrade guards, including RESERVED/PLANNED/OPEN transitions, before effects become possible. Existing final history remains original; no promotion by caller-supplied stamp.

Dependency separation is acceptable: A dormant D02 publisher, B dormant R2 writers, C assembled policy dispatcher, D complete legacy writer floor, E operational old-worker fence and F guarded scope activation are different deliverables. Additive storage can be independently reviewed; final default/enforcement installation cannot run under incompatible payload-only writers. F01/F04 stay open in runtime; isolated evidence never closes F05/F06.

## 10. Proposed R2 implementation sequence

Retain the seven top-level checkpoints, with the following acceptance ownership. Each needs its own complete reviewable diff and independent gate before the next dependent stage. No checkpoint is authorized by this report.

| Checkpoint / exact owner | Preconditions and core invariant | Permanent regression and controlled schedules | Recovery, activation boundary and stop condition |
| --- | --- | --- | --- |
| D02-A: provider port/Stripe transport; command handler/consumer and reconciliation isolated adapters; new forward source/execution/obligation SQL, schema/journal and restricted pool/publisher | Accepted R1 and prospective accepted-command identity. Truthful original source, exact ownership, stable key, mandatory confirmed blocker; no financial writer. | Complete/partial/error/unknown bodies; SDK and broker retries; malformed envelope rejected before call; authenticated roles/column rights; duplicate/conflict; result↔receipt and unknown↔reader; publication rollback/COMMIT loss. | Republish retained source or truthful safe retry/lookup; separate mirror failure. No live registration or proof-floor opening. Stop if genuine body/account/command identity or revision writer cannot be established. Independent provenance/SQL/transport review first. |
| R2-A: shared application/manifest/permit/source-disposition forward SQL and schema; locked-core admission APIs, claim/policy/era fields and restricted writer grants | Reviewed D02. Unforgeable operation-specific authority and bidirectional finality, no historical-format bypass, F02/0004 safeguards retained. | Fresh/populated upgrades, old final fingerprints, omitted entire application/effect, NULL/version0/downgrade/arbitrary business type, savepoint/backend/xact reuse, immediate/deferred constraints, rollback/DDL wait, authenticated ordinary role. | No active defaults/certificates; final enforcement installation waits for all adapters. Preserve additive schema on code rollback. Stop on missing reverse implication, incompatible history or unreviewed grants. Independent SQL/lock/privilege gate. |
| R2-B: payment-operation proof builder/reader/classifier/typed obligations; dormant capture/workflow adapter in webhook boundary; capture-specific application validators | D02-A/R2-A. Pre-lot success proof independent of effects; one terminal capture, one journal/lot/totals increment; no invented auth/void money. | Signed proof→actual capture transaction; exact fee/range; duplicate distinct events; all failure/success orders; shared-PI attribution/refusal; after-journal/lot rollback; capture-proof↔application and attempt races; F05 A-success/B-pending/stale-failure/replay sequence. | Unregistered, unsupported provider patterns blocked. Separate F05 correction/acceptance before relevant live use. Stop on ambiguous amount witness, cycle, monotonicity or changed fee policy. Dedicated capture review required before refund/dispute integration. |
| R2-C: CaptureRefundAccountingService; acceptance policy stamping; refund SQL guards/duplicate/no-effect recognizer; caused hold links/helper | Reviewed capture authority and frozen lots; separate accepted F06 completion contract. Exact per-lot fee/source, no release on unknown and complete cause manifest. | Optional-ID signed success/failure; mixed sources/rounding/whole groups; released late success; duplicate event refs; main+adjustment rollback; refund↔payout both payments/orders and competing hold reduction; accepted refund↔later capture/F06. | No live module/route switch. Preserve reservation on refusal; exact-source recovery only. Stop on altered policy, lost confirmed obligation, partial group or absent F06 prerequisite. Independent accounting/SQL gate. |
| R2-D: CaptureDisputeAccountingService; open/close/zero-result validators; first-open internal-case link and hold causes | Reviewed capture/refund source floor; disjoint policy. Immutable initial funding, current hold normalization, one open/one close outcome. | Signed open/win/loss, zero-funded/no-release, close-before-open, open-after-close, opposite outcomes, cross-owner binding, refund/loss orders, hold↔settlement and direct-SQL negatives. | Unregistered; missing open retries, overlap/unknown remains review. Stop on speculative principal, changed loss-fee/debt policy or incomplete phase evidence. Independent accounting/concurrency gate. |
| R2-E: CaptureSettlementAccountingService, PayoutsService, internal-outbox fencing and central dispatcher/common legacy-compatible writer floor | All prior operation contracts; independently accepted F05/F06. Candidate/finality separation, exact pooled reservation and every relevant runtime path joins the same order. | Bounded/unsupported candidates; zero and immutable replay; payout reservation/completion ACK loss; all ten schedules in §7 using assembled services, cold accounts/currencies; manual/due-job/legacy bypass and actual active-path F04 evidence before closure. | Keep composition unregistered. Complete accepted reservation through compatible recovery. Stop on bypass/reverse edge/stale balance or unexplained candidate rewrite. Independently review settlement, payout, then complete caller graph. |
| R2-F: exact exception/R0.2/D02 resolution, reblocked episodes, separate resume/certificate/candidate recovery; integrated acceptance documentation | Prior accepted writers, H04/H09/H10 and supported evidence only. Clearing one cause cannot clear another or implicitly resume. | All A–H cases; new admission↔resolution/resume both orders; multi-barrier partial resolution; cleared-then-reblocked; missing audit/effect/source; real isolated restart/ambiguous COMMIT and full lifecycle/ordinary-role matrix. | No actual activation/resume. Preserve unresolved histories/candidates and forward-recover. Stop at absent monetary oracle or unprovable cause clearance. Final independent assembled R2 review, then separate operational gates. |

For smallest independent diffs, R2-A should establish common primitives and closed typed structure; operation-specific full validators travel with R2-B/C/D, staying closed until complete. This avoids implementing every financial writer twice or installing an incomplete alternate interpretation. This is a sequencing refinement within the design's coordinated-install rule.

Likewise split R2-E review work into E1 settlement adapters, E2 payout/internal-outbox adapter and E3 complete dispatcher/legacy floor assembly. These are subchecks of E, not separately deployable partial floors. Capture may split evidence support from its financial adapter if necessary, but both must pass the dedicated capture gate before C/D. Do not combine D02, all accounting writers and cutover in one run.

Every checkpoint's regression acceptance must preserve existing assertions and source history, report exact executed versus skipped checks, use disposable databases and keep network boundaries mocked unless explicitly authorized later. Bounded40P01/40001 whole-transaction recovery belongs in separate retry tests; it must not hide a controlled lock schedule failure. Later production enforcement installation, D03 cohort certification, actual credential/session fence and activation require their own evidence and authorization.

## 11. Human decisions and trade-offs

No new accounting-policy approval is required for the declared automatic path. The design's “no new policy decision” statement is supportable only while unsupported monetary cases remain blocked.

| Decision | Existing approved policy / proposed approach | Alternative and trade-off | Risk of wrong choice | Human approval / blocking category |
| --- | --- | --- | --- | --- |
| Pending refund payout effect | Approach A/Option A, H03/H06: reserve gross capacity only; confirmed outcomes get durable admission | Immediate hold reduces later debt but changes posted availability and product policy | Accidental block of all pending refunds or invented speculative liability | No reapproval for current approach. Any strict hold requires new policy before that implementation; not a D02 blocker. |
| SDK observation trust | D01/D02/H05: separate original API source and restricted publisher, no signed-inbox fabrication | Parsed/mutable snapshots are simpler but cannot supply the promised original provenance | False ownership/amount or retrospective trust | Engineering evidence **before D02 acceptance**; no human choice needed to invent a weaker source. Stop if unavailable. |
| Lost result / retry horizon | Preserve accepted key, unknown reservation and truthful lookup/review | Blind old/new-key retry improves apparent liveness but can duplicate execution | Double provider operation or false no-effect | Existing safety policy; engineering recovery gate before D02. Exceptional monetary resolution needs case-specific approval. |
| Attributable capture witness | Approved exact owned capture; separate pre-lot reader, refuse ambiguous shared-PI facts | Guess metadata/cumulative delta or exclude unsupported patterns | Duplicate/misattributed principal | Pin supported provider interpretation **before capture application implementation**. Conservative exclusion is engineering; expanding monetary policy needs a concrete decision only if it changes the contract. |
| Fee arithmetic/terms/range | Preserve current cumulative capture-fee policy and immutable original fees for later effects; exact/bounded automatic execution | Repricing accepted captures, changing fee terms or global money types | Wrong minor unit/entitlement or stuck candidate | Bound/validate as engineering before each writer. New fee/quote policy requires human approval before that change; broader F03/P04 remain separate. |
| Dispute/refund overlap | Approved disjoint automatic allocation; exact conflict remains blocked | Priority rule/netting/compensation needs provider net-effect evidence | Double loss, erased obligation or incorrect release | **Before applying that exceptional case**; not before ordinary D02/R2. No policy oracle supplied here. |
| Historical misposting/candidate supersession | H08/H09: preserve originals and exclude first cohort | Approved compensation/supersession can recover more histories but needs exact evidence | False historical authority, duplicate settlement | Case-specific approval before repair; D03/activation gate. |
| Pause/recovery and accepted payouts | H05/H06/H10: preserve accepted obligation, exact-source recovery, separate resume | Blanket bypass or automatic cancellation simplifies operation but breaks obligation ownership | Unpaid accepted liability or spending over an unresolved cause | Existing policy; implement exact permits as engineering. Resume/activation needs separate operator decision. |
| Account barrier owner/deadline | H04 requires observable assigned triage and escalation | Indefinite unattended barrier is safe refusal but poor availability | Broad operational outage or unreviewed timeout-clear | **Before runtime activation/reliance**, choose accountable owner/runbook/deadline. No auto-clear deadline. |
| Credentials/account/mode/cohort/environment | H01/H07/H08/H12: explicit environment setup, separate compatible credential, clean selected cohort and later go/no-go | Mixed-version/gradual rollout increases coordination/evidence burden | Old writer bypass, accidental live execution or invalid cohort | **Before operational installation/activation** with environment-specific authorization. No real credentials/session changes here. |
| Permit key, source key encoding, lock batching, typed schema placement and staged subchecks | Reviewed invariant determines implementation; defaults remain closed | Several ordinary implementations can satisfy the contract | Weak realization must fail independent technical review | Nonblocking engineering details; no human approval for routine choices. |

Classification: no unresolved human policy blocker before D02; technical source/ownership gates before D02; capture-proof/permit/accounting gates before financial application; explicit operational choices and D03/fence/evidence gates before activation. Ordinary SQL/function design is not a reason to ask the owner to choose financial policy again.

## 12. Confirmed findings

**No new confirmed P0/P1 design defect or acceptance-blocking P2 defect was identified.** No corrective code, migration or test was implemented. The proposal names the substantive missing mechanisms and makes them prerequisites; their absence at an intentionally closed baseline is not misreported as a contradiction in the future contract.

Existing confirmed runtime defects remain preserved, with their original evidence and severity in the [H1 audit](h1-financial-correctness.md):

| Existing finding / design section | Source, violated invariant and concrete failure | Minimum correction / future regression / blocking boundary |
| --- | --- | --- |
| F01, high; design §§6/13 | Legacy SettlementsService uses original gross/net after refund or hold. Partial refund can leave cash10000/available9700 despite surviving asset5000/claim4850. Balanced journal does not prove entitlement. | Reviewed capture-owned accounting plus full dispatcher/floor and historical treatment; keep six original regressions. Blocks runtime F01 closure, not this staged design. |
| F04, high; design §§8/13 | Legacy refund/dispute writers do not share payout's advisory. Payout8000 reads9700; earlier competing refund commits4850 before payout reserves, leaving−3150 from a stale admission. | All balance writers and receipt intake coordinate through reserve COMMIT. Actual route-level two-order/different-payment tests. Blocks active-path closure; payout-first later debt remains approved. |
| F05, high; design §§5/6/11/13 | captureFailed overwrites successful A while B is pending; A success replay may increment totals although business journal deduplicates. Workflow totals must equal first established effects. | Separate monotone attempt/operation-owned correction; A-success→B-pending→stale-A-failure→A-replay plus source-conflict/SQL tests. Blocks relevant runtime use and closure; not silently fixed here. |
| F06, high; design §§6/11/13 | Accepted refund cannot complete solely because later capture sets CAPTURE_PENDING; current processor can DEAD that confirmation. Accepted external obligations must remain recoverable. | Separate accepted-operation completion/state correction and signed dispatcher regression, including dispute interaction. Prerequisite to corresponding refund integration, and activation gate. |

The B3.1 late-receipt and exception/payout gaps, unfenced processor bookkeeping, lossy current provider result and closed proof references are source-supported baseline dependencies addressed by the proposed contract. They were not newly exercised here. Retain earlier R0 classification failure/correction and B2.1 deadlock history unchanged.

Residual risks, not confirmed design defects: transport capture feasibility, actual permit/grant security, omitted-row trigger coverage, exact capture amount interpretation, cold-account/implicit lock permutations, recovery liveness, historical inventory and deployed credential/worker fencing. Each has a named checkpoint/stop condition above. No allegation of a reproduced R2 deadlock, privilege bypass or incorrect journal follows from static review.

## 13. Corrections required and verification

**No blocking design correction is required before separately planning D02-A.** Before implementation acceptance, make the engineering requirements concrete at their owners:

1. D02-A must prove original response acquisition and actual accepted command/account/mode ownership, including SDK internal retries, no-object outcomes and expiry-safe recovery.
2. R2-A/B must prove SQL-owned permit/manifest authority, both finality implications and a genuine pre-lot capture proof. Unsupported amount attribution stays refused.
3. C/D/E must prove exact per-lot entries, complete adjustment groups, duplicate/no-effect links and every current/legacy writer joining the intended graph.
4. F must prove cause-specific barrier/exception clearance, reblocked episodes, separate resume and interrupted/restarted recovery without altering prior evidence.
5. Keep the smaller E subchecks and operation-specific SQL/service gates in §10. This refines reviewability without adding an activation path or changing H01–H12.

These are already required acceptance conditions, not silent amendments to the author's design. A future implementation failing one returns to its independent review gate; this approval cannot waive it.

Verification record for this review:

| Check | Result and scope |
| --- | --- |
| Baseline/source/SQL/review history inspection | Completed; main/HEAD/initial dirty state established, all migrations 0000–0008 and affected service boundaries inspected |
| Official PostgreSQL/Stripe documentation | Read for lock/snapshot/transaction identity and API v1 unknown/idempotency semantics; no provider API executed |
| Documentation links/anchors/CI structure | PASS: node .tmp/validate-docs.cjs checked 51 Markdown files / 726 relative links and anchors; CI YAML parsed/structure checked. Extracted 19 unchanged Mermaid blocks; no diagram parser/rendering claimed. |
| Whitespace, final newline and scope/hash preservation | PASS: git diff --check plus direct checks of the untracked report's newline/whitespace and 14 required sections. HEAD unchanged/index empty; author's SHA-256 unchanged; exactly one review link added to the initial index; no other tracked changes or unexpected untracked deliverables. |
| Financial suites, migrations, lint/typecheck/build | NOT RUN: documentation-only review; no implementation behavior changed and no new runtime evidence claimed |
| PostgreSQL, Stripe, RabbitMQ, Redis, hosted CI, deployment/fence/cutover | NOT RUN; no service started, financial data changed, production access or activation |

R1's accepted 633 PostgreSQL cases, 50 units and six preserved F01 expected failures remain earlier review evidence, not this run's results. Configured CI and supplied baseline acceptance do not prove the next implementation diff. The original design's offline oracle/check counts likewise remain the author's record.

## 14. Final verdict

**DESIGN_APPROVED_FOR_STAGED_IMPLEMENTATION**

No unresolved P0/P1 design contradiction remains within the declared signed-receipt-driven, disjoint, capture-owned automatic boundary. First checkpoint: **D02-A genuine immutable provider observations**, separately authorized, isolated and dormant. Then shared closed SQL authority, a dedicated capture proof/application gate, refund, dispute, and smaller settlement/payout/dispatcher subchecks before integrated recovery acceptance.

Later gates remain: separately accepted F05/F06 corrections; actual active-path F04 evidence and eventual F01 runtime regressions; D03 eligibility and historical treatment; complete compatible writer floor; restricted operational grants, old-session/prepared-work/restart fence; maintenance/drain and provider/broker/Redis/hosted exact-diff evidence; guarded certificate and explicit human activation go/no-go. H04 operator/deadline, environment/account/mode/credential/cohort choices and any exceptional monetary compensation require their specified later approvals. No new ordinary automatic accounting policy decision is required now.

**No runtime code, schema, migrations, tests or financial data were modified. No commit or push occurred. Approval authorizes planning staged dormant implementation only; it never authorizes financial scope activation, legacy writer replacement, payment execution or production cutover. Do not proceed automatically to implementation.**
