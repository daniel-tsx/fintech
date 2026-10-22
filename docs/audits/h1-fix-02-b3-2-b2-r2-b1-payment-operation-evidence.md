# H1 Fix 02 — B3.2 R2-B1: dormant pre-lot payment-operation evidence

Started: **2026-10-20**. Finalized: **2026-10-21**. Status: **READY_FOR_INDEPENDENT_REVIEW**, dormant implementation only. This checkpoint supplies evidence before capture accounting. It creates no capture journal/lot, terminal workflow transition, financial application, source clearance or production handler.

Authority: the owner's B1 implementation request, [approved capture preflight](h1-fix-02-b3-2-b2-r2-b-capture-preflight.md), [independent APPROVE_R2_B1_DESIGN](h1-fix-02-b3-2-b2-r2-b-independent-design-review.md), [approved R2 design](h1-fix-02-b3-2-b2-r2-financial-application-design.md), [R2 review](h1-fix-02-b3-2-b2-r2-design-review.md), [H01–H12/D01](h1-fix-02-b3-2-human-decisions.md), and [final dormant R2-A acceptance](h1-fix-02-b3-2-b2-r2-a-financial-application-foundation.md#25-final-independent-dormant-acceptance-and-hosted-source-verification). The earlier records remain unchanged. Implementation is awaiting its own independent review; design approval is not implementation approval.

## 1. Baseline and exact file inventory

Started on `main`, HEAD/local `origin/main` **95757b737fbbf3b88cdab2dc4fb16572555b0f31**. The index was empty. Pre-existing work was the two untracked design documents above and their two links in `docs/README.md`. Their complete starting bytes were fingerprinted before editing. No fetch, checkout, staging, commit, push or external provider request occurred.

| File | This run's change |
| --- | --- |
| [0011_payment_operation_evidence.sql](../../apps/api/drizzle/0011_payment_operation_evidence.sql) | New forward evidence/classification/binding migration; closed financial gates |
| [Migration journal](../../apps/api/drizzle/meta/_journal.json) | Append entry 11 only; previous entries retained |
| [Schema](../../apps/api/src/database/schema.ts) | Companion proof mapping, admission contract2 and alternative typed obligation FK |
| [Restricted receipt database](../../apps/api/src/webhooks/trusted-receipt-database.ts) | Explicit payment publisher/correlator capabilities; table/column privilege refusal; existing capabilities retained |
| [Signed receiver](../../apps/api/src/webhooks/trusted-signed-receipt.service.ts) | Optional server-owned isolated publication contract; default R1 behavior unchanged |
| [TrustedPaymentOperationEvidence](../../apps/api/src/webhooks/trusted-payment-operation-evidence.ts) | New SQL-only seal/read/bind adapter; separate transactions, no provider interpretation in TypeScript |
| [Payment evidence harness](../../apps/api/test/support/payment-operation-harness.ts) | New fresh-database, genuine SDK transport and signed receipt composition |
| [Payment evidence regressions](../../apps/api/test/integration/payment-operation-evidence.spec.ts) | 56 permanent proof/ownership/refusal/role/rollback/concurrency cases |
| [Payment migration regressions](../../apps/api/test/integration/payment-operation-migration.spec.ts) | Four permanent fresh/populated/rollback/DDL-wait cases |
| [Provider observation harness](../../apps/api/test/support/provider-observation-harness.ts) | Expose existing isolated receipt composition for reuse |
| [Receipt harness](../../apps/api/test/support/trusted-receipt-harness.ts) | Export reused HTTP response type; current full-chain count 12 |
| [Legacy writer compatibility](../../apps/api/test/integration/financial-application-legacy-compatibility.spec.ts) | Retain exact 0009/0010 phases; add seven identical financial checks at 0011 |
| [R0.2 migration regressions](../../apps/api/test/integration/receipt-delivery-migration.spec.ts) | Current fresh-chain count 12; pin original function/whole-row fingerprint upgrade checks through0010, preserving those original assertions; new B1 suite owns the intentional0011 function/nullable-column change |
| [Capture migration](../../apps/api/test/integration/capture-accounting-migration.spec.ts), [R2-A migration](../../apps/api/test/integration/financial-application-migration.spec.ts), [D02 migration](../../apps/api/test/integration/provider-observation-migration.spec.ts), [R0 migration](../../apps/api/test/integration/receipt-admission-migration.spec.ts), [B.1 migration](../../apps/api/test/integration/trusted-evidence-migration.spec.ts) | Current full-chain migration count/labels only, 11→12; historical staged counts and financial/security assertions preserved |
| [Integrated accounting](../../apps/api/test/integration/integrated-accounting-verification.spec.ts), [settlement integration](../../apps/api/test/integration/settlement-accounting-integration.spec.ts) | Current full-chain migration count only, 11→12 |
| This record, [index](../README.md), [database owner](../database-design.md), [receipt owner](../webhooks-and-idempotency.md), [verification owner](../verification.md) | Implementation contract, navigation and executed evidence |

