# H1 Fix 02 — B3.2 Run A independent cutover design review

Status: completed design review — changes requested. Reviewed 2026-10-11.
Verdict: **DESIGN_REQUEST_CHANGES**.

This record reviews the [proposed cutover design](h1-fix-02-b3-2-runtime-cutover-design.md); it does not replace the [approved accounting policy](h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09) or current runtime owners. No runtime implementation, migration, activation, financial repair, commit or push is authorized by this review.

## 1. Baseline and scope

Reviewed `main` at `052421a6c90b4aadbcde957ef4e5268c7632a124` (B3.1), one commit ahead of local `origin/main`. Initial worktree contained an existing modification to `docs/README.md` and the untracked B3.2 proposal. Both were preserved. This review adds this record and one index link; the proposal is unchanged.

Read the agent/routing/workflow documents, approved Run A/B1 contract, B2.4 record, B3.1 record and proposed B3.2 design. No B3.1 independent-review document is present. Inspected receipt/normalization/claim/business processing, dormant refund/dispute/settlement writers, current payment/refund/dispute/settlement/payout writers, ledger, provider result/mirror bookkeeping, reconciliation, internal outbox, relay/consumer/job registration, schema and migrations 0000–0005. Source references below identify the reviewed checkout, not a future implementation.

Current facts remain: captures append journal-backed lots; allocation-aware refund/dispute/settlement services are disconnected and use test-only dormant admission; current scope status cannot be ACTIVE; legacy runtime financial paths remain selected. The B3.1 receipt and exception/payout gaps are real current limitations. The proposal explicitly plans to correct them; they are not new implementation defects attributed to this documentation change.

The maintenance/floor/barrier direction is suitable for this lab. One concrete incompatibility must be resolved in the design before acceptance: trusted correlation stored outside the original inbox payload cannot currently authorize the promised financial application, including PostgreSQL's refund evidence checks.

## 2. Blocking finding

### D01 — P1: resolved correlation has no application-and-SQL evidence contract

**Proposal evidence:** sections 5 and 7, lines 86–98 and 171, preserve the original normalized inbox payload, store trusted correlation separately, then dispatch using the actual inbox UUID. T14, lines 535–543, promises that later trusted correlation maps the blocker and permits exactly one refund/application. The proposed checkpoints do not identify how the existing payload-based financial checks consume that new proof.

**Executable evidence:**

- [CaptureRefundAccountingService](../../apps/api/src/refunds/capture-refund-accounting.service.ts), lines 82–89, rereads `webhook_events.payload` by inbox UUID and requires its `refundId`, `paymentId` and `merchantId`. Missing identifiers throw `INVALID_REFUND_EVIDENCE` before applying allocations.
- [CaptureDisputeAccountingService](../../apps/api/src/disputes/capture-dispute-accounting.service.ts), lines 31–35, likewise requires ownership in that payload, then locks the payment using those values.
- [Migration 0004](../../apps/api/drizzle/0004_capture_accounting_foundation.sql), `prepare_capture_allocation_write`, lines 307–315, rejects final CONFIRMED/RELEASED refund allocations unless the original inbox payload's type, refund, payment, merchant and currency match. Its deferred refund check also reads payload amount, lines 414–416.
- [Stripe event normalizer](../../apps/api/src/webhooks/stripe-event.normalizer.ts), refund/dispute cases at lines 46–75, obtains optional ownership identifiers from metadata. [WebhookBusinessService](../../apps/api/src/webhooks/webhook-business.service.ts), lines 48–75, currently enriches a transient event from local mirrors, not the stored inbox payload.

**Ordinary failure:** a valid provider event lacks optional ownership metadata but is later correlated to an owned refund/payment through trusted provider references. A separate admission record can now name the scope and retain the original payload correctly. Passing its inbox UUID still fails the dormant service. Changing only the service to accept resolved context still fails the refund trigger. Therefore the promised mapped-to-applied lifecycle cannot complete; either the blocker remains indefinitely or a future implementer is tempted to clear it without applying its financial evidence.

**Required design correction:** define one authoritative, immutable correlation proof/effective-evidence contract tied to the original inbox identity and owned intent/provider references. Identify both the financial service adapters and the forward SQL function changes that consume the same proof. Preserve the original payload and all amount/currency/provider/ownership checks; fill only genuinely missing identifiers from validated evidence, and send contradictions to review. Do not rewrite 0004, alter historical signed evidence, weaken constraints, or fabricate a replacement webhook. Alternatively, explicitly classify these events as unsupported manual recovery and remove the automatic T14 application promise; that is a narrower functionality choice requiring human agreement.

**Acceptance evidence required later:** actual receipt → trusted correlation → dispatcher → service → commit-time PostgreSQL checks for missing-ID refund success/failure and dispute open/close. Assert unchanged original payload, stable proof linkage, exact journal/allocation/disposition, one application on replay, and refusal of contradictory or cross-owner proof. Merely testing marker movement or a mocked dispatcher cannot establish this contract.

This finding requires a scoped design revision, not a change to financial code during this review.

## 3. Nonblocking findings and implementation conditions

| ID / severity | Evidence and implication | Required checkpoint treatment |
| --- | --- | --- |
| D02 / P2 | Proposal line 98 correctly requires known command/reconciliation outcomes to enter admission, but line 86 defines metadata by inbox ID. [Command handler](../../apps/api/src/payment-commands/payment-command-handler.service.ts), lines 19–38 and 73–87, persists a result/mirror without creating an inbox. [Stripe provider](../../apps/api/src/payment-provider/stripe-payment.provider.ts), lines 103–109, returns refund status. [Reconciliation](../../apps/api/src/reconciliation/reconciliation.service.ts), lines 31–32 and 49–79, stores observations/issues; note resolution applies no money. | A/B must specify a durable source key and lifecycle for financially relevant observations without an inbox. Link a later real webhook/application to the same obligation and resolve both observations atomically. A typed source reference or protected predicate on existing records is sufficient; a generic event engine is unnecessary. Test a confirmed command result before callback, subsequent exactly-once application, and note-only resolution. Pending/unknown intent remains payout-neutral under approved Option A. This elaborates an already explicit design requirement, rather than alleging the proposal permits ignoring these outcomes. |
| D03 / P2 | Proposal line 88 plans a richer future financial-relevance classifier. The existing normalizer can yield `provider.unsupported` with `data=null`; existing IGNORED or incomplete history cannot be certified merely by querying new receipt markers. | E's inventory must explicitly triage pre-floor financial-relevant unsupported/ignored rows using retained trusted evidence where available. Missing evidence keeps the scope legacy/review. New classifier success cannot retroactively certify old history. |

The cold platform-account ordering risk is already called out in section 14/T15. [LedgerService](../../apps/api/src/ledger/ledger.service.ts) resolves accounts in caller line order, and merchant locks do not serialize shared platform account creation. No new cycle was reproduced in this review. Retain T15 as an activation condition; require a surgical ordering correction only if actual SQL schedules establish a cycle. Do not claim universal deadlock freedom from green same-scope tests.

## 4. Atomic admission assessment

The proposed prefix is workable **if every relevant writer and evidence publisher participates**: one private operation wrapper → intake barrier → canonical merchant/currency advisory lock (A) → scope row (S) → authoritative rereads. The lock is held until transaction completion, not released after a pending-inbox SELECT. A certificate is a transition proof, not a cache of permission to spend.

