# H1: money representation and financial correctness

Status: historical audit.

Audit date: 2026-10-07. Reviewed branch: `main`, commit `0bf43b202174de83aa29739471916920b4e42f09`.

This is an evidence record for that revision, not a replacement for the feature documents routed by [AGENT_START_HERE](../AGENT_START_HERE.md). Findings and checks below preserve the original audit evidence. F02 has a subsequent [fix record](h1-fix-01-posted-ledger-immutability.md); the other findings remain open. The original audit run changed no application code, schema, migrations or committed tests. Amounts below are integer minor units unless stated otherwise.

## 1. Executive summary

The normal capture/refund path has useful transaction, locking and uniqueness protections. However, balanced journals do not guarantee correct allocation of funds, and the database does not fully seal a posted journal. The audit confirmed ten issues, with the most urgent three being:

1. **F01 — H1 / Critical:** settlement releases the original capture net after refunds or dispute holds, creating payoutable available funds with an offsetting negative pending liability.
2. **F02 — H1 / Critical:** a posted journal accepts additional balanced entries. A separate, explicitly qualified SQL interleaving can also leave a posted journal unbalanced.
3. **F04 — H2 / High:** payout reservation serializes against other payouts, but a refund can change the balance between the payout's read and posting.

Other confirmed issues concern arithmetic precision, non-monotone capture failure handling, accepted refund completion during a later capture, zero-net settlement, currency formatting, account semantics and DTO coercion. Section 6 distinguishes conditional defects and unresolved accounting policies from established runtime bugs.

The existing checks pass: typechecking, 34 unit tests and five PostgreSQL integration tests. Twenty additional temporary scenarios established both defects and working protections. Their assertions verify observed behavior, including incorrect behavior; their passing result does not mean financial correctness passes.

## 2. Current financial model

The inspected runtime is a NestJS modular monolith with raw `postgres` queries. PostgreSQL is the durable financial authority. Stripe is the current `PaymentProvider`; RabbitMQ transports provider commands from the transactional outbox. Redis/BullMQ schedules internal work. Neither queue owns balances or financial uniqueness.

Stripe API responses update provider mirrors; durable webhook inbox processing applies internal business effects. Settlement and payout are **internal lab accounting**, with synthetic completion references. They do not execute Stripe settlement or external bank transfers. This distinction matters when assessing recovery and cash classification.

The chart of accounts in [LedgerService](../../apps/api/src/ledger/ledger.service.ts) and [ledger documentation](../ledger.md) is:

| Account | Type and normal balance | Scope |
| --- | --- | --- |
| `PSP_CLEARING` | Asset, debit; provider receivable | Platform/currency |
| `PLATFORM_CASH` | Asset, debit; internal settled cash | Platform/currency |
| `MERCHANT_PENDING` | Liability, credit | Merchant/currency |
| `MERCHANT_AVAILABLE` | Liability, credit | Merchant/currency |
| `PAYOUT_CLEARING` | Liability, credit; reserved payout | Merchant/currency |
| `DISPUTE_CLEARING` | Liability, credit; dispute hold | Merchant/currency |
| `PLATFORM_FEE_REVENUE` | Revenue, credit | Platform/currency |
| `PLATFORM_FEE_REFUNDS` | Expense, debit | Platform/currency |

For gross capture `10000` and fee `300`, capture debits clearing `10000`, credits pending `9700` and credits revenue `300`. Settlement debits cash/credits clearing for gross and debits pending/credits available for net. Payout reservation moves available into payout clearing; completion debits payout clearing and credits cash. Refunds create new compensating journals rather than editing capture entries.

### Business state and financial boundaries

| Boundary | Business effect | Journal and atomicity | Recovery/limitation |
| --- | --- | --- | --- |
| Authorization request/success | Attempt and authorization state/amount | No financial journal; acceptance commits intent, outbox, audit and idempotency response together | Stable provider key; inbox retries prerequisite/infrastructure failures |
| Capture request | Attempt plus `CAPTURE_PENDING` | No capture journal at acceptance | Payment row lock and remaining-authorization check |
| Capture confirmation | Attempt success, captured total and fee | `CAPTURE` journal, workflow updates, audit and inbox disposition in one processing transaction | Success guard plus business key; F05 breaks the guard after a stale failure |
| Refund request | Pending refund reserves refundable amount | No financial debit yet; intent/outbox/audit/replay are atomic | Pending/processing/successful refunds count against further requests |
| Refund confirmation | Refund success and cumulative refunded total | `REFUND` journal and workflow changes in one transaction | F06 can reject already accepted evidence; all local effects then roll back |
| Dispute open/close | Hold/outcome and payment status | `DISPUTE_OPEN`/`DISPUTE_CLOSE` and state/audit in one transaction | Close-before-open retries; negative liabilities are explicitly allowed for disputes |
| Settlement generation | Batch and capture items | No settlement journal yet | Attempt locks and unique capture items; F01 ignores financial adjustments |
| Settlement completion | Batch success | `SETTLEMENT` journal and completion/audit in one transaction | Settlement row lock and success guard; F07 blocks zero-net batches |
| Payout request | Pending payout and available reservation | `PAYOUT_RESERVATION`, intent/outbox/audit/replay in one transaction | Advisory lock protects competing payouts, not all balance writers |
| Payout completion | Lab payout success | `PAYOUT_COMPLETION` and payout update in one transaction | Payout row lock and business key prevent repeated completion |

[InternalOutboxProcessorService](../../apps/api/src/outbox/internal-outbox-processor.service.ts) marks its outbox row after the completion transaction. A crash between those commits permits another execution; row/status and journal guards protect the ordinary duplicate path. Bounded failure can leave a dead command and reserved payout funds. No payout failure/release workflow or external unknown-outcome protocol is implemented. This is a capability limit, not evidence that a real transfer failed to release funds.