The starting preflight SHA-256 is `0df62d084996ae367d5de96148fb7e90940f63ea7e305807cef14f6fe28a5ced`; independent design review is `8e2a4407ed4547fb03b8caa3749566e13573ab99d2707749cb944e50bd98cbfd`. Both remain byte-for-byte unchanged. All SQL0000–0010 remains unchanged, including0010 SHA-256 `50c6caee59d6e49a53728a0269733521ee0b31aaccd548428824d3f8916a3c17`. Original R2-A reviewer/ownership suites, F01 assertions, package/lockfile and monetary writers remain unchanged. Generated runners/logs/cache/Jest JSON and harness markers stay ignored under `.tmp`; they are not deliverables.

## 2. Installed schema and SQL functions

Migration0011 adds one immutable relation, `payment_operation_evidence`. It stores original inbox/admission, fixed proof version1 and validator `PAYMENT_OPERATION_V1`; disjoint operation/outcome; provider/account/mode; composite attempt/payment/merchant/currency identity; accepted outbox; exact D02 source/execution and optional authorization source; PI/Charge; applicable capture or authorization principal; recorded LEGACY/epoch0 policy; original obligation/claim/scope/intake revisions; canonical checked facts/fingerprint; sealer time/principal.

Capture success alone has positive `capture_principal`. Authorization success alone has positive `authorized_principal`. Void/failure shapes have neither. Failure shapes are represented explicitly but their automatic issuer is closed. The accepted source supplies principal; no caller JSON is a financial input. Source/execution composite FKs retain exact outbox ownership, and the proof's owned tuple is the target of the obligation FK. PI/Charge is indexed, not made unique per attempt.

`receipt_admissions.contract_version` permits1/2. Existing rows stay1. `receipt_admission_obligations.payment_operation_proof_id` is the new tagged alternative: a bound obligation has exactly one of old proof-revision1 or payment proof UUID, with a complete owned tuple; an unbound obligation has neither. Partial NULL/both-proof combinations reject. Resolution/application storage and all financial functions remain closed for payment proofs.

| SQL entry point / helper | Responsibility |
| --- | --- |
| `check_payment_json`, `payment_json`, `payment_minor` | Duplicate-preserving recursive JSON validation before jsonb, bounded bytes, exact integer minor units and range |
| `payment_operation_receipt_facts` | Contract2 classification from retained signed facts; preserve contradiction before successful correlation |
| `checked_payment_command_source` | Genuine same-command execution, complete2xx bytes, actual request form/path/key/account/version, mode/currency/object and original D02 fingerprint |
| `payment_operation_facts` | Single canonical SQL conjunction of accepted authority, independent authorization, response, signed causal event, normalization/metadata contradictions and recognized capture history |
| `publish_admitted_payment_receipt` | Atomic first signed receipt plus prospective contract2 admission/mandatory blocker; delegate events outside the four supported PI types to original contract1 publisher |
| `seal_payment_operation_evidence` | Current expected generation/revision; ordered locks; SQL-only immutable insert/exact replay, or retained unresolved review; an existing blocking review stays intact |
| `load_effective_payment_operation_evidence` | Exact inbox/version/operation selector; recompute and compare the same checked SQL facts/fingerprint; refuse stale/blocked ownership or new contradiction |
| `bind_payment_operation_obligation` | Separate guarded exact-revision transfer from unknown to scoped AWAITING_APPLICATION; no financial completion |
| `validate_payment_operation_seal` | Deferred source/fingerprint and projected typed-column validation |
| Existing `receipt_admission_facts`, `guard_receipt_obligation`, `check_receipt_admission_obligation` | Forward stored-version dispatch and typed ownership guards, retaining original contract1 branch; payment final clearance remains forbidden |

