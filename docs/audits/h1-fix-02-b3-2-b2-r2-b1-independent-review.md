# H1 Fix 02 — B3.2 R2-B1 independent evidence foundation review

Date: **2026-10-21**. Verdict: **REQUEST_CHANGES**.

What this change does: B1 stores an immutable payment-operation proof before a capture journal or lot exists. It adds prospective signed-receipt classification and guarded proof binding while leaving financial application and runtime activation closed.

**Two P1 findings block acceptance.** The common SQL facts routine can select a favorable authorization baseline despite a contradictory response for that same authorization command. It also ignores contradictory signed success events under distinct event IDs. Both omissions affect sealing and the effective reader. Four independent correctness assertions fail; no implementation correction was made.

## 1. Exact baseline and complete review boundary

Checkout: `C:\Work\Learning Projects\learn-fintech`, branch `main`. Actual HEAD and the local `origin/main` reference are both **95757b737fbbf3b88cdab2dc4fb16572555b0f31**. The index was empty. No fetch was performed; equality with the local tracking reference does not assert a fresh remote state.

The starting tree contained **19 tracked modifications and eight untracked files**. The complete logical tracked diff was 103 insertions/29 deletions; untracked files are additional to that statistic. Read the diff and every new B1 implementation/test artifact, including all 565 lines of migration0011. The initial status, file SHA-256 inventory and full tracked patch are retained in ignored `.tmp/r2b1-review-baseline.{json,diff}`. Windows CRLF differences were distinguished from logical changes.

All starting paths are accounted for below. `apps/api/` prefixes are explicit; no unrelated starting work was discarded.

| Starting file | Reviewed change |
| --- | --- |
| `apps/api/drizzle/0011_payment_operation_evidence.sql` | New immutable proof relation, SQL facts/reader/sealer/binder, contract2 publisher and forward lifecycle/privilege changes |
| `apps/api/drizzle/meta/_journal.json` | Entry11 appended; previous eleven entries preserved |
| `apps/api/src/database/schema.ts` | Companion mapping, admission version alternative and typed obligation FK |
| `apps/api/src/webhooks/trusted-payment-operation-evidence.ts` | New SQL-only adapter |
| `apps/api/src/webhooks/trusted-receipt-database.ts` | Two payment capabilities and additional table/column privilege checks |
| `apps/api/src/webhooks/trusted-signed-receipt.service.ts` | Explicit isolated publication option; default R1 path retained |
| `apps/api/test/integration/payment-operation-evidence.spec.ts` | New56-case author suite |
| `apps/api/test/integration/payment-operation-migration.spec.ts` | New four-case author migration suite |
| `apps/api/test/support/payment-operation-harness.ts` | Accepted command, genuine SDK transport, signed receipt and restricted-login fixture composition |
| `apps/api/test/support/provider-observation-harness.ts` | Exposes existing receipt harness |
| `apps/api/test/support/trusted-receipt-harness.ts` | Exports HTTP response type; current migration count12 |
| `apps/api/test/integration/financial-application-legacy-compatibility.spec.ts` | Pins0009/0010 phases and repeats the same seven legacy checks at0011 |
| `apps/api/test/integration/receipt-delivery-migration.spec.ts` | Current count12; original whole-row/function fingerprint checks explicitly stop at0010 |
| `apps/api/test/integration/capture-accounting-migration.spec.ts` | Current full-chain count12 |
| `apps/api/test/integration/financial-application-migration.spec.ts` | Current full-chain count12 |
| `apps/api/test/integration/provider-observation-migration.spec.ts` | Current full-chain count12 |
| `apps/api/test/integration/receipt-admission-migration.spec.ts` | Current full-chain count12 |
| `apps/api/test/integration/trusted-evidence-migration.spec.ts` | Current full-chain count12 |
| `apps/api/test/integration/integrated-accounting-verification.spec.ts` | Current full-chain count12 |
| `apps/api/test/integration/settlement-accounting-integration.spec.ts` | Current full-chain count12 |
| `docs/README.md` | Three existing preflight/design/implementation links |
| `docs/database-design.md` | Author's dormant B1 contract description |
| `docs/webhooks-and-idempotency.md` | Author's isolated publication/evidence description |
| `docs/verification.md` | Author's execution record |
| `docs/audits/h1-fix-02-b3-2-b2-r2-b-capture-preflight.md` | Existing untracked approved preflight; preserved |
| `docs/audits/h1-fix-02-b3-2-b2-r2-b-independent-design-review.md` | Existing untracked design approval; preserved |
| `docs/audits/h1-fix-02-b3-2-b2-r2-b1-payment-operation-evidence.md` | Author's implementation record; preserved |

