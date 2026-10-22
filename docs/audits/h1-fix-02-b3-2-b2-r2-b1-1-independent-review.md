# H1 Fix 02 — B3.2 R2-B1.1 independent contradictory evidence re-review

Date: **2026-10-21**. Verdict: **REQUEST_CHANGES**.

What this change does: B1.1 extends the dormant SQL payment-evidence reader to competing historical authorization responses and causally related signed events. The four original failing assertions now pass unchanged. Independent additional tests nevertheless reproduce one P1 source-selection defect and two P2 acceptance defects; the evidence checkpoint is not approved.

No author SQL, original assertion, monetary policy, runtime registration or historical report was changed. This review adds its own regression suite, this record and one documentation navigation entry. It does not begin B2, activate a scope, commit or push.

## 1. Exact reviewed baseline and complete diff

Checkout: `C:\Work\Learning Projects\learn-fintech`, branch `main`. HEAD and the local `origin/main` reference both resolve to **95757b737fbbf3b88cdab2dc4fb16572555b0f31**. The index was empty. No fetch was performed; this is not a claim about current remote state.

The starting tree contained **19 tracked modifications and 12 untracked files**, over 393 inventoried repository files. The tracked patch contained **113 insertions / 29 deletions**; untracked contents are additional. The complete status, SHA-256 inventory and tracked patch are retained in ignored `.tmp/r2b11-rereview-baseline.json` and `.tmp/r2b11-rereview-baseline.diff`. Read the complete corrected migration and new implementation, harnesses, tests and records, not merely Git's tracked patch.

| Starting path | Reviewed scope |
| --- | --- |
| `apps/api/drizzle/0011_payment_operation_evidence.sql` | Complete proof relation, parser/facts routine, sealer, reader, binder, deferred validation, versioned publication and privileges |
| `apps/api/drizzle/meta/_journal.json` | Only entry11 appended; earlier eleven entries preserved |
| `apps/api/src/database/schema.ts` | Proof mapping, contract2 and tagged obligation FK/CHECK |
| `apps/api/src/webhooks/trusted-payment-operation-evidence.ts` | SQL selector-only adapter |
| `apps/api/src/webhooks/trusted-receipt-database.ts` | Payment capabilities and table/column write-capability refusal |
| `apps/api/src/webhooks/trusted-signed-receipt.service.ts` | Explicit isolated contract2 option; existing default publication retained |
| `apps/api/test/integration/payment-operation-review.spec.ts` | All nine original reviewer cases, unchanged |
| `apps/api/test/integration/payment-operation-contradictions.spec.ts` | All 28 supplemental cases |
| `apps/api/test/integration/payment-operation-evidence.spec.ts` | All 56 original B1 cases |
| `apps/api/test/integration/payment-operation-migration.spec.ts` | All four B1 migration cases |
| `apps/api/test/support/payment-operation-harness.ts` | Accepted-command, genuine SDK transport, signed receipt and restricted LOGIN composition |
| `apps/api/test/support/provider-observation-harness.ts` | Exposes existing receipt harness |
| `apps/api/test/support/trusted-receipt-harness.ts` | HTTP response type export and migration count12 |
| `apps/api/test/integration/financial-application-legacy-compatibility.spec.ts` | Same seven legacy scenarios at0009,0010 and0011 |
| `apps/api/test/integration/receipt-delivery-migration.spec.ts` | Full-chain count12; old whole-row/function fingerprint checks explicitly staged through0010 |
| `apps/api/test/integration/capture-accounting-migration.spec.ts` | Current-chain count12 |
| `apps/api/test/integration/financial-application-migration.spec.ts` | Current-chain count12 |
| `apps/api/test/integration/provider-observation-migration.spec.ts` | Current-chain count12 |
| `apps/api/test/integration/receipt-admission-migration.spec.ts` | Current-chain count12 |
| `apps/api/test/integration/trusted-evidence-migration.spec.ts` | Current-chain count12 |
| `apps/api/test/integration/integrated-accounting-verification.spec.ts` | Current-chain count12 |
| `apps/api/test/integration/settlement-accounting-integration.spec.ts` | Current-chain count12 |
| `docs/README.md` | Five existing B1/preflight/design/review/correction links |
| `docs/database-design.md` | B1 contract and B1.1 correction description |
| `docs/webhooks-and-idempotency.md` | Isolated publication/proof and contradiction description |
| `docs/verification.md` | Historical author execution records |
| `docs/audits/h1-fix-02-b3-2-b2-r2-b-capture-preflight.md` | Approved preflight, preserved |
| `docs/audits/h1-fix-02-b3-2-b2-r2-b-independent-design-review.md` | Design approval, preserved |
| `docs/audits/h1-fix-02-b3-2-b2-r2-b1-payment-operation-evidence.md` | Original implementation history, preserved |
| `docs/audits/h1-fix-02-b3-2-b2-r2-b1-independent-review.md` | Original REQUEST_CHANGES and four failed assertions, preserved |
| `docs/audits/h1-fix-02-b3-2-b2-r2-b1-1-contradictory-evidence-correction.md` | Correction history and READY_FOR_RE_REVIEW claim, preserved |