No operation contract is inserted into `financial_application_contracts`; no scope is enrolled in `financial_application_scope_authority`. Migration0010's family/proof restrictions, owner discovery, transaction-local permits and reverse finality are unchanged. A payment proof cannot be passed as an old refund/dispute revision or used to obtain a capture permit.

## 3. Evidence ownership and attributable principal

The restricted D02 producer still records genuine HTTP exchanges outside financial transactions. B1 reads its source directly; it does not fabricate a CAPTURE object projection or modify the original `CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED` obligation. It joins frozen authority to the accepted attempt and original key, then checks SQL-decoded actual form parameters against that authority. SQL trusts the restricted SDK/transport attesters for authenticity; it does not itself verify TLS/HMAC.

The supported parser is pinned to installed stripe-node22.6.2, actual request version `2026-08-26.dahlia` and signed event version `2026-08-26.dahlia`. Other event versions are deliberately refused in this first implementation. Raw body duplicates are checked before jsonb discards them. COMPLETE original bytes, non-null matching response request ID and signed Event request key/ID are mandatory. A lookup cannot substitute for COMMAND_RESULT.

The first-capture witness is the approved conjunction:

1. Accepted CAPTURE/outbox/attempt/key/owner/currency and matching actual capture request with amountA/final flag.
2. A separately owned AUTHORIZE result for the same manual-card PI/Charge, amount/capturableH and received0.
3. Genuine capture response and signed causative event agree on PI/Charge/mode/currency, face amount, receivedA and supported remaining/status interpretation.
4. Final capture: succeeded/remaining0 and signed PI success. Non-final partial: requires_capture/remainingH−A and signed previous capturableH. Do not derive principal from the difference itself.
5. No distinct recognized capture proof/local successful attempt/journal or unexplained aggregate; own already-sealed operation is distinguished from a different capture. A later pending attempt alone is not prior capture authority. Existing D02/receipt obligations remain admission blockers.

Explicit metadata/normalized contradictions reject. Metadata does not establish owner or gross. Final success with absent metadata can use independently proven raw evidence when normalization is harmless unsupported; a partial normalized as authorization is excluded. Every other returned object for the same command is checked for contradiction, including a later lookup; it cannot be hidden by selecting one favorable source. Reordered attributable signed failure also blocks, without replacing the sealed source.

| Pattern | Implemented result |
| --- | --- |
| First complete capture | Exact positive proof only with the full witness |
| First non-final partial | Exact positive proof with independent zero baseline, causal event and previous capturable witness |
| First final partial | Proof shape supported for a genuinely accepted final command; current manual API does not emit that partial command and is unchanged |
| Same event / coherent repeated source | Exact sealed replay; equivalent later delivery retained; no second principal or financial effect |
| Subsequent shared-PI capture / aggregate-only snapshot / missing causal or amount evidence | Blocking review; no invented subtraction or metadata principal |
| Missing/partial/contradictory D02, wrong owner/key/object/currency/mode, unknown version or ambiguous JSON | Blocking review; original evidence retained |

These are executed fixture/SQL contracts. Actual Stripe account availability, multicapture entitlement and delivery of every required field were not externally verified. Missing required evidence remains unsupported, not an invitation to loosen the predicate.

## 4. No future-effect dependency

Sealing succeeds with attempt PENDING, captured/fee0 and zero journals/lots/applications/permits/dispositions. Neither builder nor reader requires the capture's future success, journal or lot. Negative historical checks reject unrelated prior effects; they do not create or require this capture's effect. Authorization provenance is a genuine predecessor source, not a future capture lot.

The TypeScript adapter calls SQL seal/read/bind only. It does not calculate principal, normalize another provider monetary snapshot or perform a final workflow transition. The future accounting service and finality validators must consume this same SQL reader. A proof is evidence, not an application permit or a successful financial disposition.

## 5. Classification, revision and contradiction handling