| Question | Assessment |
| --- | --- |
| Does receipt establish durable ordering with settlement? | Proposed yes: known receipt and completion share A/S; unknown receipt additionally uses the intake barrier exclusively. Inbox and marker commit together before 202. Current receiver has no such barrier. |
| Can relevant receipt commit between final check and completion commit? | Proposed no for participating paths. It must wait on the same scope, or the exclusive intake barrier waits on admitted shared holders. A plain row insertion outside this protocol remains unsafe. |
| Is correlation validated under locks? | Discovery alone is insufficient. Revalidate owned payment/child/provider references after authority, before mirror overwrite. D01 must supply the same proof to application and SQL. |
| Unknown/ambiguous identity? | Retain evidence and an exclusive-gate unresolved marker; refuse new-policy spending/activation until trusted mapping or reviewed no-effect. Never guess a scope, clear by timeout or silently ignore an unsupported financial event. Legacy refusal is a separate pending decision. |
| Legitimately later confirmed event? | Apply once using actual finalized lot/journal sources. Preserve settlement evidence; approved later obligations may produce explained debt. No local barrier prevents an external event not yet known locally. |
| Known OPEN exception ignored? | New-policy settlement/payout must check all scoped blockers under authority. Exception creation/resolution participates too. Current legacy payout ignores scope review; the design accurately avoids claiming current quarantine. |
| New inversion? | No unavoidable cycle in the proposed prefix was identified statically. This is conditional on private-row rules, no intake upgrade after scope, consistent child/header order and implicit-lock regressions. Existing reverse orders cannot coexist with partial adoption. |

Two concrete proposed transaction timelines, with initial gross10000/fee300/net9700 and a confirmed refund5000:

1. **Receipt first:** R owns its inbox, then shared intake/A/S, validates ownership and commits blocking evidence. Settlement then takes A/S, reads the marker in a fresh statement and defers without a journal. W later takes its own inbox/claim and A/S, commits refund5000/returned fee150, allocations, audit and disposition/marker together. Completion retries, rereads actual evidence and moves PSP5000 to cash while releasing pending4850 to available. No original 10000 settlement is allowed in this order.
2. **Completion first:** S takes shared intake/A/S, verifies clean evidence and holds authority through settlement commit (cash10000/available9700). R may own its private inbox but waits before admitted receipt commit. After S commits, R records its blocker; W applies the refund to the finalized source, leaving cash5000/available4850. This is a legitimate later locally admitted effect, not a receipt committed inside S's protected final-check interval.

For ambiguous receipt, the same two orders occur at the intake barrier: receipt's exclusive acquisition commits the unknown marker before any later spending; or an already admitted shared holder completes first, and receipt follows. A network arrival waiting for a database lock is not yet durable receipt admission. Failed receipt transaction must return retriable failure, not 202.

Keep four meanings separate:

| Time | Meaning and authority |
| --- | --- |
| Provider outcome | Provider's observed occurrence/confirmation; useful evidence, not PostgreSQL commit order. |
| Webhook receipt | Arrival can precede a wait; durable inbox+marker commit is the enforceable local admission boundary. Store arrival separately if needed. |
| Inbox processing | Claim/lease and application attempts can happen much later; PROCESSING is not applied money. |
| Financial application | Successful business transaction commits journal, allocation/workflow, audit and disposition/marker. Stored financial capture time is evidence; a transaction timestamp must not be described as an exact commit timestamp. |

At READ COMMITTED, use a new evidence/balance statement after lock acquisition; a discovery result or statement snapshot obtained before a wait must not authorize money. This follows PostgreSQL's [isolation semantics](https://www.postgresql.org/docs/17/transaction-iso.html). Higher isolation needs an explicit retry/snapshot contract rather than assuming the same reread behavior.

## 5. Lock compatibility and policy routing

The required financial order after A/S is existing settlement header when completing → payment IDs in order with NO KEY UPDATE → attempts/refunds/disputes → validated mirrors → lots/allocations/items → journals/accounts/audit. Payout takes scope before its payout row. New private headers/lots/journals are exceptions; shared existing headers are not.

NO KEY UPDATE preserves non-key writer serialization and compatibility with KEY SHARE; ownership keys must remain stable. Advisory locking is cooperative. Foreign-key and unique-index waits still matter. See PostgreSQL's [explicit locking contract](https://www.postgresql.org/docs/17/explicit-locking.html). A same-scope advisory lock cannot prove shared platform-account safety across scopes.

Required graph rules: own only this operation's inbox/idempotency/internal-outbox wrapper before scope; do not visit another operation's wrapper afterward. Settlement/payout read marker predicates without locking others' inbox rows. Unknown resolver decides exclusive intake mode before scope; discovery of ambiguity under a shared lock requires rollback and separate retry, not a SHARE→UPDATE upgrade. Do not acquire a second arbitrary scope while retaining the first. Network reads/calls remain outside these locks.

Current reverse edges explicitly requiring the coordinated compatibility floor are authorization child→payment, legacy refund→payment, legacy dispute→journal→payment, provider mirror→child, legacy generation attempt→payment FK, and payout completion row→journal if scope is appended afterward. B2.1.1 solved its capture/generation FK cycle, not these broader floor dependencies. No individual handler reorder is recommended during this review.

| Entry point | Required policy identity and admission before effects |
| --- | --- |
| Refund request | Scope permit chooses writer; freeze allocations and policy/epoch with intent, outbox, audit and replay response. |
| Refund success/failure | Owned accepted intent determines compatible policy; D01 proof, claim fence, current mode and original outcome evidence are checked before mutation. |
| Dispute open/close | Trusted owned scope, recorded dispute/allocation policy and prerequisites; close-before-open remains durable/retryable, never speculative application. |
| Capture/auth/failure/cancel | Common payment-first order; preserve capture journal/lot semantics, no authorization lot, monotone outcome prerequisite. |
| Settlement generation | Enumerate scopes without authority, then one admitted transaction per scope. Never run unfiltered legacy all-scope generation over activated scopes. |
| Manual, due and scheduled completion | Stored batch policy and current scope must agree; admission precedes shared header/member locks. NULL legacy batch cannot be converted or silently completed by the new writer. |
| Payout request/completion | Guard current policy/mode/blockers; preserve an accepted reservation's identity and liability on pause/replay. |
| Webhook retry | Same inbox/evidence and conditional claim generation; stale worker cannot overwrite committed disposition. Revalidate under fresh compatible admission. |
| Command replay/result | Validate durable intent policy/key against database, preserve provider key, call outside locks, then admit result bookkeeping. Broker payload/ACK is not policy authority. |
| Reconciliation/operator action | Classify durable observations; note endpoint grants no financial resolution. Reviewed corrective/no-effect proof and resume are separate actions. |

These are proposed routing obligations. Registration/call-site coverage across all four root modules and direct callers is required; no path may fall back to legacy after an active-policy assertion fails. Immutable operation policy must survive epoch changes; an epoch mismatch cannot reinterpret already accepted money. First activation's prohibition on outstanding legacy commands makes the initial cohort smaller and safer.

## 6. Worker fencing assessment

Maintenance/drain is the appropriate recommendation for a lab with four processes. It is not executed or already provided by DATABASE_URL configuration. Stop mutation APIs, claim loops, inbox/internal-outbox workers, scheduled/manual settlement, payout, relay, provider consumer and reconciliation/operator writers; inventory durable work before replacing them. Keep a compatible receiver, or return retriable non-2xx during its replacement window. Drain does not mean declaring UNKNOWN outcomes failed.

The concrete fence is **old login unavailable plus no surviving old writable sessions/prepared transactions, and old artifacts unable to obtain the replacement login**. Disable reconnect/capability paths, separately confirm termination/drain of every old backend, inspect prepared work, and control restart controllers. The floor artifact alone receives a distinct restricted writer login. This is an operator/deployment requirement; new epoch checks protect participating stale work only.