Review authority: repository AGENTS/CLAUDE, README/package scripts, task matrix, verification/workflow and applicable domain owners; [approved preflight](h1-fix-02-b3-2-b2-r2-b-capture-preflight.md), [design approval](h1-fix-02-b3-2-b2-r2-b-independent-design-review.md), [original review](h1-fix-02-b3-2-b2-r2-b1-independent-review.md), [correction record](h1-fix-02-b3-2-b2-r2-b1-1-contradictory-evidence-correction.md), [R1 contract](h1-fix-02-b3-2-b2-r1-signed-receipt-integration.md), [D02 contract](h1-fix-02-b3-2-b2-r2-d02-a-provider-observations.md), [native transport correction](h1-fix-02-b3-2-b2-r2-d02-a-r1-transport-correction.md), [D02 acceptance](h1-fix-02-b3-2-b2-r2-d02-a-r1-independent-review.md), [R2-A ownership acceptance](h1-fix-02-b3-2-b2-r2-a-2-independent-review.md), [R2 design acceptance](h1-fix-02-b3-2-b2-r2-design-review.md) and [human decisions](h1-fix-02-b3-2-human-decisions.md).

Applied the repository `ponytail-review` and PostgreSQL skills. Traced accepted attempt/outbox/key → D02 retained exchange → R1 authenticated receipt → shared SQL facts → proof/deferred validator/effective reader → separate binding, plus0010 ownership/permit/finality and production callers. Expected use is concurrent, at-least-once lab workers; production throughput was not assessed.

| Artifact | Independently checked SHA-256 |
| --- | --- |
| Reviewed0011 | `7379ada3e3324eebe87eaf7f1a6b720cc283b7bdd47d4c7672255ed109f1f1f6` |
| Original nine-case reviewer suite | `865681095d5dcd72ad77ccab4c69a3f9dd1882f88c454f8d00b5d8ba577113c6` |
| Additional nine-case re-review suite | `34c40e9b69d14a135bcca02920966e545c4652dea17e4e4d734663286a030aa9` |
| Accepted0010 | `50c6caee59d6e49a53728a0269733521ee0b31aaccd548428824d3f8916a3c17` |
| Reconstructed original0011 used by correction history | `17661e37dfc70ceb137e78548d23bae0d393155ebffa8bc15c563dd486cbcc6e` |

B1.1 changes only `payment_operation_facts` within0011: the recorded84 insertions/5 deletions match the retained original, with byte-identical prefix/suffix outside that routine. SQL0000–0010 and the journal prefix match the accepted HEAD after newline normalization and retain their starting bytes. The author's seven correction deliverables are distinguished from the larger original B1 worktree above.