The server-owned optional `admissionContract: PAYMENT_OPERATION_V2` selects the isolated atomic publisher. It is not a request/header/environment-controlled live flag, and no production composition supplies it. Default R1 publication remains contract1. Contract2 handles the four reviewed PI event types; pending refunds and nonfinancial customer events delegate to the original publisher and retain Option A behavior.

Existing admissions dispatch by stored version. Old PI-unclassified receipts cannot adopt a new payment proof. Contract1 refund/dispute proofs and historical rows remain unchanged. Existing R0.2 later-delivery publication continues selecting only its old proof type: payment proof UUIDs are never passed as bare old revisions. A changed delivery retains a conservative account-level barrier even when the original payment proof is bound; B1 opens no barrier recovery.

Sealing compares current `webhook_events.attempts` and expected obligation revision, locks the source ownership and freezes the proof. Exact replay returns the same UUID/fingerprint. Changed selectors/contradictions retain a review rather than alter proof identity. Proof interpretation/version, obligation revision and account/scope admission revisions are distinct. An unrelated intake revision does not reprice immutable evidence; stale expected binding/sealing revisions reject. Binding advances current guarded authority revisions and keeps AWAITING_APPLICATION. Its failure/rollback leaves the original unknown blocker; D02 authorization/capture obligations remain unresolved.

Initial capture/authorization failure issuance is closed: generic HTTP/SDK errors, timeout, PI failure status and absence of a journal do not prove definitive no effect. Unknown or contradictory evidence cannot become confirmed failure. A later failure never overwrites capture success or changes the attempt. B1 does not correct F05/F06 workflow behavior or finalize the inbox.

## 6. Privileges and immutability

Migration creates one dedicated `fintech_payment_evidence_<database digest>` NOLOGIN/NOINHERIT owner, with no superuser/role/database/replication/bypass authority. Only that capability's SQL inserts proofs/reviews. Guarded admission publication/binding remains owned by the existing admission owner, the only monotonic revision/obligation writer. Both use pinned `search_path=pg_catalog,pg_temp`, qualified tables and no PUBLIC EXECUTE on the new routines. No authenticated runtime LOGIN receives a grant or membership from migration0011.

The new isolated pool capabilities reject owner/elevated/inheriting/member logins and table **or column-only** trusted-source/evidence/financial writes. Tests use actual restricted LOGINs and demonstrate ordinary proof mutation, contract installation and ledger writes failing; a column-only proof grant and owner pool are rejected. These are disposable role grants, not operational provisioning.

UPDATE/DELETE/TRUNCATE cannot alter a sealed proof, including privileged test-setup attempts. Existing original receipts, D02 sources/obligations, journals, allocations and reviews retain their protections. Deferred proof validation compares the typed projection and exact source fingerprint with the shared facts routine. No application or no-effect clearance routine is introduced.

## 7. Transactions and concurrency

Sealer/binder require READ COMMITTED and each owns a fresh transaction. Order: own inbox → configured account UPDATE → canonical merchant/currency advisory → scope NO KEY UPDATE → payment NO KEY UPDATE → ordered attempts → immutable source/proof operations. No network call, financial suffix, account SHARE upgrade or another worker's inbox is introduced.

Proof-only commit and separate binding are intentional partial progress. A publication, proof or binding abort rolls back its entire transaction and is safely retried with the same immutable source identity. Whole-transaction40001/40P01 retries retain the existing restricted database policy; controlled schedules do not retry a deadlock into success.

Permanent observed schedules use distinct backend PIDs and `pg_blocking_pids`: same-inbox concurrent sealers; conflicting delivery before/after sealing; conflicting delivery before/after binding; and a legacy obligation writer blocking forward DDL. Sealer-first preserves its proof then later contradiction blocks the reader; delivery-first prevents a new proof. Binder-first retains scoped ownership plus the later independent barrier; delivery-first aborts binding and leaves the proof unknown/unbound. No journal/lot/workflow effect occurs in either order. These schedules do not establish universal deadlock freedom or full runtime coordination.

## 8. Migration compatibility