LOGIN restrictions affect new connections; session termination must be confirmed separately. PostgreSQL documents [role attributes](https://www.postgresql.org/docs/17/role-attributes.html) and [backend termination](https://www.postgresql.org/docs/17/functions-admin.html). No role or session operations were executed here.

With one shared role, PostgreSQL cannot distinguish an old binary from a new binary holding the same credential. Full maintenance can stop and retire that shared identity, then introduce the distinct floor identity; leaving both running with it invalidates the fence. An owner/superuser login shared across artifacts is unsuitable for this proof. No additional database capability system is required if the operator can enforce this maintenance boundary.

| Old source of work | Fence / retained obligation |
| --- | --- |
| API, inbox consumer, settlement scheduler/manual path, payout/internal-outbox worker | Stop entry/claim loops, retire access and verify their sessions gone; floor validates policy and conditional claim generation. |
| Relay, RabbitMQ consumer and retries/DLQ | Stop old actors; stable queued commands are reinterpreted only by the compatible dispatcher against durable original intent, never assigned new keys. |
| In-flight database TX or stale session | Must finish before reconciliation boundary or be terminated/rolled back before activation; lease expiry alone is insufficient. |
| Prepared transaction | Resolve and include its effect in inventory, or keep activation blocked. No later legacy commit may remain possible. |
| Restarted old binary | Cannot receive floor login or reconnect through inherited writer capability; rehearsal must demonstrate refusal. |
| In-flight/unknown external request | DB retirement cannot undo Stripe execution. Preserve original command; unresolved outcome excludes that scope until trusted reconciliation. |

Rehearsal must prove an old waiting writer cannot commit after the observed boundary, a restarted old process cannot connect/write, a queued pre-cutover command cannot invoke wrong policy, and a lost ACK produces one compatible financial effect. This is ordinary isolated compatibility testing, not an access-control exploitation exercise.

## 7. Scope lifecycle and minimum authority

Recommend orthogonal state; these are recommendations awaiting approval, not selected policy changes.

| Field/evidence | Necessity and authority |
| --- | --- |
| `runtime_policy` | Required to select LEGACY versus CAPTURE_FIFO_V1; pause/review cannot erase the lawful writer. |
| `admission_mode` | Required to distinguish running, drain and safe pause without changing accounting policy. |
| `admission_epoch` | Required in this proposal for stale permits/activation and mode/policy ABA; increments only on guarded transitions. Does not fence incompatible binaries. |
| Existing evidence status / blocking records | Retain sticky review evidence; derive admission refusal from actual unresolved records. A status label alone is insufficient. |
| `evidence_revision` | Useful compact certificate invalidation for receipt/application/review changes. It may be omitted only if activation performs equivalent complete manifest revalidation under authority. Lot revision alone does not cover inbox, provider observations or pooled obligations. |
| Immutable certificate/baseline reference | Required transition proof: reviewed inventory, old-writer boundary, epoch/revision and operator approval. Do not require a fresh human certificate for every healthy ordinary active transaction. |
| Monotonic inbox/internal-outbox claim generation | Required for stale claim bookkeeping. Worker owner is optional if generation/status/identity suffice. Separate from policy epoch. |

Use existing audit links for transition/recovery history where sufficient. Preparation and reconciliation are milestones, not extra competing runtime enums. Do not add a leader-election service, per-service flags, cached balance authority or multiple mutable copies of certification state. The provider-account intake row solves unknown ownership; current single-account configuration does not justify a multi-account framework.

For the allowed transitions, the following is the minimum acceptance contract. `L` means own any operation-private wrapper, then intake in the needed mode, A/S; revalidate epoch/evidence with fresh statements. An operator transaction is a guarded application action, not an arbitrary status UPDATE.

| Transition | Preconditions | TX owner / locks | Admission while/after action | Durable proof | Failure/retry | Recovery |
| --- | --- | --- | --- | --- | --- | --- |
| LEGACY → preparation milestone | Explicit candidate scope and operator authorization | Operator inventory TX; L when binding a scoped baseline | No new-policy permission | Inventory/audit reference | Incomplete record is not a certificate | Repeat collection; preserve original evidence |
| RUNNING LEGACY → DRAINING | Approved drain boundary, compatible writer floor | Operator transition TX / L | Stop new intent/settle/payout; receipt and approved old obligations continue | Epoch++, reason/audit | Atomic rollback leaves prior mode | Crash leaves durable drain; operator resumes |
| DRAINING → reconciled milestone | Complete eligible inventory, no unknown legacy obligation, old-writer fence | Operator certification TX / L | Remains draining | Immutable manifest, epoch/revision/fence link | Intervening change refuses/stales proof | Recollect outside locks, revalidate |
| DRAINING LEGACY → RUNNING CAPTURE_FIFO_V1 | Current certificate, no blockers, tested floor/range/eligibility and explicit activation authorization | Operator activation TX / L | New policy begins only at committed transition | Policy, epoch++, certificate link, audit atomic | Failed TX leaves legacy/draining | After crash inspect committed record; never guess or reissue money |
| RUNNING → PAUSED | Operator decision or approved blocking-evidence rule | Guarded operator/evidence TX / L | Stop new spending/intents; retain receipt/review and accepted liabilities | Policy unchanged, epoch++, reason/audit | Retain prior state or complete pause atomically | Compatible reviewed recovery only |
| REVIEW_REQUIRED → reviewed clearance | Actual financial/no-effect proof and no other blockers | Resolver TX / L; exclusive intake when clearing unknown | No implicit resume/activation | Original references, correction/application linkage, actor and audit | Rollback preserves OPEN/review evidence | Repeat same resolution identity; recheck all blockers |
| PAUSED → RUNNING same policy | Current compatible deployment, blocker revalidation and proof/certificate where required | Operator resume TX / L | Existing policy resumes | Epoch++, new proof/reason/audit | Stale proof refuses | Remain paused until current proof |
| DRAINING/PAUSED LEGACY → RUNNING LEGACY | No new-policy durable commitment, valid legacy compatibility and resolved pause reasons | Operator abort/resume TX / L | Legacy may resume only on explicit approval | Abort proof, epoch++, audit | Cannot erase blockers by failed/forced resume | Remain paused or finish reviewed drain |

Migration defaults must remain LEGACY/dormant and create no certificate or logical ACTIVE scope. OPEN exception resolution does not automatically clear scope evidence status or resume admission. Policy downgrade after a new-policy reservation/candidate/effect is not an allowed transition in this plan.

## 8. Legacy reconciliation assessment

The proposal's matrix is conservative and appropriate. Initial cohort should be empty clean scopes or verified new captures with no later legacy effect, after complete locked validation. `NEW_CAPTURE` alone is not eligibility; later legacy writers may have changed the history.

| History | Required classification |
| --- | --- |
| LEGACY_ORIGINAL_ONLY or successful capture without trustworthy lot | Legacy/review until separately approved original ownership/terms/time reconstruction; no replay or current merchant configuration backfill. |
| Historical refund/dispute, including partial hold adjustment | Legacy/review; establish actual immutable source/fee/hold effects. No guessed FIFO attribution from aggregate counters. |
| Pending legacy settlement | Retain NULL policy/original candidate; drain only if reviewed legacy completion is financially correct. Known wrong completion cannot be used to empty a queue. |
| Completed legacy settlement | Legacy initially; reconstruct actual effects and later adjustments under separate review. Never post another settlement to mimic lot finality. |
| Pending payout or outstanding clearing | Verify accepted reservation/replay and drain compatible liability; unresolved obligation blocks activation. |
| Unknown provider result/retry/DLQ, unsupported financial receipt | Preserve original identity; reconcile trusted evidence or remain ineligible. ACK/DEAD/IGNORED is not proof of no effect. |
| Unreconciled allocations, contradictory ownership or dormant/legacy mixture | Review; fixtures and balanced journals do not certify exact business evidence. |
| Prior F01 misposting | Separately authorized compensating review; no history rewrite, balancing plug or manufactured allocation. |
| OPEN exception/unmapped intake marker | No new-policy activation/spending; proof-based resolution, then separate resume decision. |

Inventory covers every scoped payment, lot, allocation, journal contribution, provider observation, inbox, candidate and payout. Include pooled platform totals alongside owned merchant liabilities; NULL merchant platform accounts do not provide isolation. Current reconciliation notes are insufficient. D03 makes the pre-floor unsupported-evidence condition explicit.

## 9. Payout, failure recovery and rollback

The proposed payout guard uses the same intake/A/S authority, current policy/mode/blockers, exact bounded POSTED available balance, and atomic reservation journal/outbox/audit/idempotent response. Refund/dispute writers must join it before their debits/holds. Checking only one payment or lot cannot protect merchant/currency pooled available.

Refund/dispute or confirmed receipt first must affect/refuse the payout before its read/reservation commits. Payout first preserves its accepted liability; legitimately later confirmed money may create approved explained debt. Pending refund intent alone stays Option A neutral. These semantics must not be silently replaced with a universal future-refund hold.

F04 remains open until the actual policy-selected HTTP/callback paths prove the read-and-reserve interval across different payments. Green dormant-service races and a proposed wrapper are not F04 closure. Extending blockers to legacy payouts requires human approval and common locking by all legacy balance writers.

| Failure | Safe recovery |
| --- | --- |
| Crash before activation / stale certificate | Remain legacy/draining or paused; recollect/revalidate current proof. No migration or startup activates. |
| Crash during activation | Policy/epoch/audit/certificate association is one TX; inspect committed state and resume compatibly or retry the same transition. |
| Crash after activation commit | Preserve policy and pause if necessary; floor-compatible worker rereads admission. Never restart pre-floor writers. |
| Financial commit before ACK/response | Verify immutable saved effect/disposition under original identity and return replay; conditional claim failure update cannot overwrite it. |
| Candidate blocked by known evidence / exception | Preserve candidate ownership and original estimates; apply or review prerequisite, then recompute at completion. DEAD is not successful zero effect. |
| Changed valid allocations | Save actual applied revision/asset/release/hold; do not replace immutable selected evidence. |
| Structural/range-invalid candidate | Durable review; no delete/reassign/split/supersession is currently authorized. Oversized valid capture evidence is preserved. |
| Unknown evidence during maintenance | Retain unresolved marker, return 202 only after durable commit, leave activation blocked. |
| Old worker restart | Retired credential and session boundary prevent legacy commit; operational restart must not supply floor credentials. |
| Rollback after new-policy obligations/effects | Safe pause, retain policy, compatible artifact and reviewed recovery. Any financial repair appends approved compensation. Configuration rollback to legacy is invalid. |

The compatibility boundary begins with accepted new-policy reservations/outbox or candidates, even before a journal. Before any such durable commitment, preparation may be explicitly aborted after proof; after a new financial effect, rollback by a flag is certainly unavailable. This is narrower and safer than treating activation itself as a license to reinterpret old commands.

## 10. Recommended implementation sequence

First correct D01 in the proposal and obtain the human decisions below. Then separately authorize checkpoints. Each can be reviewed/committed independently with disabled/default-dormant behavior; that does **not** make each intermediate artifact safe to deploy beside incompatible writers.

| Checkpoint | Change scope | Dependencies | Required regressions | Acceptance criteria | Independently committable? | Runtime behavior changes? | Activation allowed? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A — schema/admission contract | Forward schema, permits, policy/mode/epochs, source identities, immutable correlation proof, claim generation and certificates; preserve 0000–0005 | Revised D01 contract and approved representation/ordering decisions | Fresh/valid upgrade/refusal/rollback, F02/deferred evidence, no active defaults; SQL proof ownership negatives | One authority; exact DDL locks/scans documented; no weakened evidence/history protections | Yes, dormant additive checkpoint after authorization | Schema only if adapters remain disconnected | No |
| B — receipt/correlation barrier | Signed financial relevance, atomic known/unknown markers, D01 application/SQL proof bridge, non-inbox observations, claim/disposition fences | A; approved unknown and receipt semantics | Both receipt/completion orders, unknown mapping, missing-ID full application, contradictions, stale claim/failure, command-result-before-webhook | Durable ordered receipt and proof consumed by both layers; no note/timeout clearance | Yes, reviewed staged checkpoint; production wiring waits for floor | Yes when receiver/processor enabled; old spending readers remain incompatible | No |
| C — coordinated policy dispatch | All controllers/handlers/jobs/manual calls, legacy wrappers, payment-first order, mirror validation, immutable command/batch policy | A/B; complete call-site inventory | Route/module selection, forbidden legacy fallback, stable-key replay, both-order implicit FK/header/account schedules | One complete compatibility artifact; no partial refund/dispute/mirror registration | Yes as small constituent commits; floor accepted together | Yes; legacy formulas preserved, ordering/dispatch change | No |
| D — payout/prerequisite handling | Approved scoped/legacy guards, exact current available reservation, accepted completion/internal-outbox fencing; separately reviewed F05/F06 prerequisites | A–C; explicit guard and audit-boundary choices | Actual cross-payment payout/refund/dispute/exception orders, both exception/receipt orders, capture terminal monotonicity, accepted refund under changing workflow | Active-path guard tests pass; no blocked accepted obligation erased; separate finding evidence recorded | Yes, separate focused prerequisite commits/reviews | Yes; new refusals require approval | No |
| E — legacy reconciliation/eligibility | Scoped inventory, proof/certificate/resume, blocked candidate recovery; explicitly exclude unsupported history | A–D, resolved D02/D03 contracts | Stale certificate, each legacy class, OPEN/no-effect/correction replay, range refusal, preserved candidates/journals | Only proven clean scopes eligible; uncertain scopes remain legacy/review; no inferred authority | Yes; initial implementation may exclude complex backfills | Operator admission/recovery paths; no automatic switch | No |
| F — fence and cutover rehearsal | Isolated maintenance runbook, distinct floor credential/session proof, all process classes/restarts/claims/unknown commands | Accepted A–E artifact and operator prerequisites | Old waiting TX/restart, shared-role refusal, prepared-work inventory, unknown provider outcome, crashes around activation, ACK loss | Demonstrated old-writer boundary and safe pause/recovery; range/legacy exclusions retained | Yes, runbook/test evidence checkpoint | Isolated rehearsal only | Only test scope transitions in explicitly authorized disposable rehearsal; no live activation |
| G — integrated acceptance | Real dispatcher/receipt/callback/payout paths, exact account oracles, PG17/18 evidence and configured CI; final human go/no-go | A–F complete and independently reviewed | All existing and new suites, signed HTTP companions, T01–T18, non-inbox evidence and D01 regressions, failure/restart evidence | No hidden skipped/red cases; limitations explicit; F01/F04 closure assessed separately on selected runtime | Yes, verification record checkpoint | Tests/docs; activation remains separate | No automatic activation; separate explicit environment/scope authorization required |

Development order A→B→C→D→E→F→G reduces ambiguous contracts. Operational enablement is one accepted A–D compatibility floor with fencing before any scoped activation; E's certificate is not permission to deploy incomplete B/C/D. E's read-only inventory work can run earlier once its evidence contract is fixed. Do not implement arbitrary legacy reconstruction merely to expand the first cohort.

Keep the six current F01 red reproductions intact during dormant/default-legacy checkpoints. Add separate policy-selected green acceptance coverage; do not weaken the old assertions to obtain a green command. Any later change to their status requires explicit ownership and accurate runtime closure evidence.

## 11. Human decisions awaiting approval

Recommendations below are not decisions made for the engineer. All listed choices require human approval before the corresponding implementation; none authorizes activation or financial repair.

| Decision | Options | Recommended choice | Technical rationale | Trade-offs | Risks | Human approval mandatory before implementation? |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Maintenance versus gradual rollout | Maintenance/drain; gradual per-scope migration after common floor | Maintenance first, selected proven scopes only | Few processes; explicit old-writer boundary is easier to prove | Mutation downtime and retained legacy scopes versus more routing/drain orchestration | Mistaking queue emptiness for provider/DB drain; gradual mixed-order exposure | Yes |
| 2. Policy/admission representation | Combined lifecycle; orthogonal policy/mode and transition evidence | Orthogonal policy/mode/epoch, existing evidence flags, revision-bound certificate; permit optional full-manifest substitute for revision | Pause preserves lawful writer; certificates detect new evidence without many phases | More explicit columns versus fewer ambiguous states; every writer must advance authority correctly | Competing mutable state/status caches drift | Yes |
| 3. Receipt/settlement ordering | Current one-time SELECT; shared transaction barrier | Shared local barrier; first admitted holder determines order | Prevents receipt commit inside final-check interval | Receipt may wait; late locally learned events apply on final sources | Confusing provider time/arrival with admitted receipt; ignored command observations | Yes; unsafe SELECT-only option is rejected |
| 4. Unknown provider correlation | Guess/ignore; scoped review when known; provider-account unknown barrier | Trusted immutable proof with D01 bridge, scoped review when known, temporary unknown barrier with owner/deadline | Cannot choose spending authority without ownership | Broad temporary new-policy refusal; human/provider lookup outside locks | Indefinite unresolved intake, or false clearance; whether legacy also blocks is still a choice | Yes |
| 5. Legacy eligibility | Broad inferred promotion; verified clean cohort; separately reviewed reconstruction | Verified empty/new-capture-only cohort; other classes remain legacy/review | Current dormant writers cannot lawfully consume arbitrary old history | Smaller cohort and manual reconciliation | Silent inferred FIFO/time/fee terms or draining known wrong settlements | Yes |
| 6. Payout blockers/exception scope | New-policy guard only; also guard legacy after coordinated floor | Guard new-policy whole merchant/currency; recommend approved legacy extension once all writers join | Available is pooled; known unapplied evidence is distinct from Option A pending intent | Conservative refusals affect availability; legacy admission extension changes behavior | Claiming quarantine before legacy guard exists, or inventing universal refund holds | Yes; decide legacy impact explicitly |
| 7. Old-worker fence | Epoch only; shared login/process stop; distinct floor login plus old-session retirement | Maintenance, distinct restricted floor identity, retired old capability/sessions/prepared work and controlled restarts | Old code does not read epochs; DB cannot identify version from shared credentials | Operator role/deployment setup and rehearsal | Old binary regains new login; idle session/prepared TX later commits | Yes; epoch-only option is rejected |
| 8. Irreversible recovery | Legacy flag rollback; compatible safe pause and proof-based recovery | Preserve policy/obligations, pause, compatible artifact, separately approved compensation | Journals and accepted allocation commitments cannot be erased | Longer reviewed recovery; no instant downgrade | New-policy effects interpreted by legacy writers or duplicate correction | Yes; flag rollback after commitments is rejected |
| 9. F04/F05/F06 boundaries | Treat cutover proposal as closure; separately scoped prerequisites and evidence | Keep all open; F05/F06 reviewed corrections before activation, F04 actual active-path races before closure | Current callbacks/workflow can invalidate certified or accepted evidence | More focused gates instead of broad fixes hidden in dispatch | Declaring green dormant tests sufficient or broadening accounting policy implicitly | Yes |
| 10. Hosted verification | Local PG18 only; configured CI without run; executed PG17/18 plus hosted/operational evidence | Execute PG17 and current CI before hosted cutover acceptance; stage signed/mocked transport then separately authorize test-mode external rehearsal if needed | Existing local proof does not cover target PG17, deployment or broker/provider failure boundaries | Time/setup; local design work can continue with honest limitations | Fake CI/provider claims; starting live credentials as verification shortcut | Yes; any external environment activity needs separate authorization |

An implementation authorization should name the selected options, scope and acceptance checkpoint. It must not imply permission for production mutation, live payments, remote push or broad legacy repair.

## 12. Verification and disposition

This is static design review, including direct code/SQL reading, ordinary transaction traces and prior test-evidence inspection. No PostgreSQL experiment, financial test rerun, provider call, broker run, migration, role/session change or cutover was performed.

Historical B3.1 evidence was inspected, not rerun: saved Jest JSON contains 290 baseline cases passed/0 failed/0 pending across eight suites, 44 integrated cases passed/0 failed/0 pending, and F01 six failed/0 pending. The six pending regressions remain in source behind explicit RUN_DB_TESTS/RUN_F01_PENDING opt-ins. B3.1 records lint/typecheck/build passing and 50 unit cases; those commands were not rerun here. PG18.6 is the recorded executed database; PG17 and hosted CI remain unexecuted. Stripe/RabbitMQ/Redis operational failure boundaries remain unverified.

Executed review checks:

- `node .tmp/validate-docs.cjs`: passed 37 Markdown files and 478 relative links/anchors; CI YAML parsed and expected structure checked. It extracted 19 Mermaid blocks, without parsing or rendering them. No new diagram was added.
- `git -c safe.directory='C:/Work/Learning Projects/learn-fintech' diff --check`: passed. Git's existing LF/CRLF notice creates no noisy content diff and no normalization was performed.
- Inline Node assertions: passed review-document final newline/trailing-whitespace checks, 12 sections, seven complete checkpoint rows and ten complete human-decision rows. Untracked document whitespace is checked separately because ordinary Git diff checking excludes it.
- SHA-256 preservation check: proposal remained `C965B1CF290AC1109F3C3EB32F1F5182E288E31F955255F8E76698E9F61B20B6` before/after review. Final scope inspection contains only the existing proposal/index work, this review record and its index link; no financial source/test/migration changes.

**Disposition:** revise the correlation/evidence contract in Run A, retain the workable maintenance/admission/fencing direction, then resubmit for design acceptance and explicit human choices. F01 and F04 remain unresolved. No B3.2 implementation, commit, push or activation has begun.

## 13. Run A.1 author response — acceptance still pending

Added 2026-10-11 after the independent review. Sections 1–12, their verdict, D01 finding and historical verification remain unchanged. This is the author's proposed correction disposition, **not** another independent review or an approval.

**D01: OPEN — CORRECTION PROPOSED, AWAITING INDEPENDENT REVIEW.** The [Run A.1 corrective revision](h1-fix-02-b3-2-runtime-cutover-design.md#21-run-a1-corrective-revision-trusted-correlation-evidence) proposes preserved signed/normalized receipt plus one sealed proof, an immutable provider-object owner, and one shared SQL effective-evidence reader used by services and immediate/deferred constraints. It explicitly identifies the 0004 replacements, financial proof FKs/revisions, original-field contradiction rules and final effect/disposition linkage. Historical valid effects remain protected without fabricated receipt verification; new applications cannot use a permissive payload-only fallback.

The proposed E01–E28 regression matrix covers missing-ID receipt→proof→service→SQL application, contradiction/ownership/amount negatives, normal SQL constraints, rollback/replay and deterministic admission/correlation schedules. None is implemented or executed here. A–G checkpoints now include the proof/migration/dispatch dependency, trust capabilities and conservative legacy exclusions. Original maintenance/drain/fence/payout/recovery policy remains proposed.

D02's non-inbox source identity remains a mandatory A/B elaboration: immutable owned command-result/reconciliation observation, stable source key and genuine-webhook application linkage. A mutable mirror alone is explicitly insufficient. D03's old unsupported/ignored-evidence inventory remains an E condition; missing signed bytes or ownership does not become trusted through migration. These follow-ups are not marked resolved by this response.

Author handoff: **DESIGN_READY_FOR_REVIEW**. Independent reviewer must assess the shared SQL semantics, historical compatibility guard, proof/binding/receipt privileges, lock order and evidence/disposition guarantees before changing D01 or the review verdict. All human decisions and implementation/activation authorization remain pending. F01/F04/F05/F06 stay open under their existing gates. No financial code, migrations, tests, activation, deployment, commit or push changed in Run A.1.

Author documentation checks: 37 Markdown files/489 relative links and anchors passed; CI YAML structure checked, 19 Mermaid blocks extracted without parser/rendering. Tracked Git diff checking plus direct untracked whitespace/structure checks passed; byte-prefix hashes preserve both original records. Initial inline heading/section matcher errors were corrected before the passing rerun. No financial/CI test execution is claimed by this response; detailed commands/limits are in the appended revision.

## 14. Run A.1 independent correlation-evidence acceptance review

Reviewed 2026-10-11. Latest verdict: **DESIGN_APPROVE_WITH_DECISIONS**.

**D01: RESOLVED AT DESIGN LEVEL; IMPLEMENTATION UNVERIFIED.** Sections 1–13 retain the original review and author response. This section accepts the corrective contract in [section 21](h1-fix-02-b3-2-runtime-cutover-design.md#21-run-a1-corrective-revision-trusted-correlation-evidence), subject to its explicit human decisions and implementation gates. It does not approve runtime activation or mark F01/F04/F05/F06 fixed. No remaining P1 design defect was identified in this focused review.

### 14.1 Inspected state and verified source assumptions

Branch `main`, HEAD `052421a6c90b4aadbcde957ef4e5268c7632a124`. Initial dirty worktree: existing docs index modification and the two untracked B3.2 design/review records. This review appends only this section; the proposal, original review/author response, index and executable files are preserved.

Read repository instructions, routing/workflow/index/overview, approved Run A/B1 policy, B3.1 evidence, original B3.2 proposal/review and the A.1 revision. Rechecked receiver, processor, normalizer, business correlation/mirror writes, command-result bookkeeping, dormant refund/dispute services, hold reductions, schema and SQL 0000–0005. These facts substantiate the corrective adapters:

| Current executable evidence | Assessment |
| --- | --- |
| [Receiver](../../apps/api/src/webhooks/webhook-receiver.service.ts), lines 21–36; [inbox schema](../../apps/api/src/database/schema.ts), lines 115–121 | SDK verifies supplied raw bytes, but persisted normalized payload/signature/headers omit those bytes and a restricted durable attestation. The revision accurately identifies new storage/trust work; it does not mistake existing inbox rows for independently authenticated history. |
| [Normalizer](../../apps/api/src/webhooks/stripe-event.normalizer.ts), lines 44–76; [business correlation](../../apps/api/src/webhooks/webhook-business.service.ts), lines 48–97 | Optional metadata can leave owner/refund IDs absent; unsupported normalization can discard object data. Latest PI/Charge/object matching and transient enrichment are real current behavior, and cannot satisfy the proposed authoritative contract. |
| [Refund service](../../apps/api/src/refunds/capture-refund-accounting.service.ts), lines 82–113 and 127–172; [dispute service](../../apps/api/src/disputes/capture-dispute-accounting.service.ts), lines 31–72 and 191–204 | Both currently consume original payload ownership. Refund checks accepted key/frozen capture references; dispute checks owned PI or qualified capture/Charge evidence. These financial checks must survive the shared-reader adapter, including replay checks before early return. |
| [0004](../../apps/api/drizzle/0004_capture_accounting_foundation.sql), lines 293–342 and 391–468 | Immediate refund checks read original IDs/type/currency; deferred checks separately read original amount. Dispute allocations lack open/close inbox references. Updating application correlation alone cannot close D01. The revision names both function replacements and the missing financial references. |
| [Provider mirror schema](../../apps/api/src/database/schema.ts), lines 93–106; [0001](../../apps/api/drizzle/0001_lively_fabian_cortez.sql); [command handler](../../apps/api/src/payment-commands/payment-command-handler.service.ts), lines 19–38 and 73–87 | Current uniqueness is provider/key, not external object ownership. Result fields are mutable, and bookkeeping creates no inbox. An immutable object owner and trusted result observation are justified additions, rather than assumptions about the existing mirror. |
| [Processor](../../apps/api/src/webhooks/webhook-processor.service.ts), lines 20–25 and 33–45; [0005](../../apps/api/drizzle/0005_refund_accounting_exception.sql) | Current dispatch passes payload and overwrites final disposition; failure is not generation-fenced. 0005 only adds ACCOUNTING_EXCEPTION. Coordinated dispatch/claim changes remain mandatory; the new design does not claim they exist. |

### 14.2 D01 acceptance and SQL contract

The original failure is resolved at the design level because section 21.5 specifies one SQL-produced effective projection, and section 21.6 identifies every affected immediate/deferred adapter. Missing optional metadata can now be supplied from validated provenance without rewriting the original event or leaving PostgreSQL with a conflicting payload-only interpretation.

The four boundaries are distinct: SDK authenticates original receipt bytes; restricted publishers persist that attestation and immutable observations; SQL seals owned correlation from validated references; the current claim and intake/A/S permit authorize financial application. None alone proves that money has been applied. PostgreSQL validates the trusted input lineage and structural/financial relationships, rather than pretending to perform Stripe HMAC verification.

| Evidence situation | Required service and PostgreSQL result |
| --- | --- |
| Optional owner/refund ID absent, otherwise authenticated confirmed event | Fill only absent fields from the owned command/capture/object chain; both consumers use the same event/proof revision. An absent required witness remains unresolved. |
| Explicit IDs agree | Preserve original values and validate them through the same reader. Complete new payloads do not receive a proof-free alternate path. |
| Explicit ID, PI/Charge, amount/currency or outcome contradicts provenance | No seal/application by overwriting the contradiction; preserve claimed and canonical references in durable review. |
| Unverified receipt/result or caller assertion of VERIFIED | Checked publishing/sealing capabilities reject it. Matching PI or a mutable mirror alone is insufficient provenance. |
| Different inbox, nonexistent/stale proof revision, wrong owner/operation/cause | Composite references and explicit reader comparisons reject the application, including ordinary SQL finalization. NULL is not a successful equality check. |
| Previously finalized valid complete-payload history | Original strict validation remains, without fabricated raw bytes, authenticity or proof. Saved journals/allocations/references stay unchanged and do not acquire activation eligibility. |

The contract is implementable through typed SQL routines, owned composite references, protected evidence-format metadata and immediate/deferred triggers. The eventual DDL must enforce the stated implications in both directions, including a new financial effect with an absent allocation/application group; merely validating rows when an application link happens to exist is insufficient. This is an implementation acceptance condition under section 21.6(3), not a new policy or a demand for completed SQL in this design run.

Required forward work after 0005: receipt/attestation protection; immutable result observations and provider-object owner; sealed proof and referenced owned tuples; protected historical version0/new version1 split; replacement of `prepare_capture_allocation_write` and `check_capture_allocation_effect`; dispute open/close and hold-cause evidence references; deferred effect/workflow/audit/inbox linkage; privileges and deletion/TRUNCATE protections. Preserve capacity, exact cumulative fees, whole-operation/common-journal checks, parent version writes and F02 sealing. No edits to 0004/0005 and no historical monetary rewrite are proposed.

Required adapters: receiver/normalizer retain original evidence; correlation uses checked SQL sealer/reader; refund/dispute and hold helpers accept TX/permit/inbox/proof identity; dispatcher honors service disposition; claims and failure updates use generation checks; command-result/reconciliation publishers record durable source identity. Dormant ACTIVE assertions must be replaced with the common permit at the coordinated floor. Old payload-only services cannot be enabled alongside version1 finalization.

### 14.3 Provenance, replay, exceptions and locking

Refund provenance requires the accepted refund, canonical command/key, exact provider refund object, amount/currency and frozen capture attribution. A metadata refund ID can identify that chain without payment/merchant metadata; without refund ID an immutable trusted result must link the exact object to the accepted command. Disputes use signed dispute identity and uniquely owned capture/PI/Charge evidence; no fictitious accepted dispute command is introduced. The provider/account/object-kind/object-ID binding supplies missing cross-event ownership uniqueness without making a shared PI unique per capture.

A proof becomes authoritative when its first validated seal commits. Before that, immutable observations and attempt revisions can evolve. After sealing, there is no owner-changing v2, including before financial application; a bad sealed interpretation requires separate human review. New contradictory evidence preserves the proof and historical journal, blocks pending admission and creates review. Financial application must name the exact fixed proof revision. Replay verifies saved proof/ownership/effects/disposition before returning, and distinct duplicate event IDs retain the first applied financial reference. Deletion, retargeting and replacing an applied proof are forbidden.

Missing prerequisites/delayed enrichment remain retryable unresolved evidence, not a fabricated terminal failure. Confirmed contradiction retains original/conflicting identifiers and idempotent exception/blocker, with no guessed journal, partial finalization or reservation release. Unknown ownership uses the proposed unscoped intake review; it cannot fake a merchant for existing scoped exception FKs. Review ownership/deadline and guarded financial/no-effect clearance remain explicit operator decisions. A legitimately later post-settlement result uses actual finalized sources; an already-applied effect is reviewed without erasing it.

The revised order is conditionally compatible: one private inbox → chosen intake lock mode → A/S and fresh authoritative reads → payment NKU/children → validated mirrors and lots/allocations → one immutable object binding/proof → journal/effects/audit/disposition. Sealing can be a separate transaction; application must revalidate current admission/identity. No proof UPDATE lock, other operation's inbox lock after scope, second-scope acquisition on a binding conflict, intake SHARE upgrade under A/S, or provider call while holding financial locks is permitted.

No unavoidable new lock cycle was found statically. This is not executed deadlock-freedom evidence: unique/FK waits, queued deferred checks and shared platform-account creation need the proposed schedules. Current mirror→child, attempt→payment and legacy financial reverse edges still require coordinated checkpoint C; existing binaries cannot partly adopt this order. Receipt/settlement cutoff, payout guards, scope epochs, private claims, old-worker fencing and irreversible-commit recovery remain compatible with the correction and remain future gates.

### 14.4 Regression-plan assessment

E01–E28 cover the D01 invariant families; no missing P1-level design regression was identified. They are **28 planned case groups**, not 28 executed tests or necessarily 28 individual Jest cases. E01–E06 explicitly repeat for failure and dispute variants; migration cases and original T01–T18 remain additional obligations.

The two-column matrix compresses some required assertions. The review interpretation below makes initial state, action, committed result, PostgreSQL assertion and forbidden state explicit. `U` means the actual owned G10000/F300/N9700 capture, no adjustment; pending refund5000 result is PSP5000/pending4850/fee-refunds150 (fee revenue300); settled-source result is cash5000/available4850/fee-refunds150. All comparisons include original receipt hashes and owned financial rows, not just balanced totals. These are planned acceptance assertions, not observed results.

| Case | Initial state | Action | Expected committed result | PostgreSQL assertion | Forbidden state |
| --- | --- | --- | --- | --- | --- |
| E01 | U, accepted reserved refund, signed success missing optional IDs | Receive without sufficient owned witness | Original receipt/blocker; U unchanged | Original hash, marker and RESERVED rows; zero REFUND journals | Guessed owner, release, false PROCESSED |
| E02 | E01 plus trusted exact-object/command observation | Seal under authority | One owned immutable proof/binding; no money yet | Unique inbox proof and object owner; exact provenance FKs | Latest-PI selection or speculative journal |
| E03 | E02, current claim/permit | Invoke actual service with inbox/revision | Exactly one successful refund application | Actual service result and saved event/revision on all effects | Service-only alternate interpretation |
| E04 | Valid owned proof, reserved allocations | Finalize through immediate and deferred SQL checks | Same coherent application | Force deferred checks/commit; compare reader and every reference | Raw-payload rewrite or trigger fallback |
| E05 | U or legitimately finalized capture, proof/reservation | Apply refund5000 | Exact source-specific journal, fee150, state/audit/inbox | Account lines, complete group, one POSTED journal and linkage | Wrong source, fee or partial group |
| E06 | Applied E01–E05 variant or supported no-journal outcome | Redeliver/reprocess same and distinct duplicate event IDs | Original financial effect/no-effect once; distinct event may have its own proof | Same-ID proof count fixed; business effect counts/hashes and first-applied refs unchanged for both | New business journal, proof replacement or repeated financial audit |
| E07 | U, explicit merchant disagrees with canonical owner | Correlate/apply | Review/exception, U unchanged | Conflict records retain both IDs; no finalized effects | Enrichment overwrites merchant |
| E08 | U, original PI differs from frozen capture | Seal/apply | Conflict retained; no application | No accepted proof/effects; immutable original references | Changed PI or capture attribution |
| E09 | U, mirror for another refund/key sharing PI | Resolve using that mirror | Unresolved without witness, exception on owned contradiction | Exact mirror/key provenance and durable classification | Mirror alone authorizes money |
| E10 | U, external object belongs to different payment | Seal conflicting owner | Immutable owner retained; review only | Owned binding/FKs; no cross-payment entries | Object retarget or cross-owner journal |
| E11 | U, incompatible/malformed amount or currency | Seal/apply each negative variant | No adjustment; review/refusal | Financial fingerprint unchanged; exact numeric/identity checks | Rounding or invented amount/currency |
| E12 | Two candidate owners/scopes for one object | Resolve concurrently and ambiguously | One immutable owner, conflicting evidence retained; no guessed effect | Unique-key wait and final owner/conflict rows | Two bindings or second-scope financial mutation |
| E13 | Unauthenticated fixture/ordinary financial role | Publish attestation or self-assert proof using ordinary SQL | Refusal; no new authority | Actual grants/routine checks and zero unauthorized rows | Caller VERIFIED flag succeeds |
| E14 | Sealed proof before application; companion after application | Update/delete/truncate or add contradictory observation | Proof fixed; contradiction blocks/reviews | Protection errors and unchanged proof/effect references | Replaced proof or historical evidence deletion |
| E15 | Existing confirmed contradiction | Repeat same observation | One exception/blocker, new observations only if distinct | Unique evidence keys and no money/audit duplication | Overwritten conflict or duplicate financial effect |
| E16 | Reserved/planned allocation, no proof | Finalize/insert final evidence with absent proof, explicit version0 or NULL | Transaction rejected; no applied money | BEFORE/constraint rejection and whole-TX snapshot | Historical-format bypass |
| E17 | Valid inbox/proof plus other inbox or invalid revision | Reference wrong tuple/revision | Transaction rejected | Composite FK/reader error; no committed application | Same inbox with nonexistent/stale revision accepted |
| E18 | Valid proof for another scope/operation/cause | Ordinary SQL applies incompatible reference | Transaction rejected | Independent SQL owner/type/cause comparisons | Cross-merchant/payment/currency or cause mismatch |
| E19 | Valid finalized history and new fully identified signed receipt | Fresh install/upgrade, then lawful new application | Old monetary evidence preserved; new path uses proof | Historical hashes/IDs; new refs and zero active scopes | Fabricated old verification or proof-free new effect |
| E20 | Valid proof and intended complete operation | Write partial/mixed group, wrong journal/fee/outcome or missing final link | Commit rejected, whole application rolled back | Force deferred checks; snapshot all financial/state/audit rows | Orphan new effect, false APPLIED or partial finality |
| E21 | Separately committed original receipt; optionally prior sealed proof | Abort sealing/application transaction | Original/blocker remains; only prior truthful proof may remain | Before/after hashes and zero committed financial delta | Receipt loss or orphan applied effect |
| E22 | Valid proof and unprocessed accepted operation | Fault after journal/first allocation/hold, then retry | First TX no effect; retry applies once | No first-TX rows/state/audit; one final complete group | Partial first effect or duplicate retry journal |
| E23 | Processing claim later reclaimed | Compete application and stale failure bookkeeping | One final effect/disposition | Old generation UPDATE affects zero rows; complete linkage | APPLIED downgraded to DEAD/RETRY |
| E24 | Unresolved receipt and resolver/apply contenders | Gate both acquisition orders | Incomplete proof cannot apply; sealed revision applies once | Backend wait plus exact committed proof/effect tuple | Application uses transient correlation |
| E25 | Resolver and scope transition share baseline | Gate both acquisition orders | Evidence revision stales certificate or new epoch forces readmission | Locked epoch/revision/certificate and no stale effect | Silent policy/owner reinterpretation |
| E26 | U/reservation/candidate, confirmed receipt and completion | Gate both acquisition orders | Receipt-first blocks; completion-first finalizes then refund uses cash | No marker commit inside protected interval; exact accounts | Full completion despite pre-admitted blocker |
| E27 | Payoutable scope and new confirmed contradiction | Gate both acquisition orders | Conflict-first denies; payout-first liability remains and later spending blocks | Reservation/outbox/audit or refusal; scoped blocker | Erased payout liability or post-conflict admission |
| E28 | One unresolved event, two resolvers | Gate first sealer before commit | One proof/revision/owner, or durable review | Inbox wait; uniqueness and unchanged final references | Incompatible seals or hidden deadlock retry |

Minor elaborations before implementing tests: expand E06 into separately asserted missing-metadata refund failure, dispute open/win/loss, zero-funded opening and zero-release win; execute E14 both before and after application, including finalized financial reference retargeting; make E17's same-inbox nonexistent/stale revision distinct from its wrong-inbox case; include E20's completely absent effect/application group and multiple writes to one row before deferred checking. E12/E24–E28 require observed waits and both orders, not random concurrency.

D02 also needs its already-required A/B companion: trusted confirmed result commits before callback and blocks spending; later genuine webhook applies once and clears the linked obligation; note-only resolution cannot clear it. This supplements the correlation suite rather than marking D02 implemented. Migration variants must exercise existing final/RESERVED/PLANNED/OPEN rows, unavailable raw bytes, complete legacy unapplied receipts, refusal/rollback, default/NULL/version guards and ordinary-role grants. Existing six F01 regressions and F02 assertions remain intact.

### 14.5 Decisions and first implementation checkpoint

Human choices remain exactly pending: maintenance/drain; orthogonal policy/mode/epochs; local receipt cutoff and Option A later-debt semantics; unknown-owner intake barrier and its legacy impact/review owner; common dispatcher/claim floor; legacy payout guards; separate identities/session/restart fencing; eligible first cohort and historical exclusions; bounded candidate recovery; proof-based exception resolution/separate resume; F04/F05/F06 gates; staged external/hosted verification. A.1 additionally recommends the sealed-proof/shared-reader model, restricted receipt/result publishers, immutable object owner and protected historical evidence-format split. No accounting overlap or pending-refund policy was newly approved by this review.

First independently committable implementation checkpoint, **after separate authorization**, is **A: evidence contract and forward schema with isolated PostgreSQL acceptance tests**. Review actual keys, historical guards, SQL projection, protection/grant semantics, affected trigger replacements and DDL lock/rollback bounds. It must create zero active scopes, retain legacy routing and remain a non-deployment checkpoint until B/C compatibility is complete. Exact DDL may justify separating additive dormant storage from enforcement installation; it cannot use a temporary constraint bypass or enable incompatible partial writers.

One wording detail to settle in that privilege review: section 21.5's optional SECURITY DEFINER sealer needs narrowly scoped SELECT access to the owned evidence it revalidates. Interpret the stated absence of ledger privileges as **no ledger write privileges**, not denial of all reads needed to validate original journals. Require explicit grants, protected inputs/pinned paths and no INSERT/UPDATE/DELETE/TRUNCATE authority over financial history. This is a P2 privilege-specification clarification, not a blocker to the proposed invoker/shared-reader design.

D01 is design-resolved; D02/D03 remain implementation/inventory conditions. F01 remains unresolved because runtime dispatch is still legacy, no scope is active and the six financial regressions remain red. This approval authorizes no implementation, migration execution, activation, cutover, deployment, commit or push.

### 14.6 Review verification and limits

Executed for this documentation-only acceptance:

- `node .tmp/validate-docs.cjs`: passed 37 Markdown files, 502 relative links/anchors and CI YAML parsing/structure. Extracted 19 Mermaid blocks; no Mermaid parsing/rendering.
- `git -c safe.directory='C:/Work/Learning Projects/learn-fintech' diff --check`: passed for tracked work in PowerShell. A separate Command Prompt attempt failed to parse the quoted Git configuration argument; the corrected PowerShell rerun passed. Direct inline Node checks cover both untracked documents' trailing whitespace/final newline/LF consistency and the review's 28 consecutive cases with five required test fields.
- Inline Node SHA-256 preservation checks: all 46916 pre-review bytes of this record unchanged (`25f65e724dcf7b4fe56d36bf7954b1cc7f1fd42b5fe41fd97f593b02bb5735f8`); full proposal unchanged (`efcc0b4d6f9d1de480489cc0960b5536627e3ffc12bdf516af5a4d6f9cf83814`); docs index unchanged (`2f0dffbd7cdb6c44aaf45ef1677c512e3a7e9939f65d4eb1ec3dbf3c984b8b66`). Manual appendix/scope review and Git status show only this appended review in this run; inherited index/design changes remain. An initial source search used an incorrect 0003 filename; the corrected `0003_pin_ledger_function_context.sql` was read successfully.

No database was started, migration applied, signature tested, provider/broker contacted or financial suite rerun. Inspected historical B3.1 JSON reports still record baseline290/integrated44 passes and six F01 failures, all with zero skips; these are historical evidence, not results of this review. Proposed SQL/grants, authentication, FK/unique waits, deferred disposition and runtime dispatch remain unimplemented and unverified. PG17, hosted CI, live/test-mode provider, RabbitMQ/Redis, production inventory and operational fence evidence remain future gates.