## 2. Original P1 root causes and correction disposition

| Original finding | Original failure | Independent current result |
| --- | --- | --- |
| B1-IR01 / P1-A | Selecting received0 authorization hid a second same-command response with received4000/capturable6000 | **Original reproduction resolved.** Both before-seal and late-reader assertions pass. |
| B1-IR02 / P1-B | A separately signed success with another event ID but the same accepted command/request/PI reported received9999 without invalidating10000 proof | **Original reproduction resolved.** Both before-seal and late-reader assertions pass. Broader source consistency still fails finding1 below. |

The original adverse report is not rewritten into approval. Passing these four cases establishes their correction, not completeness of the new source interpretation.

## 3. Corrected SQL predicates and retained authority

[Authorization comparison](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L268) enumerates other RETURNED_OBJECT / COMMAND_RESULT rows for the selected predecessor authorization's authoritative outbox. Each passes `checked_payment_command_source`: actual POST path/form/key/account, complete2xx bytes, pinned SDK/API version, mode, currency and retained normalization. It then compares PI/object/Charge, status/manual method, face/received/capturable amounts and explicit merchant/payment/authorization-attempt/currency metadata. No latest-row or favorable LIMIT selects away another result. A current PROVIDER_LOOKUP is deliberately excluded from historical zero-baseline equality; it cannot replace a COMMAND_RESULT selector.

[Signed discovery](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L298) enumerates same-configured-account originals and later deliveries across event IDs. Accepted command key **or** retained same-command response request ID makes a candidate relevant; after matching, both key and attested request ID must agree. Capture and predecessor authorization are compared to their respective responses. Peer checks include amount/currency/PI/Charge/mode/status/type, applicable method/cancellation/previous-capacity facts, metadata, normalization and CONFLICT delivery classification. Separate pending accepted operations are not combined merely through PI/amount/metadata.