Payment state, provider state and ledger state are separate records. Captured is not settled, and settled is not paid out. Some handlers nevertheless use one global payment status to gate independent operations; F05 and F06 demonstrate the resulting inconsistencies.

## 3. Money representation trace

There is **no coherent end-to-end safe range**. Individual HTTP amounts are capped at `Number.MAX_SAFE_INTEGER` (`9007199254740991`), but intermediate products, ledger/account aggregates, direct database inputs and UI conversion are not protected by that cap.

| Stage | Actual representation and behavior | Consequence |
| --- | --- | --- |
| HTTP/DTO | [CreatePaymentDto/CapturePaymentDto](../../apps/api/src/payments/dto/create-payment.dto.ts), [CreateRefundDto](../../apps/api/src/refunds/refunds.dto.ts) and [CreatePayoutDto](../../apps/api/src/payouts/payouts.dto.ts): `@Type(() => Number)`, integer/min/max validation | Validates the converted value, not the original token; see F10 |
| Currency input | Three uppercase letters; no USD-only restriction or currency allowlist | Does not define which currencies or amount conventions are supported |
| Services | Money strings become `Number(...)`; ledger lines, provider port amounts and JSON command amounts are numbers | Individual safe integers do not make multiplication or accumulation exact |
| Capture fee | `floor(newCaptured * fee_bps / 10000) + fixed_fee_minor`, capped at captured amount; per-capture fee is cumulative fee minus prior fee | Number multiplication can change the rounded fee; fee configuration is read at confirmation |
| Refund fee | `floor(totalFee * cumulativeRefund / capturedAmount) - alreadyAllocated` | Correct cumulative formula in exact arithmetic; safe input checks do not protect its product |
| SQL parameters | Raw `postgres` serializes numbers; no custom monetary parser or exact-integer wrapper | PostgreSQL stores the already rounded number if precision was lost in JS |
| Storage | Money columns are signed PostgreSQL `bigint`, maximum `9223372036854775807`; aggregate sums use PostgreSQL `numeric` | DB range is wider than the application range; no general JS-safe database cap |
| Driver results | Runtime [DatabaseService](../../apps/api/src/database/database.service.ts) uses the default driver types. Local probe returned both `int8` and `numeric` as exact strings | The driver is not automatically rounding these values; later `Number` conversions are |
| Drizzle schema | [schema.ts](../../apps/api/src/database/schema.ts), line 28: `bigint(..., { mode: 'number' })` | Latent unsafe ORM mapping; current financial queries use raw SQL, not this ORM mapping |
| Reads/JSON | Payment, refund, settlement, payout and balance reads commonly use `::text`; accepted mutation responses and command/audit metadata contain numbers | Exact read strings survive JSON, but there is no uniform monetary API type. No current native-JS-`bigint` JSON serialization failure was found |
| UI | [formatMoney](../../apps/web/lib/api.ts), line 17, converts strings to `Number`; divides by 100 except JPY/KRW/VND | Loses large integer precision and applies an incomplete currency scale rule |

The audited financial calculations use `Number` and `Math.floor`; `parseInt`/`parseFloat` were not found to be a separate monetary calculation path. PostgreSQL's exact sums and deferred checks remain valuable, but cannot recover an amount rounded before it was sent to SQL.

Stripe receives the provider command's integer amount without a general exponent conversion layer. Its documented minor-unit and special-case rules must therefore be part of an explicit supported-currency contract. CLP is listed as zero-decimal, yet the current formatter divides CLP by 100. [Stripe currency amount rules](https://docs.stripe.com/currencies#zero-decimal-currencies).

## 4. Accounting invariant map

| Invariant | Application protection | PostgreSQL protection | Evidence and remaining gap |
| --- | --- | --- | --- |
| One positive side per entry | `assertBalanced` checks positive side and safe integer | `ledger_entry_one_side_check` excludes zero/negative/two-sided entries | Ordinary invalid entries rejected; DB is stronger than number-only checks |
| Posted journal balances in one currency | JS sums debit/credit | Deferred `assert_ledger_transaction_balanced`; exact numeric sums, at least two entries, entry currencies equal journal currency | Existing DB test and probes reject ordinary unbalanced/empty/mixed-currency posting; F02 qualifies the concurrent and immutable guarantees |
| Journal business reference occurs once | Conflict handling in `LedgerService.post` | `ledger_business_unique` on business type/id/currency | Protects duplicate ordinary financial journals; P01 concerns trusting an existing draft/different payload |
| Account uniqueness including platform accounts | Lookup by merchant/code/currency | Functional `ledger_accounts_scope_unique`, coalescing null merchant to zero UUID | Stronger than an ordinary nullable unique index; preserves one platform account per code/currency |
| Account and entry currency/ownership agree | LedgerService selects matching currency and requested merchant | Individual foreign keys, not semantic/composite currency/tenant constraints | Direct SQL bypass succeeds; F09 |
| Financial history is immutable | Corrections use new business journals | Entries reject UPDATE/DELETE; posted/reversed transactions reject UPDATE/DELETE; audit rows reject UPDATE/DELETE | Balanced INSERT into posted history remains possible; account interpretation remains mutable |
| Captured total cannot exceed authorization | Capture request locks payment; completion locks attempt/payment and checks new total | `payments_amounts_range_check` bounds authorization/capture by payment amount; does **not** require capture <= authorization | Normal competing requests/duplicate success passed probes; stale failure counterexample F05 |
| Refund reservations cannot exceed capture | Payment lock plus sum of pending/processing/successful refund amounts | Refund amount positive; payment aggregate requires refunded <= captured | Existing concurrency test proves request reservation; successful totals serialize on payment. No DB cross-row sum constraint |
| Refund fee allocations conserve original fee | Cumulative proportional formula and successful-refund fee sum | No independent cumulative fee-cap constraint | Small final-refund allocation passed; F03 disproves universal exactness over declared individual range |
| Capture appears in at most one settlement item | Attempt `FOR UPDATE SKIP LOCKED` | `settlement_capture_unique` | One ordinary competing generation probe produced one batch; item uniqueness alone does not prove all batch totals under every interleaving |
| Settlement batch is financially eligible and matches items | Generator derives totals from original capture journals | No net-availability, refund/dispute adjustment or batch-total-vs-item-sum constraint | F01/F03/F07; partial-capture allocation needs clearer policy |
| Available funds cannot be reserved twice | Merchant/currency advisory lock for payout requests | Transactional reservation journal and unique business reference | Existing two-payout test passes; cross-writer counterexample F04 |
| Reversal is a valid compensation | Specific refund/dispute journals | `reversal_of_id` foreign key only | No general reversal API, amount inversion or unique reversal policy implemented |
| Audit/webhook evidence remains stable | Inbox receives verified Stripe events | Audit UPDATE/DELETE blocked; webhook evidence-field UPDATE blocked | Webhook trigger is UPDATE-only, not DELETE protection. Retention/deletion hardening belongs in the later evidence/security audit |