Authority read: repository AGENTS/CLAUDE, README/package scripts, task matrix, verification/workflow; complete [approved preflight](h1-fix-02-b3-2-b2-r2-b-capture-preflight.md), [B1 design approval](h1-fix-02-b3-2-b2-r2-b-independent-design-review.md), [R2 design](h1-fix-02-b3-2-b2-r2-financial-application-design.md), [R2 design acceptance](h1-fix-02-b3-2-b2-r2-design-review.md), [H01–H12/D01](h1-fix-02-b3-2-human-decisions.md), [R2-A final acceptance](h1-fix-02-b3-2-b2-r2-a-financial-application-foundation.md#25-final-independent-dormant-acceptance-and-hosted-source-verification) and [ownership re-review](h1-fix-02-b3-2-b2-r2-a-2-independent-review.md). Also read the [R1 contract](h1-fix-02-b3-2-b2-r1-signed-receipt-integration.md), [D02 contract](h1-fix-02-b3-2-b2-r2-d02-a-provider-observations.md), [native correction](h1-fix-02-b3-2-b2-r2-d02-a-r1-transport-correction.md), [D02 acceptance](h1-fix-02-b3-2-b2-r2-d02-a-r1-independent-review.md), current domain owners and the B1 implementation record.

Traced accepted payment/outbox/idempotency → existing Stripe adapter → dormant D02 transport/publication → signed receiver → SQL proof/sealing/reading/binding. Connected source includes the legacy webhook processor/business handler, normalizer, ledger posting/lot validation, migrations0006–0010 and runtime module references. Applied repository `ponytail-review` and PostgreSQL guidance. Expected use is concurrent, at-least-once workers; no production throughput claim was assessed.

| Starting artifact | Preserved SHA-256 |
| --- | --- |
| Approved preflight | `0df62d084996ae367d5de96148fb7e90940f63ea7e305807cef14f6fe28a5ced` |
| Independent B1 design approval | `8e2a4407ed4547fb03b8caa3749566e13573ab99d2707749cb944e50bd98cbfd` |
| Author B1 implementation record | `45eaefa02e745c76841b3e64a3e6c3167b69e26c03f69d32c79c11350fa05ca6` |
| Reviewed migration0011 | `17661e37dfc70ceb137e78548d23bae0d393155ebffa8bc15c563dd486cbcc6e` |
| Accepted migration0010 | `50c6caee59d6e49a53728a0269733521ee0b31aaccd548428824d3f8916a3c17` |

This review adds only [the reviewer suite](../../apps/api/test/integration/payment-operation-review.spec.ts), this report and one additive index link. Existing implementation, author assertions and earlier evidence records remain unchanged. No staging, commit, push, B2 work or accounting-policy change occurred.

## 2. Pre-lot proof independence

**Demonstrated for otherwise consistent supported sources.** The three author capture cases cover first complete10000, first non-final partial4000 and first final partial4000. They seal and read a positive exact principal with CAPTURE attempt PENDING, captured/fee0 and zero journals, lots, applications, permits or dispositions. The reviewer independently repeats the non-final partial4000 case and verifies source IDs and zero effects.

[SQL facts](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L159) consume acceptance, original D02 exchanges and the original signed receipt. Negative checks for distinct prior captures do not require a future journal/lot. [Sealing](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L300), the deferred seal validator and [effective reading](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L286) use that common interpretation. The [TypeScript adapter](../../apps/api/src/webhooks/trusted-payment-operation-evidence.ts) supplies selectors, with no independent monetary calculation.

Proof UUID/version/source set and financial facts are immutable. Exact replay returns the same proof; a changed source selection cannot silently replace it. Proof version1, admission contract2, claim generation and obligation/account/scope revisions remain distinct. UPDATE/DELETE/TRUNCATE refusal and original fingerprint preservation pass. **Common interpretation does not establish complete interpretation:** both P1 omissions in §10 are shared by the sealer and reader.

## 3. Operation-specific capture principal

The implemented conjunction checks accepted CAPTURE amount/key/owner, actual POST path/form/final flag, complete2xx response, signed request ID/key, same PI/Charge/account/mode/currency, exact integer principal and an independent owned manual authorization with received0/capacityH. Final capture requires succeeded/remaining0; non-final partial requires receivedA/remainingH−A and signed previous capturableH. No accounting journal supplies the amount.

| Pattern | Independently observed result and limit |
| --- | --- |
| First complete capture10000 | Author PostgreSQL proof/binding assertions pass before financial effects |
| First non-final partial4000 of10000 | Author and reviewer controls pass; exact principal4000, no monetary effect |
| First final partial4000 | Author proof test passes using a prospectively accepted final command; current manual API still emits final=false for a partial request |
| Cumulative snapshot, metadata-only amount, missing causal request/key/ID, incomplete/missing D02 or zero provenance | Author refusal assertions pass |
| Wrong owner, amount, currency, account/mode, PI/Charge, unknown API version or duplicate JSON keys | Author refusal assertions pass |
| Subsequent shared-PI partial capture | Explicit refusal tests pass; no supported predecessor-chain/subtraction interpretation exists |
| Conflicting authorization baseline or distinct contradictory signed success | **FAIL:** favorable-source proof remains issuable/readable; §10 |

Current official [capture parameters](https://docs.stripe.com/api/payment_intents/capture) distinguish requested principal and final release. The [multicapture contract](https://docs.stripe.com/payments/multicapture?platform=web&ui=elements) describes cumulative received amounts and capturable-update events. The [Event contract](https://docs.stripe.com/api/events/object) identifies rendering version and request causation. These support the engineering interpretation; fixtures do not demonstrate that a particular Stripe account supplies every required field or has multicapture access.

No supported amount is accepted from metadata, mutable mirrors or status alone. However, the supported scope is not fully established while contradictory evidence can be omitted from the SQL conjunction. This is an evidence-consistency blocker, even though no B1 money movement is executable.

## 4. Source authenticity and provenance

The unchanged D02 producer prepares immutable execution authority before invoking the installed Stripe SDK/adapter through its captured transport. Retained source records distinguish command results from lookups, complete/partial/absent bytes, request identity/version and original accepted outbox/key. B1 reads those sources directly and does not fabricate a CAPTURE projection. The native transport/retry suites pass independently in the full matrix.

The signed receiver verifies copied original bytes using the SDK and configured account/secret before SQL. Original receipt, classification and mandatory obligation commit atomically. Exact/equivalent later deliveries retain their own provenance; same-ID contradictions preserve independent immutable barriers. B1's parser checks duplicate JSON keys before jsonb conversion and validates actual retained form/response facts.

SQL trusts the restricted transport/verifier attesters for external authenticity; it does not authenticate TLS or recompute HMAC. Tests use actual restricted LOGIN connections, controlled SDK transport and locally generated valid signatures. No real Stripe evidence was fetched. The new findings use genuinely received fixture evidence through these unchanged paths, rather than direct insertion of invented trusted source rows. A distinct event ID takes the original-publication path and receives no same-inbox delivery barrier; that distinction exposes IR02.

## 5. Classification and lifecycle handling

Prospective contract2 classifies reviewed PI events; stored contract1 rows retain their old algorithm. Nonpayment events delegate to the original publisher, preserving genuine pending-refund neutrality and nonfinancial classification. Old unclassified PI admissions cannot adopt payment proofs. The server-owned isolated option has no production caller.

Capture success, authorization and explicit zero-captured void have separate proof shapes/principal fields. Automatic CAPTURE_FAILED/AUTHORIZE_FAILED issuance is closed. Generic errors, timeouts and PI failure events do not authorize definitive no effect. Both signed failure-before-success and success-before-failure refusal cases pass; original proof identity and nonterminal attempt survive. This proves B1 evidence refusal, not B3 workflow terminality or F05 correction.

Proof-only commit retains unknown AWAITING_CORRELATION. Binding is a separate guarded transaction, produces scoped AWAITING_APPLICATION, advances revisions and clears neither D02 nor delivery/review obligations. Wrong expected revision, binding rollback and exact retry assertions pass. Existing D02 authorization AWAITING_APPLICATION and capture attribution blockers remain. There is no successful financial/no-effect disposition, inbox finalization or recovery authority in B1.

## 6. SQL authority, constraints and immutability

Reviewed composite FKs from proof to owned attempt/payment/merchant/currency, source/outbox and execution/outbox, plus the typed receipt-obligation alternative. SQL shape checks disallow missing/both proofs and partial owner tuples. Three new reviewer cases exercise these invalid forms in real PostgreSQL and require the named `receipt_obligation_typed_owner` CHECK to reject; rollback preserves the original unbound revision0 row. These tests use administrator SET LOCAL ROLE only to isolate the constraint. They do not stand in for the separate authenticated-login capability tests.

The dedicated payment evidence owner is NOLOGIN/NOINHERIT with no elevated role attributes. New definer functions pin `pg_catalog,pg_temp`, qualify persistent tables and revoke PUBLIC EXECUTE. Migration0011 grants no authenticated runtime LOGIN or membership. Actual publisher/correlator tests reject owner pools, direct protected proof/financial writes and a column-only proof INSERT privilege. Original source/evidence immutability is retained.

Deferred proof validation recomputes checked facts/fingerprint and validates the typed projection; receipt-obligation validation dispatches by stored admission version and keeps contract2 final clearance closed. The SQL-only adapter shares the same authoritative reader. No new permit, registry entry or scope authority is minted. Security of that authority depends on correcting the source-set omissions in §10.

## 7. Migration and R2-A compatibility

The four B1 migration cases pass independently inside the full matrix: fresh/repeated twelve-migration installation; populated0010 upgrade preserving financial/receipt/proof/D02 fingerprints and old bound refund behavior; injected late0011 rejection with transactional rollback and later successful install; and an observed distinct-backend legacy writer blocking forward DDL until released.

The fingerprint comparison deliberately removes only the newly nullable payment-proof column from historical obligation row JSON. Existing R0.2 whole-row/function fingerprints are still checked through0010; B1's new suite owns the intentional0011 change. The legacy suite separately executes identical seven scenarios at0009,0010 and0011: **21 passed**, with unchanged results and preserved upgrade fingerprints. No financial expectation was relaxed to obtain compatibility.

Migrations0000–0010 and the first eleven journal entries remain unchanged. Migration0010's corrected authoritative effect-owner discovery, current transaction/backend/principal permits, old refund-only proof preparation and immediate/deferred reverse finality are unchanged. Original five R2-A reviewer cases,33 ownership cases,35 foundation cases and five migration cases all pass. Capture preparation remains closed; the manifest still references the old proof type. No scope becomes ACTIVE and no new-policy financial application was demonstrated or enabled.

## 8. Concurrency, idempotency and recovery

The author B1 suite independently passes its observed same-inbox concurrent sealer wait and four conflicting-delivery/sealer/binder orders. Tests identify distinct backend PIDs, observe `pg_blocking_pids`, use bounded gates, release/await participants and inspect committed proof/blocker state. Migration DDL waiting is also observed. The common order remains own inbox → account UPDATE → canonical merchant/currency advisory → scope → payment NO KEY UPDATE → ordered attempts. Network calls remain outside these transactions.

Permanent executed cases also cover duplicate publication/sealing, coherent distinct receipt identities, contradictory same-command capture responses, retained late failures, missing sources, stale obligation revision, rollback of publication/proof/binding and same-source retry. The reviewer adds pre-seal and post-seal schedules for each newly reproduced omission. Those are deterministic sequential arrival orders, not additional observed concurrent lock schedules.

No universal concurrency/deadlock guarantee follows. Actual worker kill, database-wire COMMIT-response loss, all provider orderings, later accounting replay and B2 source clearance are unverified. In particular a common lock cannot make an incomplete source predicate detect a contradiction it never reads.

## 9. Independently executed verification

Environment: Windows host, **Node24.19.0**, cached **pnpm10.26.0**, Docker Engine29.9.1. Actual reviewer server: **PostgreSQL17.11 on x86_64-pc-linux-musl, gcc (Alpine15.2.0)15.2.0,64-bit**. The runner uses `postgres:17-alpine`, fresh UUID Compose projects/volumes, dynamic loopback ports, fixture credentials and neutralized inherited dotenv. It starts no provider worker/broker/Redis service. Every executed run cleaned up only its own project.

| Check / exact command | Result |
| --- | --- |
| `pnpm test:integration:docker` using cached pinned pnpm | **PASS:895 passed /0 failed /6 intentional F01 skips;30 passing suites**. Runner discovery preceded creation of the reviewer suite. JSON `.tmp/fintech-verify-2f9ea601-1abf-4edc-a6f7-1a0f70c49571/jest.json`;311.351s |
| `node .tmp/r2b1-review-verify.mjs review` | **FAIL:5 passed /4 failed /0 skipped;one reviewer suite**. Final nine-case JSON `.tmp/fintech-verify-d727b3af-6110-4c1c-a290-17ad09a64c48/jest.json`;11.224s |
| `node .tmp/r2b1-review-verify.mjs f01` with RUN_F01_PENDING=1 | **FAIL:0 passed /6 expected historical financial failures /0 skipped**. JSON `.tmp/fintech-verify-998dd49a-6570-4931-9ae1-89f214e2332b/jest.json`. All six names/statuses/financial assertion texts match author baseline `.tmp/fintech-verify-91d76bc8-5fed-472b-8175-726cf89dd802/jest.json`, after removing ANSI formatting and stack traces |
| `pnpm --filter @fintech-lab/api test:unit --cacheDirectory ../../.tmp/jest-r2b1-review-unit --json --outputFile ../../.tmp/r2b1-review-unit.json` | **PASS:50 cases /12 suites /0 skips** |
| `pnpm lint`; `pnpm build`; post-build `pnpm typecheck` | **PASS:API/web** on final host-access run. Additional final API lint/typecheck cover the three last reviewer constraint cases |
| `pnpm test:verification` | **PASS:10 runner regressions**; separate from application PostgreSQL tests |
| Documentation links/anchors/CI structure and source-link bounds; `git diff --check`; new-file whitespace; baseline preservation | **PASS**; final completion evidence below |
| Hosted CI, Node22, native PostgreSQL18, live provider/broker/Redis, deployed ACL/fence, activation | **NOT RUN**; outside this local dormant review |

`pnpm` above denotes `node C:/Users/Daniel/AppData/Local/node/corepack/v1/pnpm/10.26.0/bin/pnpm.cjs`. Recursive static commands use task-local COREPACK_HOME for that existing cache and COREPACK_ENABLE_NETWORK=0. No dependency installation/upgrade occurred. The ignored focused helper imports the existing exported Docker runner and changes only Jest selection; it preserves isolated setup/migration/environment/cleanup. A nonzero reviewer/F01 result remains FAIL and is not converted to a green application result.

Complete full-matrix suite inventory, all passing except the explicitly skipped F01 row:

| Suite filename under `apps/api/test/integration/` | Passed | Skipped |
| --- | ---: | ---: |
| `capture-accounting-foundation.spec.ts` |30 |0 |
| `capture-accounting-integration.spec.ts` |27 |0 |
| `capture-accounting-migration.spec.ts` |5 |0 |
| `refund-accounting-integration.spec.ts` |63 |0 |
| `dispute-accounting-integration.spec.ts` |70 |0 |
| `settlement-accounting-integration.spec.ts` |73 |0 |
| `integrated-accounting-verification.spec.ts` |44 |0 |
| `posted-ledger-immutability.spec.ts` |17 |0 |
| `financial-concurrency.spec.ts` |5 |0 |
| `trusted-financial-evidence.spec.ts` |64 |0 |
| `trusted-evidence-migration.spec.ts` |6 |0 |
| `receipt-admission.spec.ts` |50 |0 |
| `receipt-admission-review-regressions.spec.ts` |31 |0 |
| `receipt-admission-migration.spec.ts` |6 |0 |
| `receipt-delivery-conflicts.spec.ts` |56 |0 |
| `receipt-delivery-migration.spec.ts` |6 |0 |
| `trusted-signed-receipt-integration.spec.ts` |65 |0 |
| `trusted-signed-receipt-review.spec.ts` |15 |0 |
| `provider-observations.spec.ts` |51 |0 |
| `provider-observation-native-transport.spec.ts` |17 |0 |
| `provider-observation-sql-review.spec.ts` |29 |0 |
| `provider-observation-review.spec.ts` |4 |0 |
| `provider-observation-migration.spec.ts` |2 |0 |
| `financial-application-foundation.spec.ts` |35 |0 |
| `financial-application-ownership.spec.ts` |33 |0 |
| `financial-application-review.spec.ts` |5 |0 |
| `financial-application-migration.spec.ts` |5 |0 |
| `financial-application-legacy-compatibility.spec.ts` |21 |0 |
| `payment-operation-evidence.spec.ts` |56 |0 |
| `payment-operation-migration.spec.ts` |4 |0 |
| `settlement-f01.pending.spec.ts` |0 |6 |
| **Total** |**895** |**6** |

These895 include the60 B1 author cases,828 prior accepted cases and seven added0011 legacy checks. Focused repeats are not additional distinct coverage. The nine new reviewer cases are separate: five controls/constraint refusals pass and four acceptance assertions fail. Across distinct ordinary/reviewer cases: **900 pass,4 fail**, with F01's six separately executed expected failures reported independently.

The final reviewer `afterAll` reads committed database state, writes ignored `.tmp/r2b1-review-committed.json`, and asserts zero ACTIVE scopes/contracts/enrollments/permits/applications/dispositions/journals/lots. It records immutable proofs, still-unbound AWAITING_CORRELATION obligations and competing source amounts. This includes proofs wrongly accepted by the failing tests; it is not merely an assertion about returned service objects.

Initial attempts are not passing evidence: Docker was stopped and the default Corepack cache attempted an unavailable registry lookup; Docker Desktop was started in the background and the installed cache selected. The first six-case reviewer run failed on a reviewer-only `financial_applications.id` typo before its intended assertions; corrected to `root_id`. The next run exposed the four actual acceptance failures with two controls passing. Typed reviewer result access fixed two lint errors without changing acceptance assertions. A sandbox Next build failed with EPERM creating output; the host-access build passed. Final extra constraint cases preserve all original four failing assertions. No implementation or author test was altered to obtain results.

## 10. Findings — must fix

### 1. B1-IR01 / P1 — a favorable authorization source hides contradictory baseline evidence

**What this is:** the first-capture principal depends on an independently owned zero-received authorization. [Baseline selection](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L201) checks the selected authorization source. [Competing-source checks](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L251) consider coarse D02 blocking classifications for both commands, but the detailed returned-object loop at [line258](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L258) iterates only `a.outbox_id`, the capture command.

**Problem:** publish the original authorization response with received0/capturable10000, then a second genuine COMMAND_RESULT for the **same authorization outbox/key/PI** with received4000/capturable6000/status requires_capture. D02 classifies both `CONFIRMED_PROVIDER_RESULT`; its coarse authorization classifier does not establish B1's zero baseline. Selecting the first source still seals CAPTURE_SUCCEEDED principal10000. If the contradiction arrives after sealing, the SQL reader still returns that proof. The immutable second source survives but is omitted from the proof's truth check.

**Evidence:** reviewer [pre-seal assertion](../../apps/api/test/integration/payment-operation-review.spec.ts#L80) expected BLOCKING_REVIEW and received SEALED. The [post-seal assertion](../../apps/api/test/integration/payment-operation-review.spec.ts#L87) expected reader rejection; it resolved with capture_principal10000. Both fail in PostgreSQL17.11. The second source is produced through the real SDK fixture/transport and restricted D02 publisher, with its classification explicitly asserted. No direct source-table fabrication is used.

**Fix:** extend the common SQL interpretation to validate all relevant same-authorization COMMAND_RESULT witnesses against the selected baseline's immutable owner/object/amount/zero-capture semantics. Refuse incompatible baselines during sealing and effective reading; preserve the original proof/source bytes. Do not compare a legitimate later current-state lookup indiscriminately with an earlier historical authorization snapshot. The exact supported source-equivalence contract needs focused regression review.

**If skipped:** future consumers can receive an authoritative first-capture proof whose essential zero baseline is contradicted by retained evidence. Current money gates remain closed, but the evidence checkpoint fails its approved acceptance condition. This is P1 for B1 acceptance, not a claim of already executable production money loss.

### 2. B1-IR02 / P1 — a distinct signed success can contradict principal without blocking the proof reader

**What this is:** same-event contradictory deliveries are covered by receipt delivery barriers. Independent event IDs are separate original admissions. The cross-receipt check at [SQL0011:273](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L273) looks only for `payment_intent.payment_failed`.

**Problem:** retain a valid capture response and signed success with received10000. Admit another SDK-verified `payment_intent.succeeded` with a different event ID but the **same configured account, request ID/key, PI/Charge and accepted capture identity**, reporting received9999. It becomes a separate contract2 `payment.capture_succeeded` original. Sealing the favorable10000 event still succeeds; admitting it after sealing also leaves the original reader successful. The new event is neither a same-inbox delivery barrier nor the failure type in the cross-receipt predicate.

**Evidence:** reviewer [before-seal](../../apps/api/test/integration/payment-operation-review.spec.ts#L99) and [after-seal](../../apps/api/test/integration/payment-operation-review.spec.ts#L106) assertions both fail: SEALED replaces the expected BLOCKING_REVIEW, and the reader resolves instead of rejecting. The [coherent distinct-event control](../../apps/api/test/integration/payment-operation-review.spec.ts#L114) passes and seals each independently attributable source, so the required correction is semantic contradiction handling, not rejection of all distinct events.

**Fix:** have the shared SQL facts/reader inspect separately retained signed evidence causally identifying the same accepted operation, rejecting incompatible principal/currency/object/outcome/phase facts while retaining coherent duplicates and valid lifecycle distinctions. Account/key/causal ownership must be checked before combining sources. Preserve each original and its obligation; do not rewrite a proof or absorb a new cause into an old revision.

**If skipped:** incompatible authenticated principal observations coexist with a supposedly effective successful capture proof. The other event's unknown obligation still blocks the general admission reader today; that containment does not satisfy B1's required ambiguity refusal or authorize B2 to treat the proof as a complete consistency oracle.

No additional P0/P1 finding was confirmed. Neither finding is corrected in this review. They are realization defects relative to the approved B1 source-consistency contract, not requests to reopen fee/accounting policy.

## 11. Unsupported cases, dormancy and remaining dependencies

Source/reference inspection confirms no new production handler/worker/module registration. `TrustedPaymentOperationEvidence` and PAYMENT_OPERATION_V2 appear only in isolated support/source declarations, not a live composition. Existing financial writers are unchanged. Migration0011 creates no financial operation contract, enrollment or ACTIVE scope, and keeps the R2-A capture path closed. Legacy behavior, including its known defects, is preserved.

Still unsupported: subsequent shared-PI captures; missing original command bytes or signed causal ID/key; unknown parser/API versions; metadata/mirror/aggregate-only attribution; historical unclassified admissions; captured-remainder voids; automatic definitive failure issuance; broad barrier recovery. Stripe account entitlement, actual delivery shapes, real TLS/account rights and operational credential isolation remain unverified. Conservative exclusion is required; fixture support must not become an external provider guarantee.

B2 still owns typed capture preparation/validation, exact fee/journal/lot/workflow/audit/application/source disposition, claim fencing, bidirectional finality and historical duplicate/lost-COMMIT acknowledgment. The genuine authorization D02 obligation needs a complete reviewed prerequisite disposition, not administrative clearance. B3 owns authorization/void workflow finality, exactly one automatic child group, supported no-effect predicates and separate F05 acceptance. F06, active-path F04, legacy F01, D03, all-writer coordination, deployed roles/session fencing, hosted/external checks and explicit activation remain separate gates.

## 12. Final verdict and preservation

**REQUEST_CHANGES** — fix B1-IR01 and B1-IR02 before accepting this dormant evidence checkpoint or beginning B2. Pre-lot independence, narrow first-capture controls, immutability, migration/legacy compatibility and dormant containment are demonstrated. Complete contradiction-aware source interpretation is not.

Preserve the original author suites/implementation record, approved design records, migration history and all four reviewer acceptance assertions. Review a source-consistency correction separately, rerun the unchanged reviewer cases and relevant PostgreSQL matrix, and keep runtime/accounting gates closed. No unsupported monetary writer or activation was introduced by this review. No commit or push occurred.

Final `node .tmp/r2b1-review-final-check.cjs cleanup` passed: **62 Markdown files /1,056 relative links and anchors**, valid source-line bounds, CI YAML structure, final newlines and whitespace. The19 existing Mermaid blocks were inventoried, not parsed or rendered. All27 starting files retain their exact bytes after removing only the added index line; all11 historical migrations match their starting bytes and HEAD after newline normalization, and the original eleven journal entries are unchanged. HEAD/local origin and the empty index are preserved. The only three review deliverables are the reviewer suite, this report and the index addition.

Read-only Docker inventory found zero containers, volumes or networks for all six review-owned projects, including failed reviewer/F01 runs. No global cleanup was executed; Docker Desktop remains running after this authorized test work. Ignored local evidence is retained and is not a replacement for the permanent regression suite. No implementation correction, monetary effect, scope activation, commit or push occurred.