Fresh twelve-migration install and repeated no-op install pass. A populated0010 upgrade preserves fingerprints of historical journals/entries/lots/refund allocations, original receipts/old proofs/admissions and genuine D02 bytes/obligations. The fingerprint excludes only the newly added nullable proof column when comparing old obligation rows. Old classification and bound refund correlation are exercised after upgrade. Injected late0011 failure restores the prior tables, functions, constraints/roles and evidence; later complete installation succeeds. Forward DDL waiting is observed on a real distinct legacy writer.

The original R0.2 byte-level function/whole-row preservation checks are retained through the accepted0010 chain. They intentionally cannot compare a pre0011 function body or row JSON containing no new column with the changed0011 definitions. New B1 upgrade tests own those explicit forward changes. Current full-chain count updates do not alter financial expectations; the legacy service suite now repeats the same assertions on0009,0010 and0011.

All old SQL bytes and the first eleven migration-journal entries are preserved. The complete integration matrix retains the original R2-A ownership/refusal/permit/legacy tests and existing R0/R1/D02 suites. No schema push, history regeneration, current-policy adoption, ACTIVE scope or installed capture contract occurs. Installation in a shared environment still needs its separately authorized reviewed migration/drain window.

## 9. Executed verification

Environment: Windows Node24.19.0, cached pnpm10.26.0; isolated Docker PostgreSQL using the repository's `postgres:17-alpine` configuration. Docker access required the supported approved host execution path; sandbox access alone returned permission denied. No existing database/container/volume was used. Runner projects have fresh UUIDs, dynamic loopback ports, fixed fixture credentials, neutralized inherited dotenv and run-owned cleanup. Actual Stripe/broker/Redis boundaries remained fixtures.

| Command / scope | Result |
| --- | --- |
| `pnpm test:integration:docker`, full current chain/matrix | **PASS: 895 tests /30 suites; six intentional F01 skips** — includes all original828, seven additional0011 legacy checks and60 B1 cases. Final JSON `.tmp/fintech-verify-4e07f5a2-4840-49fd-8a91-d8f8fe32c5f2/jest.json` |
| `node .tmp/r2b1-verification.mjs focused` | **PASS: 60 tests /2 suites /0 skips** —56 evidence cases +4 migration cases; final JSON `.tmp/fintech-verify-28304928-db7a-498a-952e-d057532aa43a/jest.json` |
| Earlier complete matrix, before four additional race cases | **PASS: 891 tests /30 suites; six intentional F01 skips** — `.tmp/fintech-verify-eb9f1eea-5667-4abd-8755-54fe0fe016a0/jest.json`; focused results overlap and must not be added wholesale |
| `node .tmp/r2b1-verification.mjs f01`, with RUN_F01_PENDING=1 | **6 expected financial failures /0 skips** — original unchanged assertions, no new financial failure class; `.tmp/fintech-verify-91d76bc8-5fed-472b-8175-726cf89dd802/jest.json`. Jest/standard runner reports FAIL; separate verifier recognizes expected baseline failures, not a green F01 suite |
| `pnpm --filter @fintech-lab/api test:unit --cacheDirectory ../../.tmp/jest-r2b1-units` | **PASS: 50 tests /12 suites /0 skips** |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | **PASS** — API/web; final typecheck after build; no dependency installation/upgrade |
| `pnpm test:verification` | **PASS: 10 runner regressions**; separate from PostgreSQL application evidence |
| Documentation links/anchors, `git diff --check`, source/design/history and exact inventory checks | **PASS** — 61 Markdown files /1,030 relative links and anchors, zero errors; CI structure validated; unchanged19 Mermaid blocks inventoried, not rendered. Standard configured Windows `git diff --check` passes. Original SQL0000–0010, both design documents, untouched source/tests and first11 journal entries retain starting contents; index empty |
| Run-owned Docker cleanup inventory | **PASS** — all11 projects in retained execution logs have zero remaining containers, volumes or networks; `.tmp/r2b1-cleanup-inventory.json` |
| Hosted CI, Node22, native PostgreSQL18, live Stripe/webhook forwarding, RabbitMQ/Redis, deployed credentials/session fencing, activation | **NOT RUN** — outside this dormant local checkpoint; no readiness or finding-closure claim |