### Schema, migration and runtime comparison

Both checked-in migrations were applied to a fresh database and their resulting catalog inspected. The balance and immutability functions, all associated triggers, functional account uniqueness and hand-authored foreign keys are present.

| Difference | Assessment |
| --- | --- |
| Drizzle does not fully describe functional account uniqueness, deferred checks, immutability or hand-authored reversal/provider-refund foreign keys | **Intentional representation gap**, already documented in [database design](../database-design.md) and agent routing. SQL migrations are authoritative; schema regeneration would not preserve all guarantees |
| Initial migration contains Mock PSP defaults/table; forward migration removes the table/scenario and sets Stripe default/references/indexes | Historical migration sequence, **not current runtime drift**. Fresh catalog has no `mock_psp_profiles` table |
| Money schema is `mode: 'number'`, while raw runtime queries commonly return strings | Type/range design gap described above, not proof that Drizzle is currently truncating runtime reads |
| Missing account/entry currency and immutable account semantics | Enforcement gap confirmed in F09 |
| No general DB safe-money caps, captured <= authorized check, fixed-fee nonnegative check, settlement gross/fee/net identity or batch/item aggregate checks | Application/runtime assumptions exceed constraints; F03 and potential/test-gap sections distinguish demonstrated failures from missing defenses |

Existing indexes support journal/account balance joins, payment/refund lookup, business-key uniqueness, capture-item uniqueness and inbox/outbox polling. Row/advisory locks operate on PostgreSQL at the observed default `READ COMMITTED` isolation. Index presence and one successful race do not prove all possible concurrency schedules.

## 5. Confirmed findings

### F01 — Settlement releases refunded or held funds