R1 still verifies copied exact bytes with the SDK before SQL; D02 still prepares immutable authority before transport and retains actual exchanges. SQL trusts these restricted authenticity capabilities, then checks causal/financial facts itself. No original bytes, source fingerprint, accepted key, obligation or old classification is rewritten. The [Stripe Event contract](https://docs.stripe.com/api/events/object) distinguishes event identity from the request that caused it; the SQL ownership interpretation is this repository's additional contract.

The new peer checks are stronger than selected-primary checks for capture method, and strict parsing runs before causal relevance. Those differences produce findings1 and2. Standalone authorization still follows the old exact-object response comparison, producing finding3.

## 4. All nine original reviewer cases, unchanged

The entire original file retains the recorded byte hash, including assertions, comments and fixtures. It passed independently inside both the full matrix and the97-case focused run: **9 passed /0 failed /0 skipped**.

| Original case | Observed SQL/committed result |
| --- | --- |
| First partial4000 before effects | SEALED; exact principal4000 with both original sources; captured/fee0, pending attempt, no journal/lot |
| Competing authorization before seal | BLOCKING_REVIEW, original immutable sources retained |
| Late contradictory authorization | Reader raises; sealed UUID/fingerprint preserved |
| Distinct incompatible signed success before seal | BLOCKING_REVIEW |
| Late distinct incompatible signed success | Reader raises |
| Distinct coherent signed success | Each original can seal its own proof; no monetary effect |
| Neither proof owner | Named `receipt_obligation_typed_owner` CHECK rejects; original unbound revision0 survives |
| Both proof owners | Same named CHECK rejects; original row survives |
| Partial owner tuple | Same named CHECK rejects; original row survives |

The suite's committed-state query independently asserts zero ACTIVE scopes, contracts, enrollments, permits, applications, dispositions, journals and lots. These checks use actual PostgreSQL commits, not mock return objects.

## 5. Assessment of the28 supplements

All28 pass unchanged in focused and full runs. They test distinct risks, rather than28 copies of one happy path:

| Count | Meaningful coverage |
| ---: | --- |
| 1 | Semantically equivalent enriched predecessor-authorization retries preserve proof facts |
| 6 | Predecessor PI, Charge, received baseline, capturable baseline, manual method and explicit currency metadata contradictions |
| 1 | Legitimate current authorization lookup remains separate from its historical baseline |
| 1 | Exact repeated authorization/void responses, both operations within one case |
| 9 | Distinct signed principal, currency, PI, Charge, mode, outcome, owner, key and request-ID contradictions |
| 1 | Partial-capture previous-capacity mismatch |
| 2 | Equivalent distinct event and equivalent event naming another attested retry request ID |
| 3 | Genuine predecessor authorization, another accepted pending shared-PI operation, unrelated well-formed account event |
| 1 | Late contradiction after binding rejects read/rebinding, preserving stored history |
| 1 | Conflicting later delivery on another coherent original |
| 1 | Reordered equivalent retries cannot erase an intervening contradiction |
| 1 | Rolled-back signed publication has no effect; committed retry invalidates eligibility |

Coverage gaps matter: the unrelated control has no duplicate raw field; enriched authorization is tested as a **capture predecessor**, not as its own AUTHORIZE proof; and signed-method consistency is not tested with the contradictory receipt selected as primary. The new reviewer suite targets these gaps without changing existing tests.

## 6. Findings — must fix

### 1. B1.1-IR01 / P1 — selecting the contradictory primary receipt bypasses the signed-method check

**What this is:** [selected receipt comparison](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L188) omits `capture_method`. The [new peer predicate](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L327) checks it, but [discovery excludes the selected inbox](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L300).

**Problem:** retain the valid manual authorization and manual capture command response. The selected signed success explicitly says `capture_method=automatic`; another signed event for the same accepted key/request/PI/Charge says `manual`. Selecting the automatic receipt returns SEALED and the reader returns principal10000. Selecting the manual receipt returns BLOCKING_REVIEW because it sees the automatic peer. In the second schedule the automatic proof is sealed and bound first; after the manual peer commits and is itself refused, the original proof remains readable and scoped AWAITING_APPLICATION. All these rows commit.

**Evidence:** both permanent `cannot hide a primary signed capture-method contradiction` assertions fail in PostgreSQL17.11, before and after sealing. In the final after-seal run, proof `b11f86fb-bf8b-436a-8c0b-2a8f82852aba` remained readable with principal10000 and AWAITING_APPLICATION after peer inbox `6ae97202-572c-4edc-b622-d977457c69b2` committed its `Contradictory causally related signed payment evidence` refusal. Direct SQL also confirms primary method automatic, peer method manual and D02 response method manual. See [new reviewer regressions](../../apps/api/test/integration/payment-operation-rereview.spec.ts) and `.tmp/r2b11-rereview-committed.json`.

**Fix:** apply one supported signed-object/response consistency predicate to the primary and every causally related peer, including optional explicit capture method. Preserve strict causal ownership, immutable history and manual first-capture support limits; do not remove the peer check to make the two selections agree.

**If skipped:** callers can choose a receipt that omits a required contradiction check and receive positive effective evidence from an inconsistent source set. This is a P1 checkpoint blocker; current closed application gates still contain monetary execution.

### 2. B1.1-IR02 / P2 — parsing unrelated nonfinancial evidence invalidates another operation

**What this is:** [line305](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L305) calls the strict payment parser on every account receipt before [causal matching](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L307).

**Problem:** an SDK-verified `customer.updated` with unrelated request key/ID and a repeated identical informational metadata `note` is accepted by the existing R1 path. SQL classifies it `provider.unrelated`, `financially_relevant=false`, with **zero obligations**. It nevertheless makes a different valid capture's seal return BLOCKING_REVIEW, or its previously successful effective reader raise `Ambiguous duplicate provider JSON key`. The original proof UUID/fingerprint remains intact, but unrelated evidence has invalidated it before ownership is established.

**Evidence:** both permanent unrelated-nonfinancial assertions fail; committed admission and zero-obligation assertions pass first. No source-table fabrication or incorrect-account endpoint was used. The duplicate is in an unrelated informational field, with identical values; accepted event/request identity is not ambiguous in this reproduction.

**Fix:** establish causal relevance using a duplicate-aware identity check before applying the full payment financial parser. Preserve conservative handling when causal identity itself is ambiguous, and keep relevant duplicate/contradictory payment fields blocking. A plain lossy jsonb prefilter would need care so it cannot hide a conflicting key.

**If skipped:** one accepted nonfinancial receipt can unnecessarily block proof creation and reading across its provider account, despite having no financial obligation. The explicit unrelated-source acceptance requirement is unmet.

### 3. B1.1-IR03 / P2 — equivalent authorization responses pass as a predecessor but fail as authorization itself

**What this is:** the new semantic comparison handles `auth.outbox_id`, populated for capture/void predecessors. For an AUTHORIZE proof, `a.outbox_id` still uses [whole-jsonb response equality](../../apps/api/drizzle/0011_payment_operation_evidence.sql#L259).

**Problem:** an owned standalone authorization has two genuine same-command responses with identical PI/Charge, amount/currency, zero received, full capacity, status/method and ownership. Adding only a harmless `description` to the second causes BLOCKING_REVIEW with `Contradictory same-command payment response`. The same enrichment is accepted when this authorization supports a capture, as the passing supplemental control demonstrates.

**Evidence:** permanent `standalone authorization accepts semantically equivalent enriched responses` fails: expected SEALED, received BLOCKING_REVIEW. Original responses and accepted ownership are retained.

**Fix:** reuse the reviewed semantic authorization comparison for standalone authorization responses as well as predecessor responses. Continue validating each source and explicit metadata contradictions; preserve the original proof's selected-source fingerprint.

**If skipped:** legitimate equivalent evidence is classified differently according to which supported proof is requested. The required equivalent-response guarantee remains incomplete. This is an acceptance defect, not a claim that a real Stripe idempotency replay was observed to change its body.

## 7. Sealing, effective reading and deferred validation

For the **covered** amount/currency/identity/outcome contradictions, the common facts routine now rejects before proof insertion; the sealer commits a retained UNRESOLVED review and BLOCKING_REVIEW. A later contradiction leaves an existing proof's UUID/facts/fingerprint unchanged while the reader raises. Binding and exact binding replay use that same reader and reject late incompatible evidence. A stored AWAITING_APPLICATION row alone is not eligibility or source clearance.

`validate_payment_operation_seal` is an initially deferred constraint trigger. It invokes the effective reader and compares typed stored projection with checked facts at commit. This correctly prevents a missing source, wrong selector, unsupported attribution or incomplete projection becoming proof. It does **not** repair an omitted shared predicate: finding1 passes sealing, deferred validation, reading and binding for the selected contradictory primary. Finding2 is also shared by sealing and reading. Common code establishes consistency of execution, not completeness of interpretation.

Proof construction still requires no future capture journal, lot or successful capture attempt. The three supported first-capture shapes pass at captured/fee0 with pending attempts and no effects. Missing evidence, unknown API version, ambiguous financial JSON, metadata/aggregate-only principal, a distinct prior capture and unapproved subsequent shared-PI capture remain refused in the existing suites. No supplied fixture or future lot is used to invent captured principal.

## 8. Concurrency and immutable evidence

The independently executed original B1 schedules cover same-inbox sealers, four same-event conflict/seal/bind orders and legacy-writer/DDL waiting. Four **additional** permanent schedules exercise the corrected discovery boundaries: distinct signed contradiction before/after sealing and competing authorization response before/after sealing. Each uses authenticated restricted pools, distinct backend PIDs, bounded gates, actual `pg_blocking_pids`, awaited cleanup and committed proof/obligation assertions. All four pass. No deadlock is retried into a successful schedule.

Publication-first waits/commits before the sealer proceeds: no proof, retained BLOCKING_REVIEW. Sealer-first commits one immutable proof; subsequent publication retains its source and makes effective reading fail. Both publishers and sealer serialize on account UPDATE before scope/payment locks. Network execution/preparation occurs before the gated D02 publication transaction. This demonstrates the tested schedules, not universal deadlock freedom or future accounting integration.

The VOLATILE helpers obtain fresh query snapshots after READ COMMITTED waits; this interpretation agrees with [PostgreSQL17 volatility documentation](https://www.postgresql.org/docs/17/xfunc-volatility.html). Existing ownership, statement snapshots and required account locks remain part of the caller protocol. The isolated reader is not itself a new financial application or a replacement for future application admission locks.

Original signed receipts, later deliveries, D02 sources, proofs and financial history retain their immutable protections. Existing real-role immutability and rollback tests pass. No source mutation, replacement, compensating journal or administrative barrier clearance was introduced by this review.

## 9. Migration, privilege and R2-A compatibility

All four B1 migration cases pass: fresh/repeated twelve-migration installation; populated0010 upgrade preserving financial/receipt/D02 fingerprints and old bound refund behavior; injected late0011 failure rolling back tables/functions/constraints/roles; observed legacy table writer blocking atomic forward DDL. Historical0000–0010 bytes are preserved. Original R0.2 fingerprints remain staged through0010; the B1 upgrade suite separately owns the intentional new nullable proof column and versioned0011 functions. Existing assertions were not weakened during this review.

The21 legacy comparison cases pass across0009/0010/0011. R2-A's35 foundation/permit cases,33 ownership cases, five unchanged reviewer cases and five migration cases pass. Its authoritative OLD/NEW/final effect-owner discovery, root-independent protection, exact transaction/backend/principal permits, SQL-prepared write manifests and bidirectional deferred finality remain unchanged. Capture preparation still lacks an installed complete contract and uses no new proof/permit shortcut.

Reviewed dedicated NOLOGIN/NOINHERIT ownership, pinned `pg_catalog,pg_temp`, qualified relations, no PUBLIC EXECUTE on the new routines, narrow lock-column privileges and actual restricted LOGIN/table/column capability checks. Fresh-install tests verify definer ACL/search paths and role flags; real ordinary-role and owner-pool refusal tests pass. Migration0011 grants no runtime LOGIN/membership, installs no financial operation contract and enrolls no scope. Tests grant capabilities only within fresh disposable databases.

No production handler, webhook route, consumer, worker or financial application uses `TrustedPaymentOperationEvidence` or supplies PAYMENT_OPERATION_V2. Existing src references are isolated declarations/adapter implementations. No new payment-total, journal, lot, application, terminal workflow or automatic-capture-child writer exists in this diff.

## 10. Exact independently executed verification

Environment: Windows, **Node24.19.0**, cached **pnpm10.26.0**, Docker Engine**29.9.1**, actual **PostgreSQL17.11 on x86_64-pc-linux-musl, Alpine gcc15.2.0,64-bit**. Fresh UUID Compose projects, dynamic loopback ports, run-owned volumes, fixed fixture credentials, neutralized inherited dotenv and the existing verification runner were used. No shared database/container/volume or real provider/broker/Redis boundary was used.

`pnpm` below denotes `node C:/Users/Daniel/AppData/Local/node/corepack/v1/pnpm/10.26.0/bin/pnpm.cjs`, with task-local `COREPACK_HOME=C:/Users/Daniel/AppData/Local/node/corepack` for recursive commands. The ignored helper imports the existing safe runner and changes only Jest selection; no runner/source isolation semantics are altered.

| Command / scope | Actual result and retained evidence |
| --- | --- |
| `pnpm test:integration:docker` | **PASS:932 passed /0 failed /6 intentional F01 skips;32 passing suites**. `.tmp/fintech-verify-803d8cf1-1ba9-4337-ad20-a06dfd5981eb/jest.json`;332.176s. This run preceded creation of the additional reviewer suite. |
| `node .tmp/r2b11-rereview-verify.mjs focused` | **PASS:97 passed /4 suites /0 failed /0 skipped**, including9 unchanged original reviewer,28 supplements,56 B1 evidence and4 migration. `.tmp/fintech-verify-8aa5cd2d-7688-4013-bc05-5a2d60528cec/jest.json`;53.207s. These97 overlap932. |
| `node .tmp/r2b11-rereview-verify.mjs rereview` | **FAIL:4 passed /5 failed /0 skipped**, nine additional reviewer cases. All four observed concurrency schedules pass; two primary-selection, two unrelated-evidence and one equivalent-authorization assertions fail. Final `.tmp/fintech-verify-39106e19-2e53-422f-8f43-bfccfcc8dbeb/jest.json`;26.330s; committed state `.tmp/r2b11-rereview-committed.json`. Earlier nine-case run `.tmp/fintech-verify-de13616d-bcc1-447e-bdfc-6c4cd4f7d2cb/jest.json` has the same failures; the final run additionally reads eligibility after peer review and asserts stored capture methods. |
| `node .tmp/r2b11-rereview-verify.mjs f01`, RUN_F01_PENDING=1 | **FAIL:0 passed /6 expected historical financial failures /0 skipped**. `.tmp/fintech-verify-de531a14-753a-45ec-866a-f0e8e8bf554b/jest.json`;18.513s. All six names/statuses/financial assertion texts match the original reviewer baseline after ANSI/stack removal. These remain failures, not passes. |
| `pnpm --filter @fintech-lab/api test:unit --cacheDirectory ../../.tmp/jest-r2b11-rereview-unit --json --outputFile ../../.tmp/r2b11-rereview-unit.json` | **PASS:50 /12 suites /0 failed /0 skipped**;56.768s |
| `pnpm lint`; `pnpm typecheck` after build | **PASS:API/web**. Final additional `pnpm --filter @fintech-lab/api lint` and `typecheck` include the new reviewer suite. |
| `pnpm build` with cached Corepack location | **PASS:API Nest and web Next production builds**. `.tmp/r2b11-rereview-build-cached.log`; no implementation/permission/output-path change was needed. |
| `pnpm test:verification` | **PASS:10 runner safeguards /0 failed /0 skipped** |
| Documentation links/anchors/CI structure; `git diff --check`; exact preservation/history checks | **PASS**; final evidence below. Existing Mermaid blocks inventoried, not rendered. |
| Project-specific Docker cleanup and read-only residual inventory | **PASS** for all seven review-owned projects; no global cleanup. |
| Node22, native PostgreSQL18, hosted CI, actual Stripe/test-mode forwarding, RabbitMQ/Redis, deployed ACL/fencing, installation/activation | **NOT RUN**; outside this authorized local dormant review |

The932 breakdown includes original895 plus9 original reviewer plus28 supplements. Its existing suite counts are capture foundation/integration/migration30/27/5; refund63; dispute70; settlement73; integrated44; ledger immutability17; financial concurrency5; B.1 evidence/migration64/6; R0 admission/reviewer/migration50/31/6; R0.2 delivery/migration56/6; R1 integration/reviewer65/15; D02 observation/native/SQL-review/reviewer/migration51/17/29/4/2; R2-A foundation/ownership/reviewer/migration/legacy35/33/5/5/21; B1 evidence/migration/reviewer/supplements56/4/9/28. F01's six are skipped only in this green matrix and executed separately above.

Across distinct non-F01 cases including the new reviewer suite: **936 pass /5 fail**. Focused reruns do not add distinct cases. Earlier ignored seven- and eight-case probes reproduced the same gaps before the permanent nine-case suite; they are not added to these totals. An initial new-test lint check caught two unsafe result-field assignments; an erased TypeScript result annotation fixed those reviewer-only issues without changing any assertion. The final static checks pass.

The new suite's committed PostgreSQL summary independently reports **zero ACTIVE scopes, contracts, enrollments, permits, applications, dispositions, journals and lots**, including the incorrectly accepted proofs. Source/receipt/proof identities and actual reader/refusal results are saved, rather than inferred from the author's report.

## 11. Environment diagnosis and preserved boundaries

Docker was initially stopped. `docker desktop start` could not find its launcher registry key; launching the installed Docker Desktop executable with the supported approved host execution path made the engine available. Sandbox pipe access was denied; actual Docker tests used approved host execution. No denied action, execution policy, ACL or security boundary was bypassed.

The first independent root build attempt failed **before compilation**, because nested pnpm selected an uncached default Corepack location and attempted an unavailable registry lookup (`ENOTFOUND registry.npmjs.org`). Selecting the existing pinned cache through COREPACK_HOME allowed the unchanged recursive API/web build to complete **inside ordinary workspace execution**. The author's earlier Next mkdir EPERM was not reproduced. No dependency download, semantic change, permission change or special output destination was required. Build is therefore completed for this review and does not prevent acceptance; the SQL findings do.

Read-only Docker inventory uses direct supported CLI label filters on only the seven generated project identities. It does not execute the author's policy-blocked PowerShell inventory file or alter execution policy. Every runner's scoped cleanup succeeded, including expected failing regression/F01 runs. `.tmp/r2b11-rereview-cleanup.json` records zero residual containers, volumes and networks for each project.

Remaining unsupported patterns are unchanged: subsequent shared-PI captures; missing original COMMAND_RESULT bytes/causal request ID/key; current lookup or cumulative/metadata-only principal; unknown API/parser versions; ambiguous financial fields; historical unclassified admissions; captured-remainder voids; automatic definitive capture/authorization failure issuance; broad contradiction recovery. Real provider entitlement, delivery shape and operational credential isolation remain unverified.

B2 capture accounting/application/disposition, B3 authorization/void/failure workflow and automatic child finality, F05/F06 corrections, live F01/F04 closure, D03, coordinated runtime admission and activation remain separate. Zero counters prove dormant containment in these disposable fixtures, not production readiness or the absence of older legacy effects in other suites.

## 12. Verdict and completion

**REQUEST_CHANGES.** The four original failure cases are corrected, the nine original cases remain unchanged and green, migration/legacy/ownership checks pass, and build/static verification is complete. Finding1 still permits positive effective evidence from a contradictory signed source set. Findings2 and3 violate the explicit unrelated-source and equivalent-response acceptance requirements. Approval of the dormant checkpoint must wait for these corrections and unchanged regression reruns.

The only review deliverables are [the additional reviewer suite](../../apps/api/test/integration/payment-operation-rereview.spec.ts), this record and one additive index entry. All393 starting files are preserved except that single navigation addition; removing it reproduces the original index bytes. The author SQL/tests, both original design records, original REQUEST_CHANGES and correction histories retain their exact starting bytes. HEAD/local tracking reference and empty index remain unchanged. Final preservation evidence is `.tmp/r2b11-rereview-final-preservation.json`.

Final documentation validation checks64 Markdown files and1,093 relative links/anchors with zero errors, plus CI YAML structure. All19 pre-existing Mermaid blocks are unchanged and inventoried, not rendered. Git whitespace and new-file newline/source-link bounds checks pass. The preservation checker confirms392 untouched starting file hashes plus the exactly reversible index addition, all11 historical migrations and journal prefix, original reviewer hash, facts-only SQL correction and exact six-failure F01 comparison.

No implementation fix, new monetary effect, B2 work, scope activation, commit or push was performed.