The ignored focused/F01 helper reuses the existing exported Docker verification runner and substitutes only the test selection. It retains the runner's fresh project/port/database/migration/environment/cleanup safeguards. F01 is enabled only in that separate invocation. No production consumer or reconciliation process starts.

Initial failures are retained in `.tmp/r2b1-*` logs: an unparenthesized CASE caused42601 at migration; local PL/pgSQL names `outcome`/`reason` caused42702; an already-blocked classification review was incorrectly replaced during a second refusal; current migration-count/fingerprint assumptions required explicit versioned test stages; TypeScript needed the reused HTTP response type exported, and lint caught unsafe test values/one unnecessary async. All were corrected without weakening financial assertions. The first focused runs progressed44 failures→29→1→0; no failure is relabeled as passing. One temporary helper invocation lacked pnpm's entry point and ran no Docker/tests; later helper invocations supply the installed entry point explicitly. A multiline cmd setup attempt executed no checks; only logged completed commands above are evidence.

## 10. Remaining B2/B3 dependencies and exclusions

- B2 must install the full typed capture prepare/validate/manifest/application/disposition and effective-admission contract, preserving cumulative fee delta, original journal/lot timestamps, exact account entries, claim fencing and both directions of finality. Current0010 remains closed for captures.
- B2 must verify complete historical effects on duplicate/lost-COMMIT replay and acknowledge each exact source without another total increment. It cannot compare today's whole payment row with a saved old `after` image or clear a different source through a PI match.
- Original authorization D02 AWAITING_APPLICATION remains an independent blocker. B1 does not clear it. B2 requires an explicitly complete prerequisite fixture or independently reviewed minimal authorization adapter before assembled capture application; never administrative hand-clearance. B3 owns genuine authorization finality, exactly one automatic capture child/outbox/key/authority/audit and replacement of prerequisite fixtures.
- B3 owns workflow-only void/failure finality and separately accepted F05 correction. No definitive Stripe failure issuer is accepted here. F06, corresponding refund completion, subsequent shared-PI capture support, historical D03 recovery and every later writer/cutover gate remain separate.
- Current event/parser versions, required request ID/key and complete original command bytes are deliberate support limits. Process-lost D02 bytes, unsupported histories, cumulative-only observations, unknown outcomes and ambiguous captured-void/remainder release remain blocked.

## 11. Focused review and independent priorities

What this change does: it persists immutable operation evidence while the future capture journal/lot do not exist. It adds a prospective classifier and restricted SQL correlation/binding without opening accounting.

The repository's `ponytail-review` checklist was applied to the complete source flow, grants, default R1 behavior and existing callers. Development findings were reported before correction: same-command D02 responses needed joint contradiction checks; pre-existing classification reviews needed preservation; publication needed contract1 delegation outside the PI allowlist; restricted capability checks needed to cover column-only writes. Permanent regressions now cover each. No remaining blocking self-review finding is claimed within this dormant scope. This is **not independent implementation approval**.

Independent reviewers should challenge:

1. Can metadata, an aggregate snapshot, a selected favorable response or a second shared-PI capture satisfy the shared facts reader? Check the separate zero baseline and actual request/event causation.
2. Can duplicate JSON keys, wrong owner/currency/account/mode, missing original bytes or an unreviewed API version become positive proof? Check actual authenticated roles, not owner substitution.
3. Do old contract1 rows retain interpretation on upgrade and later validation? Do typed NULL/both-proof attempts reject, and do existing review/delivery/D02 barriers survive proof/binding?
4. Does a proof read identically before any effect while a separate future application still cannot run? Verify no registry/enrollment, runtime registration, financial writes or terminal transition was introduced.
5. Are exact replay, source/claim revisions, rollback and both receipt/sealer/binder lock orders correctly enforced? Inspect deferred COMMIT failures as well as returned function results.
6. Preserve original migration/financial assertions and examine the explicit R0.2 fingerprint staging change. Source scan performance at production account scale, operational credential isolation and externally reachable Stripe evidence remain unverified boundaries; this lab checkpoint claims neither throughput nor deployment readiness.

No commit, push, deployment, ACTIVE scope, B2 implementation or live writer is authorized or performed by this record.

**Final verdict: READY_FOR_INDEPENDENT_REVIEW.**