**Follow-up, 2026-10-09:** [Run A's approved contract](h1-fix-02-settlement-design.md#16-approved-b1-contract-2026-10-09) and the [B1 allocation checkpoint](h1-fix-02-b1-allocation-foundation.md) provide dormant schema/helpers and preserve six opt-in failing behavioral regressions. Current financial writers are unchanged; F01 remains open pending B2/B3. Original finding evidence below is retained.

**CONFIRMED ISSUE — H1 / Critical.** Location: [SettlementsService.generate/complete](../../apps/api/src/settlements/settlements.service.ts), lines 15–66; `settlement_items`, original `CAPTURE` journals; [RefundsService.applySucceeded](../../apps/api/src/refunds/refunds.service.ts) and [DisputesService.open](../../apps/api/src/disputes/disputes.service.ts).

**Current behavior:** generation selects successful capture attempts without an existing item, then copies original gross/fee/net credits from the capture journal. It does not subtract refund journals or honor dispute holds. Completion transfers that original net from pending to available without checking remaining eligible liability.

**Established scenario:** capture `10000`, fee `300`, then refund `5000` before settlement. Pending becomes `4850`; settlement leaves pending `-4850` and available `9700`. A full refund before settlement leaves pending `-9700` and available `9700`, despite the merchant's total liability having returned to zero. A `5000` dispute hold also leaves pending `-5000`, available `9700` after settlement.

Every journal is balanced, but the payout service checks only available. The fully refunded payment can therefore expose `9700` for payout. Asset classification also moves original gross into cash even when refunds already reduced the receivable. This is a financial allocation defect at ordinary amounts, not an arithmetic overflow.

**Direction:** define capture-level remaining settlement entitlement after refunds/holds, with transactional allocation shared by competing financial writers. Preserve immutable originals and record compensating/allocation evidence; filtering only today's payment status is insufficient for partial refunds, partial captures or refunds arriving after batch generation.

**Regression proof:** capture → partial/full refund → generate/complete → payout request; assert no payoutable refunded amount, correct cash/clearing and pending/available totals. Add a dispute hold and refund between generation and completion.

### F02 — Posted journals are not sealed against inserts

**Follow-up, 2026-10-07:** [H1 Fix 01](h1-fix-01-posted-ledger-immutability.md) implements and verifies PostgreSQL sealing in forward migration `0002_seal_posted_ledger.sql`. The finding below describes the pre-fix revision and is retained unchanged as evidence.

**CONFIRMED ISSUE — H1 / Critical, database enforcement boundary.** Location: [initial migration](../../apps/api/drizzle/0000_cheerful_sunset_bain.sql), `assert_ledger_transaction_balanced` (line 376), `ledger_entries_balance_check` (406), `protect_immutable_financial_rows` (410), `ledger_entries_immutable` (425).

**Current behavior:** UPDATE/DELETE protections are strong, but no INSERT check requires the parent journal to remain draft. Balance validation permits a new balanced set of entries in an already posted journal.

**Established scenario:** post a funding journal of `100`, then use ordinary SQL privileges to append a debit/credit pair of `50` to the same journal. COMMIT succeeds and merchant available changes from `100` to `150`, without a new journal/business reference. This could occur through an importer, repair script or future writer bypassing LedgerService. No current HTTP append endpoint was found or claimed.

A separate two-session SQL probe began with a balanced draft. Transaction A marked it POSTED and executed `SET CONSTRAINTS ALL IMMEDIATE`, then paused. Transaction B appended an unbalanced debit while seeing the committed parent as DRAFT and committed; A then committed. The durable POSTED journal had debit `200`, credit `100`. **LedgerService does not issue that SET command:** this proves the database claim is not universal across permitted writers, not that the normal posting path already follows this schedule.

**Direction:** serialize entry writers and posting on the parent journal, permit entry creation only while draft, and make sealing/commit validation safe across concurrent transactions and constraint timing. Use a reviewed forward migration, retaining immutable history.

**Regression proof:** reject even a balanced append after POSTED; preserve UPDATE/DELETE rejection; run a barrier-controlled draft append/posting race, including immediate constraint evaluation, and assert every committed posted journal remains balanced and unchanged.

### F03 — Individual safe integers do not make monetary arithmetic exact

**CONFIRMED ISSUE — H2 / High.** Locations: [captureSucceeded](../../apps/api/src/webhooks/webhook-business.service.ts), line 133; [allocateRefundFee](../../apps/api/src/ledger/ledger.types.ts), line 32; [merchantBalance](../../apps/api/src/ledger/ledger.service.ts), line 41; [settlement aggregation](../../apps/api/src/settlements/settlements.service.ts), lines 44–48; [formatMoney](../../apps/web/lib/api.ts), line 17.

**Established cases, compared with exact BigInt integer division:**

| Operation | Observed result | Exact result |
| --- | ---: | ---: |
| Capture `9007199254640223`, fee 224 bps | Fee `201761263303941` | `201761263303940` |
| Refund allocation: fee `270215977635000`, cumulative refund `9007199254499999`, captured `9007199254500033`, prior allocation 0 | `270215977634999` | `270215977634998` |
| Balance from independently valid journals of `9007199254740991` and `2` | Service number `9007199254740992` | SQL/read API string `9007199254740993` |
| Settlement grouping those two captures at fee 0 | Stored batch gross/net `9007199254740992` | Item sum `9007199254740993` |

The individual inputs/ledger lines are safe integers. Multiplication exceeds exact-number range, and account/batch accumulation can exceed it too. The rounded batch was committed; completion then rejected its unsafe ledger line. The latter is a stuck/incorrect batch, **not** proof that unsafe lines successfully post.

These large capture probes exercise the repository's declared internal range and bypass external calls. They do not establish that Stripe accepts such payments. Account accumulation is a separate concern and can exceed an individual transaction cap over time.

**Direction:** define an exact monetary representation through calculation, database and JSON boundaries; use integer division with exact intermediates, or a rigorously bounded narrower contract covering products and aggregates. Preserve string responses and check provider-specific conversion limits explicitly. The Drizzle mapping must agree with that contract if used at runtime.

**Regression proof:** compare fee calculations to an exact integer oracle at boundaries, test sums above `MAX_SAFE_INTEGER`, enforce/reject the chosen bounds consistently, and verify SQL/API/UI round trips without losing a minor unit.

### F04 — Payout's advisory lock does not cover refund debits

**CONFIRMED ISSUE — H2 / High.** Locations: [PayoutsService.request](../../apps/api/src/payouts/payouts.service.ts), lines 19–31; [RefundsService.applySucceeded](../../apps/api/src/refunds/refunds.service.ts), lines 54–64; [DisputesService.open](../../apps/api/src/disputes/disputes.service.ts).

**Current behavior:** payout holds `(merchant, currency)` advisory lock while reading and reserving available funds. Refund/dispute writers do not acquire it. Their payment/refund locks do not serialize a merchant-wide payout balance read.

**Established interleaving:** settled available `9700`; an accepted `5000` refund owes merchant debit `4850`. Pause payout `8000` immediately after its real SQL balance read. Refund commits, reducing available to `4850`. Resume payout: it accepts with HTTP-result status `202` and reserves `8000`, leaving available `-3150`. The probe only adds a timing barrier; services and writes are real.

The existing two-payout test remains valid, but its guarantee does not extend to other financial writers. Disputes explicitly allow negative liability; that policy still requires payout admission to use a serialized current balance.

**Direction:** define one cross-process locking/conditional-reservation protocol for all writers affecting spendable merchant/currency balances, with a documented lock order. Decide refund/dispute priority and debt policy rather than adding an indiscriminate nonnegative CHECK to forced external obligations.

**Regression proof:** deterministic payout/refund barrier case above, payout/dispute competition and operations on separate payments of one merchant/currency. Assert payout admission against the balance at the serialized reservation point.

### F05 — Late capture failure destroys the success replay guard

**CONFIRMED ISSUE — H2 / High; internal event sequence reproduced.** Locations: [WebhookBusinessService.captureFailed/captureSucceeded](../../apps/api/src/webhooks/webhook-business.service.ts), lines 123–148; [PaymentStateMachine.captureFailed](../../apps/api/src/payments/payment-state.machine.ts); `ledger_business_unique`.

**Current behavior:** success locks and skips a successful attempt. Failure locks the payment, unconditionally overwrites the referenced attempt with FAILED, and transitions whichever global capture is pending. It does not validate/lock the attempt as success does or preserve a prior successful outcome.

**Established sequence:** attempt A captures `4000`; request B for `2000`. A late failure for A marks A FAILED and clears B's global `CAPTURE_PENDING`. A third request C for `2000` is now accepted. Replaying A's success increments captured total again; the journal business key returns A's original journal instead of posting another. Durable payment captured/fee become `8000`/`240`, with one capture journal for gross `4000` and two still-pending attempts.

Financial uniqueness prevents a second journal, but workflow totals are no longer tied to the journal. The exact contradictory Stripe event history was **not** externally verified; the reproduced defect is the internal handler's response to stale/reordered attempt evidence, relevant to its retry model.

**Direction:** make terminal attempt outcomes monotone, validate failure identity and bind transitions to the current operation. Apply captured totals only when the corresponding financial effect is first established. Preserve evidence for contradictory outcomes instead of resetting success.

**Regression proof:** A success → B pending → stale A failure → replay A success; assert A remains succeeded, B stays pending, C is rejected, and captured/fee totals equal posted capture evidence. Include distinct event IDs for the same business effect.

### F06 — A later capture prevents completion of an accepted refund

**CONFIRMED ISSUE — H2 / High.** Locations: [RefundsService.create/applySucceeded](../../apps/api/src/refunds/refunds.service.ts), [PaymentStateMachine.refundSucceeded](../../apps/api/src/payments/payment-state.machine.ts), [WebhookProcessorService.fail](../../apps/api/src/webhooks/webhook-processor.service.ts).

**Established scenario:** partially capture `4000`, accept refund `2000`, then accept another capture `2000` before refund success arrives. The payment is now `CAPTURE_PENDING`. Refund success raises `Cannot refund a payment in CAPTURE_PENDING`; the transaction rolls back and the refund remains PENDING. Inspection of the processor proves this DomainError is nonretryable and the inbox event becomes DEAD. The temporary probe exercised the service rejection directly; it did not run this case through a signed inbox end to end.

The provider can legitimately complete a command already accepted by the API. A later independent operation should not make that completed financial obligation permanently inadmissible. Local rollback is correct, but leaves provider evidence unapplied and a reservation unresolved.

**Direction:** separate refund eligibility at request time from applying accepted refund evidence. Preserve captured/refunded bounds while representing concurrent capture/refund work independently, or explicitly block conflicting acceptance before dispatch. Define recovery for already accepted commands.

**Regression proof:** reproduce the sequence through signed inbox processing; assert one refund journal and consistent cumulative totals without DEAD due solely to the later capture. Add dispute opening after refund acceptance to cover the related state interaction.

### F07 — Allowed 100% fees produce an uncompletable settlement

**CONFIRMED ISSUE — H2 / High.** Locations: `merchants_fee_bps_check` in [initial migration](../../apps/api/drizzle/0000_cheerful_sunset_bain.sql); [captureSucceeded](../../apps/api/src/webhooks/webhook-business.service.ts); [SettlementsService.complete](../../apps/api/src/settlements/settlements.service.ts), line 61; [assertBalanced](../../apps/api/src/ledger/ledger.types.ts).

**Established scenario:** an allowed `fee_bps=10000` capture of `10000` posts a balanced clearing/revenue journal with merchant net zero. Batch generation succeeds. Completion always creates the two net-transfer lines with amount zero, which `assertBalanced` rejects with `Each ledger line must contain one positive integer side`. The batch remains pending.

Capture deliberately omits zero lines, but settlement does not. Fixed fees that consume the entire capture can reach the same supported zero-net case.

**Direction:** retain gross settlement accounting while omitting zero-value liability legs, or constrain merchant configuration if zero-net captures are intentionally unsupported. Do not weaken the positive-entry invariant.

**Regression proof:** complete a zero-net batch once and repeatedly; assert the required gross asset movement, no zero entries and no merchant availability credit.

### F08 — Supported money/currency contract and display scale disagree

**CONFIRMED ISSUE — M / Medium.** Locations: currency validation in [payment DTO](../../apps/api/src/payments/dto/create-payment.dto.ts) and [payout DTO](../../apps/api/src/payouts/payouts.dto.ts); [formatMoney](../../apps/web/lib/api.ts), lines 17–20; provider amount pass-through.

**Established behavior:** formatter output for `1000` is `$10.00` in USD, `¥1,000` in JPY, but `CLP 10.00` in CLP. CLP is a documented Stripe zero-decimal currency, so this display is scaled by 100 incorrectly. Any three-letter currency passes DTO shape validation; there is no explicit USD-only contract. [Stripe currency rules](https://docs.stripe.com/currencies#zero-decimal-currencies).

The formatter also hardcodes scale 100 for every other code, including KWD. That establishes the missing general contract; this audit does not assert an unverified Stripe three-decimal rule. Provider API conventions and display exponents must be defined separately where they differ.

**Direction:** define and validate a supported currency set plus internal/provider minor-unit conventions, then format exactly from that contract. Preserve integer precision from F03. Reject unsupported codes rather than letting the provider or Intl establish accidental policy.

**Regression proof:** verify USD, JPY and CLP values; include every supported non-two-decimal/special-case currency, unsupported-code rejection and large exact read strings. This is financial display correctness, not a dashboard redesign request.

### F09 — Account currency and ownership can reinterpret posted evidence

**CONFIRMED ISSUE — M / Medium, enforcement gap outside current LedgerService writes.** Locations: `ledger_accounts`, `ledger_entries`, their foreign keys and `assert_ledger_transaction_balanced` in [initial migration](../../apps/api/drizzle/0000_cheerful_sunset_bain.sql); [LedgerService.balances](../../apps/api/src/ledger/ledger.service.ts).

**Established behavior:** a USD journal with USD entries can reference EUR accounts and commit. The balance query reports the merchant credit under EUR, because it groups by account currency. Changing a referenced account's merchant ID also succeeds; the posted balance then appears under the new merchant without a new journal.

The trigger checks entry currency against journal currency, not account currency. Individual account foreign keys prove existence, not currency/ownership consistency. Account identity metadata is mutable. Current LedgerService resolves the correct account and no public reassignment path was found; severity reflects a missing defense for import/maintenance/future direct writers rather than a demonstrated tenant API exploit.

**Direction:** enforce account/entry currency agreement and stable financial account identity once used; define permissible merchant/platform scope for journal lines. Apply only justified constraints through forward SQL.

**Regression proof:** reject a USD entry pointing to an EUR account and reject reassignment/currency/code changes that alter posted balance meaning. Confirm legitimate platform and merchant lines remain possible.

### F10 — Number coercion accepts values that were not integer minor units

**CONFIRMED ISSUE — M / Medium.** Locations: monetary DTO decorators listed in section 3; [main.ts](../../apps/api/src/main.ts) ValidationPipe transformation.

**Established DTO probe:** `"9007199254740990.5"` becomes `9007199254740990` before validation and has no amount validation errors. `true` becomes `1` and also passes. Ordinary `1.5` fails; `"9007199254740993"` becomes `9007199254740992` and fails the max check. Therefore integer/max validation is useful but does not establish an integer-only input token contract.

This can silently accept a different monetary amount than supplied, especially through loosely typed clients. The probe tested actual class transformation/validation using current compiled DTOs; it did not exercise a live HTTP endpoint.

**Direction:** validate the original representation before coercion. Either require JSON integer numbers within a defined exact range or accept canonical decimal integer strings and parse them exactly; explicitly reject booleans and fractions.

**Regression proof:** HTTP-level cases for booleans, numeric strings, decimal/exponent strings, fractions near the precision boundary and the accepted canonical maximum. Verify idempotency hashes/response replay use the intended canonical contract.

## 6. Potential findings

### P01 — Existing draft business reference can suppress the financial post

**POTENTIAL ISSUE — M / Medium.** Location: [LedgerService.post](../../apps/api/src/ledger/ledger.service.ts), lines 21–25; `ledger_business_unique`.

Conflict returns an existing journal ID without checking POSTED status, merchant, description or entries. A conditional probe inserted an empty DRAFT journal for a capture attempt, then processed capture success. Payment became CAPTURED while the journal stayed DRAFT with zero entries.

The result is confirmed **given that precondition**, but the inspected runtime creates draft, entries and posting in one transaction, so it does not normally leave a committed draft behind. The risk is a future importer/repair writer or changed posting lifecycle. Do not classify this as a proven ordinary capture bug.

Direction: require an existing business reference to represent the same finalized financial effect, and reject/report incompatible drafts or payloads. Regression: preexisting draft/incompatible merchant or lines must not let business success commit without the expected posted evidence.

### P02 — Partial settlement refund asset allocation is undefined

**POTENTIAL ISSUE — M / Medium, policy-dependent financial classification.** Location: [RefundsService.applySucceeded](../../apps/api/src/refunds/refunds.service.ts), lines 54–63; successful-item `exists` test.

Any successful settlement item for the payment routes the **entire** refund credit to PLATFORM_CASH. The observed case settled a first capture of `4000`, then captured another `6000` that remained unsettled. A refund `5000` consumed `4850` pending merchant liability but credited all `5000` to cash. In the isolated sequence's journal contributions, cash would be `-1000` while clearing remained `6000`.

The total asset reduction is balanced and correct in amount. Whether all-cash treatment is intended requires a policy for pooled cash/provider receivables and partial-capture allocation; the current boolean does not express one. This audit does not equate internal cash with Stripe's actual balance or claim provider bank overdraft.

Direction: define asset allocation for mixed settled/unsettled captures and align it with settlement/refund evidence, or explicitly document and reconcile a cash-pool policy. Regression: first/second capture settled in different combinations, partial/full refunds and expected per-account asset balances.

### P03 — Refund debt after payout needs an explicit policy

**POTENTIAL ISSUE — M / Medium, policy gap.** Location: [RefundsService.applySucceeded](../../apps/api/src/refunds/refunds.service.ts), pending-first/available-remainder debit; [settlement/payout documentation](../settlement-and-payout.md).

Sequential probe: settle net `9700`, reserve payout `9700`, then apply a `5000` refund. Available becomes `-4850`. This is separate from the stale-read race in F04: the payout was valid when reserved, and a completed provider refund still has to be accounted for.

Docs explicitly permit negative liability for disputes, but do not establish the equivalent refund/debt/collection policy. A forced refund debit is not automatically a bug, and simply rejecting completed refund evidence would be unsafe.

Direction: specify reserves, payout cancellation eligibility, merchant debt/collection and admission rules. Regression can prove whichever policy is chosen, including refund before and after payout completion. No claim of an implemented external payout recovery mechanism is made.

### P04 — Fee configuration bounds and snapshot rules are incomplete

**POTENTIAL ISSUE — M / Medium.** Locations: merchant checks in [schema.ts](../../apps/api/src/database/schema.ts) and [initial migration](../../apps/api/drizzle/0000_cheerful_sunset_bain.sql); merchant read in `captureSucceeded`.

Basis points are constrained to 0–10000; fixed fee has no nonnegative/safe-range constraint. Capture confirmations read today's merchant fee configuration rather than a payment snapshot. A negative fixed fee or lower fee configuration between partial captures can yield a negative fee delta rejected by ledger entry validation, blocking otherwise valid capture evidence.

This follows the inspected arithmetic and constraints; the audit did not prove a current public API that changes fee configuration, and did not execute this configuration-change scenario. It is conditional, not an established ordinary workflow failure.

Direction: define immutable fee terms for a payment or explicit adjustment semantics, validate configuration bounds and add targeted tests for fixed fees exceeding gross and fee changes between captures.

## 7. Test gaps

**TEST GAP — coverage statements, not additional confirmed bugs.** The committed [ledger unit suite](../../apps/api/test/unit/ledger.spec.ts) tests one balanced capture, unbalanced rejection and the `101`-fee/`1000`-capture rounding example. The [PostgreSQL suite](../../apps/api/test/integration/financial-concurrency.spec.ts) tests ordinary deferred rejection, competing payout requests, competing refund requests, duplicate inbox receipt and one signed capture completion.

| Gap and source | Severity of coverage gap | High-value regression evidence |
| --- | --- | --- |
| Full integer range and exact division: fee functions, DTOs, balance queries | M | Boundary/property cases against BigInt; aggregate overflow; original input token validation |
| Partial captures: payments service, webhook handlers | M | Two requests whose sum exceeds remaining authorization; multiple completions/replays, stale failures and captured total vs journal sum |
| Refund reservation vs successful completion: refunds service | M | Many fractional-fee allocations, simultaneous completions, failed reservation followed by late success, final fee/amount caps and post-dispute evidence |
| Posted sealing/account meaning: migration SQL | M | Balanced append, parent-posting race, account currency/ownership, immutable audit and evidence retention semantics |
| Settlement concurrency: generator and `settlement_capture_unique` | M | Barrier-controlled runners with one blocked selection and a competing committed item; assert batch totals equal **actually inserted** items, not merely unique item count |
| Payout/other debit writers and completion: payout/refund/dispute/internal outbox | M | Cross-writer read/reservation barriers; duplicate completion, crash after journal commit before outbox update; chosen refund/debt policy |
| Duplicate journal key: LedgerService conflict branch | M | Concurrent identical effect succeeds once; different payload or draft collision fails without unrelated business advancement |
| General reversals: `reversal_of_id` | L | No API exists today. If introduced, test inverse amount/currency, allowed linkage, multiple reversal policy and preservation of the original journal |

The temporary capture and duplicate completion probes supplement, but do not permanently fill, these gaps. One ordinary pair of settlement generators created one batch; this does not rule out a stale-selection/conflict schedule. In particular, `ON CONFLICT DO NOTHING` on item inserts is not by itself proof that precomputed batch totals correspond to the rows eventually inserted.

### Documentation drift identified during H1

- **DOCUMENTATION DRIFT — M:** [ledger.md](../ledger.md), refund formula paragraph, promises exact cumulative allocations without qualifying the number-product boundary. F03 disproves that claim over the accepted individual range. Document the exact representation/bounds after remediation and retain the cumulative formula.
- **DOCUMENTATION DRIFT — M:** the same document says posted journals/entries are immutable. UPDATE/DELETE is protected; F02 shows inserts can change a posted journal. A regression can prove a future sealing guarantee.
- **DOCUMENTATION DRIFT — M:** [settlement-and-payout.md](../settlement-and-payout.md), final paragraph, says payouts never make liability negative. F04 disproves this for a stale read against a concurrent refund. The two-payout claim remains supported by its integration test.

No ownership documents were rewritten in this audit. Historical Mock PSP SQL and intentionally richer hand-authored SQL are not mislabeled as stale runtime documentation.

## 8. Positive protections already present

1. **Local acceptance is atomic.** [IdempotencyService](../../apps/api/src/common/idempotency.service.ts) preserves merchant/operation/key scope, payload comparison and replay response. Services commit intent, outbox, audit and response together.
2. **Ordinary posted balance enforcement is in PostgreSQL.** Exact numeric totals and deferred currency checks reject unbalanced, empty and mixed-entry-currency posting. Existing integration and direct probes passed these protections; F02 identifies their limit.
3. **Entries and finalized journal rows resist UPDATE/DELETE.** Direct mutation probes received the intended immutable-row errors. The audit did not weaken triggers or regenerate migrations.
4. **Journal and account uniqueness are durable.** Business type/id/currency uniqueness prevents ordinary replayed financial journals; null-aware account uniqueness covers platform accounts as well as merchant accounts.
5. **Normal partial capture is serialized.** Payment/attempt locks and completion amount/reference checks protect current intent. After a first `4000` capture, two simultaneous additional `4000` requests yielded one acceptance. Two deliveries of the successful attempt left captured total `8000` and one journal per attempt. This assumes no stale failure such as F05.
6. **Refund requests account for in-flight reservations.** The existing two-`800`-refund test against capture `1000` yielded one acceptance. Successful completion locks payment and uses the database refunded <= captured bound. Failures roll back rather than leaving an unbalanced local effect.
7. **Cumulative small-value refund rounding works.** Capture `1000`, fee `101`, refunds `333`, `333`, `334` allocated fees `33`, `34`, `34`; totals reached exactly `101` and `1000`. Replayed final success added no money and left pending/available zero.
8. **Competing payouts serialize against each other.** The real integration test reserves one `8000` payout against `10000`, rejects the other and leaves available `2000`.
9. **Ordinary repeated settlement/payout completion is safe.** Row locks, succeeded guards and financial business keys made two simultaneous completions post once. The tested payout after settlement left available zero.
10. **Stripe evidence precedes internal financial completion.** The signed webhook integration test produces one capture journal only after inbox processing. Provider keys stay stable across retries in unit tests. These are local/mock-boundary facts, not live Stripe/RabbitMQ end-to-end evidence.

## 9. Recommended fix order

The first fix run should consider **F01, F02 and F04**. Keep each remediation focused and prove its financial invariant in PostgreSQL before broadening scope.

| Order | Work | Acceptance evidence |
| --- | --- | --- |
| 1 | F01 settlement entitlement after refunds/holds, including generation/completion races | No payoutable refunded/held funds; correct asset and liability classification; partial captures preserved |
| 2 | F02 posted sealing and concurrent posting safety; include F09 account semantics where practical | Posted history cannot accept entries or change meaning; all allowed concurrent posting schedules preserve balance |
| 3 | F04 common balance-consumption protocol plus explicit P03 debt policy | Cross-writer payout admission uses a serialized current balance; no unintended stale-fund reservation |
| 4 | F03 exact money contract, F10 input validation, F08 currency contract | Exact products/sums/round trips or consistently enforced narrower bounds; supported currency display matches provider conventions |
| 5 | F05 monotone attempt outcomes and F06 independent accepted-refund completion | Workflow monetary totals equal journal evidence despite stale/reordered confirmations |
| 6 | F07 zero-net settlement; resolve P01/P02/P04 policies and permanent coverage gaps | All supported financial configurations finish coherently; duplicate/draft conflicts cannot suppress required financial evidence |

Fixing only a CHECK or only a payment status will not resolve the allocation and concurrency findings. Do not edit historical financial evidence to make balances look correct. Remediation should define compensations/reconciliation for any already affected lab rows and use reviewed forward migrations where necessary.

## 10. Verification evidence

### Inspected material

Read repository instructions, `CLAUDE.md`, README/package scripts, [documentation index](../README.md), task routing and [AI workflow](../AI_WORKFLOW.md). Financial owners inspected: [ledger](../ledger.md), [database design](../database-design.md), [concurrency](../concurrency.md), [payment lifecycle](../payment-lifecycle.md), [refunds/disputes](../refunds-and-disputes.md), [settlement/payout](../settlement-and-payout.md), [webhooks/idempotency](../webhooks-and-idempotency.md) and [verification](../verification.md). Current [Stripe](../real-psp-stripe.md), [outbox](../outbox-rabbitmq.md) and architecture material informed boundary interpretation.

Code review covered monetary DTOs/controllers/services; state machine; ledger types/service; database runtime/schema/seed/migrator; both checked-in SQL migrations and live fresh catalog; Stripe provider/normalizer; webhook receiver/business/processor; command/outbox/internal scheduler paths; API JSON reads and dashboard formatter; relevant unit/integration suites. No `.env` values or live credentials were printed.

### Executed checks

Environment: Windows, Node `24.19.0`, pnpm `10.26.0`, PostgreSQL `18.6`, default `READ COMMITTED`. An existing isolated local cluster on `127.0.0.1:55432` hosted a **new** database named `fintech_h1_audit`. Only the checked-in migrations and UUID-scoped test/probe fixtures were applied there; no seed or external workers ran. The cluster was stopped after verification; its disposable database/evidence was retained locally.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | PASS, API and web |
| `pnpm test` | PASS, 11 unit suites / 34 tests. Default PostgreSQL suite / five tests skipped without `RUN_DB_TESTS`; web package has no automated browser tests |
| `pnpm db:migrate` with disposable local DB override | PASS, both checked-in migrations applied; hand-authored catalog protections inspected |
| `RUN_DB_TESTS=1 pnpm --filter @fintech-lab/api test:integration` with that DB override | PASS, five/five PostgreSQL tests |
| Temporary current-source probes | PASS as observations: 14 core plus six additional named scenarios, described throughout this report |
| Driver/catalog/DTO probe | PASS after correcting the harness's decorator import strategy; int8/numeric exact strings, constraints/triggers and input coercion inspected |
| Local documentation/link validation | PASS, 27 Markdown files, 202 relative links/anchors; existing CI YAML parsed and checked. Mermaid sources were unchanged and were not re-rendered in H1 |
| `git diff --check` plus explicit new-file whitespace check | PASS; scope review found only this audit report as a new repository file. Git's LF-to-CRLF advisory did not indicate a whitespace error |

Temporary probes are `.tmp/h1-financial-probes.cjs`, `.tmp/h1-financial-probes-extra.cjs` and `.tmp/h1-catalog-and-dto.cjs`; observation results are in `.tmp/h1-probe-results.json` and `.tmp/h1-extra-probe-results.json`. These ignored files are not committed regression coverage. Most probes use current source via `tsx/cjs`, instantiate services directly and append UUID fixtures to the disposable database. Exact arithmetic comparisons use BigInt. Race probes use explicit timing barriers. Direct SQL probes intentionally exercise application-bypass database guarantees and are labeled accordingly.

The DTO harness initially failed because the ad hoc source loader's decorator mode was incompatible with class-validator's legacy decorators. It was corrected to import the existing Nest-compiled DTOs with `reflect-metadata`; no product fix or dependency installation was made. Expected mocked provider/broker failure logs in unit tests were not test failures.

The integration suite's configured CI database is PostgreSQL 17; this run tested local PostgreSQL 18.6, not a new CI run. This audit did not need lint/build, browser layout checks or live integration calls to establish the H1 evidence. The deliverable is this report only; no commit or push was performed.

## 11. Explicitly out-of-scope areas for H2/H3

- Live Stripe acceptance, partial/multicapture capabilities, actual provider settlement/balance transactions, reserves, refunds or bank transfers. Large integer probes are internal range checks. Exact stale capture failure event production remains externally unverified.
- General Stripe normalization/correlation correctness, metadata amount versus provider received amount, refund/payment identity fallback, SDK/version behavior and full provider reconciliation. H1 inspected only the monetary boundary and duplicate financial effects.
- RabbitMQ topology, reconnect/retry/ACK durability, poison messages, consumer crash recovery and Redis/BullMQ scheduling beyond the financial transaction boundaries inspected here.
- Full authorization/security/tenant attack-surface review, secrets management, database roles/privileges, webhook raw-evidence retention/DELETE hardening and observability. No offensive or production testing occurred.
- Production migrations/deployments, all possible concurrency schedules, disaster recovery, real external payout unknown outcomes and human-approved banking/payment operations.
- Dashboard presentation, screenshots, repository metadata, broad refactoring and implementation of any audit finding.

H1 establishes concrete local accounting evidence and focused regression targets. Later audits should expand the remaining boundaries without treating this report or passing tests as a real-money readiness claim.
