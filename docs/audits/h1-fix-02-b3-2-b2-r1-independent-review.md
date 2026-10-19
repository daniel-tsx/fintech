# H1 Fix 02 — B3.2 B.2-R1 independent signed receipt review

Status: completed independent correctness, security-boundary, concurrency and financial-admission review, **2026-10-19**.

Verdict: **APPROVE_DORMANT_R1_CHECKPOINT**.

The isolated adapter establishes an effective SDK authentication boundary and atomically publishes the original inbox, trusted receipt and admission obligation. Equivalent retries remain neutral; verified contradictions retain SQL-enforced blockers. Failed or interrupted correlation leaves durable admission blocking. No confirmed R1 acceptance-blocking defect was found. Independently executed: **618 existing PostgreSQL cases plus 15 added reviewer cases, 633 total across 18 suites, zero skips**; **50 unit tests**; lint, typecheck and API/web build. The six original F01 cases retain their exact expected financial failures. This accepts an isolated dormant checkpoint, not live routing, complete financial correctness or Stripe cutover.

## 1. Starting HEAD and reviewed scope

Checkout: `C:\Work\Learning Projects\learn-fintech`, branch `main`, HEAD `8c332fbabc429620924aeacf2ddbbcf1c9b0125f` (`feat(accounting): add conflicting receipt delivery safeguards`). The index was empty. The initial worktree contained **12 author deliverables**, six modified documentation files and six untracked files. The tracked HEAD contains approved [migration0008](../../apps/api/drizzle/0008_conflicting_receipt_deliveries.sql). All nine installed migration hashes matched their source files in the fresh review database; historical SQL, schema/journal and earlier reviewer records were preserved.

Read the repository AGENTS/CLAUDE, README, scripts, routing/index and workflow; [approved human decisions](h1-fix-02-b3-2-human-decisions.md); B.1 implementation and independent acceptance; R0 implementation/correction, original adverse review and final R0.1 acceptance; R0.2 implementation and independent acceptance; both historical R1 preflights; the [R1 implementation report](h1-fix-02-b3-2-b2-r1-signed-receipt-integration.md); and current webhook, database, security, concurrency and verification documentation. Reviewed the complete uncommitted author diff and all five new TypeScript files. Inspected the actual normalizer, SDK implementation, SQL0006–0008, AppModule/WebhooksModule, controller/receiver/processor, transaction wrapper, provider-result and financial-writer boundaries against the claims.

A SHA-256 manifest of every initial tracked/untracked file is retained in `.tmp/r1-independent-baseline.json`. Review additions are this report, its index link and one separate regression spec. No implementation source, author test assertion, migration or earlier review was corrected or rewritten. No staging, commit, push, R2 implementation or activation occurred.

## 2. Complete file inventory

| Initial author path | Reviewed responsibility |
| --- | --- |
| `apps/api/src/webhooks/trusted-signed-receipt.service.ts` | Exact-byte SDK verification, configured context, normalization, first/later publication |
| `apps/api/src/webhooks/trusted-receipt-correlation.service.ts` | Existing witness selection, SQL sealing, separate guarded binding, unresolved review |
| `apps/api/src/webhooks/trusted-receipt-database.ts` | Explicit DI capabilities, restricted LOGIN validation, READ COMMITTED and bounded transaction retry |
| `apps/api/test/support/trusted-receipt-harness.ts` | Private migrated database, actual restricted LOGIN pools, isolated raw-body Nest HTTP controller |
| `apps/api/test/integration/trusted-signed-receipt-integration.spec.ts` | All 65 HTTP, publication, correlation, lock and abort cases |
| `docs/audits/h1-fix-02-b3-2-b2-r1-signed-receipt-integration.md` | Author contract, results and remaining gates; preserved |
| `docs/README.md` | Author navigation, plus this review's single navigation addition |
| `docs/webhooks-and-idempotency.md` | Isolated ingress and separate correlation semantics |
| `docs/security.md` | SDK/capability/deployment distinctions |
| `docs/database-design.md` | Existing SQL contracts consumed without new DDL |
| `docs/concurrency.md` | Publication, sealing/binding and retry boundaries |
| `docs/verification.md` | Author execution evidence and explicitly unverified boundaries |

The reviewer adds [trusted-signed-receipt-review.spec.ts](../../apps/api/test/integration/trusted-signed-receipt-review.spec.ts), this report and one navigation link: **14 final modified/untracked files**, with three files touched by this review. Ignored scripts, caches, logs, database markers and local database histories are not deliverables.

## 3. Signed HTTP trust verification

[TrustedSignedReceiptService.receive](../../apps/api/src/webhooks/trusted-signed-receipt.service.ts), lines32–49, rejects absent/empty raw bytes and inconsistent signature headers. At line37 it copies the Buffer and deep-copies retained headers before the first asynchronous boundary. It invokes the actual injected Stripe client's `webhooks.constructEvent(raw,signature,configuredSecret)` at line39; only its returned event supplies identity and normalization. No parsed request body, caller `verified` flag, header account selector or alternate unauthenticated service branch is used.

The installed SDK verifies the HMAC before parsing and uses its 300-second default tolerance through `constructEvent`. Permanent HTTP tests reject invalid, expired, wrong-secret and post-signing modified input; missing raw-body capture also rejects. No inbox, revision or blocker is created. A reviewer test additionally counted **zero database transactions** for an invalid signature accompanied by `verified:true` caller headers.

The endpoint is explicitly supplied by server composition, checked for nonempty account/secret, copied and frozen at construction. Provider is fixed to STRIPE. Any signed `event.account` must match that configured account. Request headers and signed owner metadata cannot choose the authoritative account or merchant scope. Reviewer mutation of the original endpoint object, input Buffer, signature header and nested header array preserved the exact authenticated receipt/configuration snapshot. The retained original bytes, normalization, signature and headers remain protected by existing SQL immutability.

The isolated HTTP controller really passes `req.rawBody` and the signature header through Nest raw-body capture; tests use loopback HTTP and SDK-generated fixture signatures. This is executed HTTP/SDK evidence without provider network access. [Stripe's official signature guidance](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors) supports the raw-body, signature and endpoint-secret interpretation; the installed SDK and executed tests supply the version-specific evidence.

Production registration would require explicit endpoint/account/secret and restricted capability providers; there is no default configuration or DatabaseService fallback. These are trusted server dependencies. A server composition that substitutes an arbitrary verifier or unrestricted `ReceiptTransactions` implementation would violate the acceptance assumptions; TypeScript's structural interface does not prevent trusted application code from doing so. No such substitution or public bypass exists in the inspected runtime graph.

## 4. SQL capability and privilege assessment

Keep four independent guarantees separate:

| Guarantee | Evidence and boundary |
| --- | --- |
| Stripe authenticity | Actual SDK verifies exact request bytes against the configured endpoint secret before SQL |
| Adapter trust | Server composition fixes provider/account, verifier, normalization and capability injection |
| Database authorization | Dedicated authenticated publisher/correlator LOGIN roles and narrow SQL grants; no production provisioning claimed |
| Provider-object ownership | B.1 checked builder/sealer/effective projection validates accepted commands, immutable captures and object ownership |

`RestrictedReceiptDatabase.transaction`, lines22–35, uses READ COMMITTED and rejects SET ROLE/current-vs-session mismatch, non-login/elevated/inheriting/member roles, absent capability EXECUTE and enumerated direct protected-table/ledger write privileges. The owner pool is rejected even after a valid SDK signature. Publisher, correlator and worker are distinct actual authenticated sessions; the R1 harness does not substitute SET ROLE on its administrative setup connection.

Publisher grants are limited inbox INSERT/identity SELECT, original enrollment existence reads and the two publication entry points. Correlator grants are identity/witness reads, sealer/binding EXECUTE and append-only unresolved reviews. The worker has admission-reader EXECUTE. There are no ledger write grants or unrelated service injections. Ordinary worker attempts to publish, fabricate deliveries, delete barriers or reset revisions fail. Migration setup and synthetic canonical fixture construction use a separate administrative connection only in disposable databases.

Independent catalogs check function ownership, `search_path=pg_catalog, pg_temp`, absence of PUBLIC EXECUTE, role attributes/memberships/schema CREATE and ledger **column as well as table** write rights. The reviewed SECURITY DEFINER routines retain the existing restricted NOLOGIN evidence/admission owners. Persistent SQL references are qualified. Neither new source nor this review changes installed production grants.

The connection wrapper is a guard over enumerated capabilities, not a complete deployment ACL/default-privilege audit. In particular `has_table_privilege` alone is not a proof about every possible column grant; the independent catalog check covers column writes for the actual tested roles. Operational provisioning must review all grants, ownership and source isolation. An existing application using owner/superuser credentials is outside ordinary-role isolation. PostgreSQL does not verify Stripe HMAC; a holder of trusted publication EXECUTE can falsely attest verification. Separate operational credentials and genuine verifier composition remain mandatory before any live registration. [PostgreSQL's definer-function guidance](https://www.postgresql.org/docs/18/sql-createfunction.html) informs this assessment.

## 5. First-delivery atomicity

The exact path is SDK verification → one READ COMMITTED transaction → original `webhook_events` INSERT →0007 `publish_admitted_receipt` → B.1 receipt → R0 enrollment → required obligation/review and evidence revision → COMMIT. `postgres.begin` resolves only after commit, including deferred checks. There is no earlier inbox autocommit or HTTP202 before durable completion.

The service attempts `ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id`. A successful insert calls the protected publisher within that same callback. For financially relevant input, SQL deferred enrollment/obligation checks require exactly its mandatory obligation. Genuine nonfinancial classification deliberately has none. The original row, receipt bytes/signature/normalization and enrollment are immutable evidence, not mutable retry data.

Executed negative evidence includes missing account, revoked original-publisher EXECUTE, whole-transaction abort/exhaustion and reviewer trigger failures immediately before admission INSERT and obligation INSERT. The latter reach SQL after receipt construction and, respectively, after enrollment construction. Both HTTP failures leave **zero committed original inbox/receipt/admission/obligation**, revision0 and a clear independent reader; a normal retry creates one original obligation. Additional full-publication abort cases prove revision and inbox rollback at the final callback boundary. No successful response is used as the sole atomicity oracle.

Concurrent first deliveries serialize at the provider/event unique index and cannot create competing original receipts/obligations. The losing insert uses a **separate subsequent SELECT** with a fresh READ COMMITTED snapshot. Reviewer schedules also aborted the first complete publication while a differently signed contender waited: in both financial/nonfinancial orders the contender became the sole ORIGINAL, with only its bytes and appropriate obligation/revision retained, zero later attempts. This checks actual committed recovery from the index wait, not just a sequential retry. [PostgreSQL's isolation documentation](https://www.postgresql.org/docs/18/transaction-iso.html) supports that snapshot interpretation.

## 6. Duplicate and conflicting deliveries

| Executed case | Durable SQL state and response |
| --- | --- |
| Exact signed HTTP duplicate | Same original inbox ID; first replay adds one EQUIVALENT witness, identical complete replays reuse it; no new obligation/barrier/revision |
| Refreshed valid signature/header | Equal signed JSON/account/normalization remains EQUIVALENT; distinct transport witness may be retained without a blocker or revision change |
| Verified financial contradiction | HTTP202 only after original-preserving delivery/review/exact barrier set and revision commit |
| Nonfinancial original → financial contradiction | Original classification and zero original obligations remain unchanged; later immutable evidence supplies its own unknown-account blocker |
| Invalid conflicting signature | HTTP400 before database work; no authoritative witness/barrier |
| Conflicting independently configured accounts | Original ownership never reassigns; each financially implicated trusted side retains the authority derived by0008; unrelated account remains clear |
| Repeated identical conflict | Same attempt/barrier/review identity and stable revision; no repeated obligation |
| Different conflicting witnesses | Independently retained evidence; their required revision increments are intentional under the accepted0008 complete-attempt contract |
| Bare legacy inbox / B.1-only receipt | HTTP409 `HISTORICAL_RECEIPT_REVIEW_REQUIRED`; no enrollment, fake provenance or acknowledgment of handling |

Branch selection follows installed0007/0008, not exception-message guessing. A new inbox calls `publish_admitted_receipt`; an existing identity must have both original receipt and R0 enrollment before `publish_verified_receipt_delivery`. The adapter does not swallow unexpected23505/permission/domain failures as duplicates or continue inside an aborted transaction.

The HTTP conflict-retention failure test forces constraints immediate, failing between attempt and barrier construction. HTTP500 leaves the original untouched and no new attempt/barrier/revision. A retry commits the complete blocker and only then returns202. The rerun R0.2 suite separately rejects missing/extra barriers and false equivalence at deferred commit. Failed acknowledgment is safe to retry under the same identity. Original obligation resolution/status changes cannot clear independent immutable delivery barriers.

Equivalence is the accepted full parsed event/normalized JSON/account equality, not a new financial-field-only projection. Distinct newly signed contradictory facts may retain distinct conflict witnesses; exact complete-attempt idempotency does not collapse every later signature into one global contradiction record. No SQL contract was broadened during review.

## 7. Trusted correlation correctness

[TrustedReceiptCorrelationService.correlate](../../apps/api/src/webhooks/trusted-receipt-correlation.service.ts), lines21–38, requires the admitted original's configured account. Refund selection reads only existing same-account COMMAND_RESULT/REFUND observations for that verified original object. `order by id limit1` selects a witness, not financial ownership: the SQL builder also rejects competing owner witnesses and compares accepted command/key/payload, refund principal/currency, original journal-backed frozen captures and provider-object bindings. Signed explicit refund identity can use the accepted chain with immutable capture witnesses; absent optional refund metadata requires an independently retained refund witness.

Disputes use uniquely owned trusted capture PI/Charge provenance without an invented dispute command. Missing metadata does not trigger an amount/PI/mirror guess. The shared B.1 effective projection remains the authority; mutable mirrors can contradict but cannot independently establish ownership. Wrong merchant/payment/refund/amount/currency and competing object ownership reject sealing. Reviewer HTTP-to-correlation cases additionally reject wrong PI, wrong Charge and an unsupported refund-object prefix, leaving no proof and an unknown blocking obligation.

Sealing commits separately before a second fresh transaction calls guarded `bind_receipt_obligation`. Binding revalidates the same immutable owned tuple under SQL locks. Successful binding atomically transfers broad unknown blocking to scoped AWAITING_APPLICATION, advancing intake and destination-scope revisions. **BOUND is still blocked for financial admission**, not a completed refund/dispute or a financial permit. Original contradiction barriers remain independently blocking, and a nonfinancial original cannot be resealed to consume its later financial evidence.

## 8. Failure and recovery semantics

| Failure / retry exercised | Committed result |
| --- | --- |
| Missing immutable capture/refund witness | UNRESOLVED review; original unknown obligation remains; zero guessed proof |
| Contradictory ownership or provider relationship | No proof/owner reassignment; durable receipt and blocker survive |
| Failure after sealer callback writes but before its COMMIT | Proof and object-owner insertion roll back; original receipt/unknown blocker and revisions survive |
| Proof committed, binding permission fails | One proof remains; unknown blocker remains; later retry reuses proof and binds once |
| Binding callback finished, failure before its COMMIT | One committed proof; scope/intake transfer/revisions roll back; account reader still blocks; fresh retry succeeds once |
| Two concurrent fresh correlators | Observed inbox wait; one proof/owner/obligation, one guarded transfer, no lost/duplicate revision |
| Duplicate successful correlation | Identical proof/revision and stable authority revisions |
| Later canonical evidence becomes available | Fresh retry seals/binds without changing receipt or deleting earlier unresolved review; scoped obligation still blocks application |

Reviewer interruption tests inject SQLSTATE XX000 inside actual transactions immediately before their commits; they do not terminate an operating-system process. They establish rollback/durable partial-progress semantics, supplemented by a new service invocation for recovery. A real process restart, ambiguous COMMIT-response loss and durable correlation scheduling were not exercised. There is no new production retry worker. Re-invocation is safe under the tested idempotent SQL contract; automatic liveness is not established.

P0001/P0002 sealer/binder refusals append an immutable unresolved dependency review only **after rollback**, in another transaction. Identical inbox/attempt/SQL-state refusal reuses that review; it is a coarse dependency record, not a detailed financial oracle or clearance. Other errors propagate. The wrapper retries only40001/40P01, at most three whole transactions after rollback, using already copied/verified evidence. The four supplied retry tests inject PostgreSQL error states; they are not actual deadlock reproductions. Exhaustion and unexpected23505 are failures, never successful acknowledgment.

Missing sources may recover when genuine trusted evidence arrives. Sticky BLOCKING_REVIEW, conflicting immutable ownership, delivery-barrier resolution and historical409 cases require separately reviewed reconciliation/recovery. None can be repaired with fabricated observations, notes, mutable mirrors or timeout clearance. Positive witness fixtures are explicitly synthetic, use the accepted existing test helper and do not implement or prove a genuine D02 producer.

## 9. Concurrency and lock evidence

| Path | Actual lock graph |
| --- | --- |
| New original | Speculative/unique provider-event INSERT → own inbox UPDATE lock → configured account UPDATE → B.1 same-inbox version write/nested account SHARE → receipt/admission/obligation and intake revision |
| Later delivery | Original inbox FOR UPDATE → distinct original/later accounts FOR UPDATE in sorted order → frozen proof/derivation → canonical advisory locks and scope NO KEY UPDATE → immutable review/attempt/barriers and revisions |
| Correlation sealer | Own inbox FOR UPDATE → account UPDATE → canonical advisory → scope **FOR UPDATE** → payment NO KEY UPDATE → ordered capture attempts/refunds/disputes/lots/allocations → immutable object owner/proof |
| Binding, separate transaction | Own inbox FOR UPDATE → account UPDATE → advisory/scope NO KEY UPDATE → proof revalidation → guarded obligation and both revisions |
| Admission reader | Account SHARE → canonical advisory → scope NO KEY UPDATE → current revisions and blockers |
| Unresolved review after rollback | New review INSERT with same-inbox FK KEY SHARE; failed transaction's authority/financial locks have already ended |

The B.1 sealer's scope lock is FOR UPDATE, not the binding/reader's weaker NO KEY UPDATE. FK KEY SHARE checks on inbox/account/admission/review/attempt/scope and the unique-index transaction wait are part of this analysis. New child rows are private; publication and sealer do not acquire another operation's inbox after account/scope. Account UPDATE is selected before nested SHARE rather than upgraded after scope acquisition. No provider network request runs under these transactions. [PostgreSQL's lock conflict matrix](https://www.postgresql.org/docs/18/explicit-locking.html) informs this interpretation.

The supplied65-case suite contains **ten controlled waits**: identical first publication, exact conflict replay and both orders for first-vs-conflicting delivery, conflict-vs-reader, unknown conflict-vs-another scoped binding, and sealing-vs-binding. The reviewer adds **five controlled waits**: two fresh correlators; both first/refreshed-equivalent orders; both aborted-first/different-contender orders. These fifteen R1 schedules use distinct backend PIDs, actual `pg_blocking_pids`, bounded waits, explicit pre-commit gates and finally-awaited cleanup.

All started operations complete with the required result; deadlock/timeout/uniqueness is not counted as a successful schedule. Committed bytes, proof/obligation/barrier cardinality and scope/intake revisions are checked. Saved clearance revisions reject after new trusted evidence; reader-first finishes its earlier clearance before the waiting publisher commits, while publisher-first makes the later reader reject. Receipt-commit/binding-failure readers remain blocked. Existing B.1, R0/R0.2 and financial controlled schedules also reran within618. These results establish the executed orders, not universal deadlock freedom or compatibility with every future/live financial writer.

## 10. Legacy compatibility

Legacy receiver, normalizer, processor, command/result bookkeeping, workers and financial writers match starting HEAD. `/webhooks/stripe` still uses the registered legacy receiver. It does not invoke R1 publication/admission or silently promote historical rows. The six F01 source assertions and exact failure outputs are unchanged.

The normalizer's supported payment/capture/refund/dispute mappings remain unchanged. Genuine pending/requires_action refunds retain Option A; unsupported financially relevant events remain conservatively unclassified/blocking under SQL, while only approved customer lifecycle classification is nonfinancial. Retaining a capture receipt does not imply support for capture proof sealing/application. A malformed signed event that cannot be normalized is rejected rather than guessed.

Bare historical409 does not establish a durable quarantine for current legacy spending. Missing original bytes cannot acquire signed provenance through this adapter. D03 inventory/compatibility review is required before routing live historical identities to it. Fresh/repeated migrations, populated upgrades and transactional failed-install rollback reran in the unchanged migration suites; this is not a destructive post-install down migration.

## 11. Dormant runtime verification

Repository-wide symbol/routine searches and inspection of AppModule, WebhooksModule, controller, worker entry points and the provider/financial modules find no new runtime registration or caller. The test controller is confined to test support and a small testing application. There is no production environment variable, connection fallback, privileged provider or new grant required merely to start the existing app. No settlement/payout/refund/dispute financial writer consumes R1 admission.

Each R1 test run creates a separate private database and restricted authenticated LOGIN pools. Its retained PENDING evidence cannot enter the different shared matrix database's legacy global pollers. No consumer/scheduler is started against those databases. All tests use explicit local SDK secrets/keys; no Stripe API or bank operation occurs. Accounting scopes remain constrained to dormant states, accounts to UNINSTALLED, and financial proof references/version gates remain closed.

## 12. Exact independent regression results

Environment: Windows, Node**24.19.0**, pnpm**10.26.0**, PostgreSQL**18.6**, installed dependencies and offline Corepack cache. Local cluster `.tmp/r02-independent-pg18-clean`, loopback127.0.0.1:55433; initial state stopped. Fresh shared database: `fintech_r1_independent_1792368417509`. Evidence/admission/migration/R1 suites create separate retained databases. No private environment file was read or printed, no dependency installed/upgraded, and no provider/broker/Redis service used.

| Independently executed PostgreSQL suites | Passed | Failed / skipped |
| --- | ---: | --- |
| Author signed HTTP/correlation/concurrency | 65 | 0 / 0 |
| Reviewer trust/rollback/recovery/concurrency | 15 | 0 / 0 |
| B.1 evidence / evidence migration | 64 +6 | 0 / 0 |
| R0 admission / classification / migration | 50 +31 +6 | 0 / 0 |
| R0.2 delivery / migration | 56 +6 | 0 / 0 |
| Capture / allocation foundation / foundation migration | 27 +30 +5 | 0 / 0 |
| Refund / dispute / settlement / B3.1 integrated | 63 +70 +73 +44 | 0 / 0 |
| F02 / existing financial concurrency | 17 +5 | 0 / 0 |
| **Distinct green total,18 suites** | **633** | **0 / 0** |
| Separate original F01 | 0 | **6 expected financial failures /0** |

The original complete matrix ran once: **618/17 suites/zero skips,140.893s**. The final separate reviewer suite passed **15/zero skips,18.771s**. These are two commands, not a claim that one command ran633. An earlier reviewer iteration passed13 before the two additional rollback-contender schedules were added; it is not counted twice. F01 ran in16.019s and exited1 as expected. An assertion compared all six complete test names, statuses and failure messages with `.tmp/r1-signed-f01.json`: **exactly equal**, without stripping financial differences or converting red to green.

Root lint, default tests, API/web build and post-build typecheck passed; the final reviewer spec is included in lint/typecheck/default discovery. Default tests execute50 units/12 suites and skip639 DB opt-ins, separately covered as633 green plus six expected red. The web test command remains a notice, not browser coverage.

Exact PostgreSQL commands, from `apps/api`:

```powershell
$env:TEMP=(Resolve-Path '../../.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
$env:MIGRATION_ADMIN_URL='postgres://fintech@127.0.0.1:55433/postgres'
$env:DATABASE_URL='postgres://fintech@127.0.0.1:55433/'+(Get-Content '../../.tmp/r1-independent-db.txt').Trim()
node node_modules/jest/bin/jest.js --runInBand test/integration --testPathIgnorePatterns settlement-f01.pending --cacheDirectory ../../.tmp/jest-r1-independent --json --outputFile ../../.tmp/r1-independent-pg.json
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/trusted-signed-receipt-review.spec.ts --cacheDirectory ../../.tmp/jest-r1-review-supplement --json --outputFile ../../.tmp/r1-independent-supplement-final.json
$env:RUN_F01_PENDING='1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-r1-independent --json --outputFile ../../.tmp/r1-independent-f01.json
```

Root commands use `COREPACK_HOME=C:/Users/Daniel/AppData/Local/node/corepack`, `COREPACK_ENABLE_NETWORK=0`, the same writable workspace TEMP/TMP, DB opt-ins disabled for default tests and `NEXT_TELEMETRY_DISABLED=1`: `pnpm.cmd lint`, `pnpm.cmd test`, `pnpm.cmd build`, then `pnpm.cmd typecheck`. Exact output/JSON is retained under ignored `.tmp/r1-independent-*`. New role/password/DDL setup is confined to disposable databases; no production credential is changed.

Environment failures are retained honestly: first sandbox localhost connection EACCES; first permitted connection preceded server readiness (ECONNREFUSED/57P03); sandboxed startup did not persist and the permitted cluster recovered, exceeding pg_ctl's initial wait before reporting ready. Database setup succeeded only after readiness. Initial Next build failed EPERM creating `.next/types/app/ledger`; the permitted retry passed, followed by typecheck. These failures did not require a source workaround or altered financial assertion. No failed product regression was hidden.

Documentation validation, final preservation/catalog results and successful shutdown are recorded in the completion note below. The documentation validator checks relative links/anchors and CI YAML structure and extracts existing Mermaid blocks; it does not parse/render them. No new diagram or UI behavior is introduced.

## 13. Confirmed findings

**No confirmed P0, P1 or P2 defect in the reviewed isolated R1 contract.** No implementation correction is required to preserve this dormant checkpoint. The reviewer tests strengthen previously unexercised boundaries and all pass against the unchanged implementation. There is no bad committed state or minimal defect reproduction to report as a confirmed finding.

Explicit limitations are not silently promoted to passing guarantees: the wrapper is not a complete ACL audit; production owner credentials do not gain restricted-role isolation; server DI/configuration remains trusted; the review exercises transaction interruption rather than actual process termination; correlation has no runtime scheduler; missing D02 evidence and sticky conflict recovery remain blocking. None grants financial application or clears an unknown obligation. The six known legacy F01 failures remain open independently of R1 acceptance.

## 14. D02, R2 and operational dependencies

1. **D02:** genuine immutable provider command-result/reconciliation producers with authenticated account/source identity, stable source keys/versioning, duplicate/conflict checks and admission participation before a webhook. Current mutable mirrors and synthetic fixtures do not supply that production guarantee. No network lookup or observation manufacturing was added.
2. **R2:** coordinated financial policy/admission/epoch/claim permits; all writers' lock and revision floor; shared-reader immediate/deferred financial validation; protected historical-era/default1/no-downgrade gates; complete bidirectional financial effect/workflow/audit/inbox linkage; operation-specific application/no-effect/duplicate recognition; matching conflict recovery and separate guarded resume.
3. **Deployment:** explicit protected publisher/correlator credentials and reviewed full ACL/default-privilege/ownership inventory, server endpoint/account/secret ownership and rotation, exact raw-body ingress/limits, shutdown ownership, real scheduling/recovery and separation from ordinary application credentials. Production provisioning is unimplemented/unverified in this checkpoint.
4. **Historical/cutover:** D03 inventory and reviewed handling of bare/unsupported/untrusted histories; H04 operator triage/deadline/escalation; cohort eligibility; all legacy-writer coordination, maintenance/drain and old-binary/session/credential fence. F01/F04/F05/F06 remain open. No scope activation or new-policy financial intent is authorized.
5. **Hosted/external evidence:** require this exact diff's frozen-install/lint/unit/build/typecheck on Node22/24 and fresh PostgreSQL17 migration/integration CI with both DB/migration opt-ins and disposable admin access. Expect633 green cases after the reviewer spec is preserved and no unexpected migration skips; six F01 cases remain separately expected-red. Prior accepted hosted runs do not verify this diff. Live Stripe/test-account API/webhook forwarding, RabbitMQ/Redis/BullMQ, mixed-version rehearsal and deployment are NOT RUN here and need their authorized stages.

## 15. Independent acceptance and next step

**APPROVE_DORMANT_R1_CHECKPOINT.** The SDK verification boundary is effective in the isolated adapter; original receipt/admission commit atomically; equivalent retries remain neutral; contradictory verified deliveries retain database-enforced blockers; failed correlation cannot clear admission; restricted SQL role isolation holds within the tested boundaries; legacy runtime is unchanged; **zero ACTIVE scopes**. The assumptions and remaining gates above are part of this acceptance.

Preserve the existing implementation, permanent successful regressions, added reviewer tests and both earlier R1 stopped-preflight records together. Recommended conventional commit message, only when separately instructed to commit:

```text
feat(webhooks): add dormant trusted signed receipt integration
```

The next step is owner review of this checkpoint and, after an authorized commit, hosted validation of the exact preserved diff. This review does not commit, push, activate scopes, begin R2 or authorize live Stripe cutover.

Completion checks: documentation validation passed **49 Markdown files /603 relative links and anchors**, CI YAML parsing/structure and extraction of19 existing Mermaid blocks, with no diagram parsing/rendering claimed. `git diff --check` and final-newline/trailing-whitespace checks passed for all14 deliverables. Final lint, typecheck and default tests passed after the final reviewer cases were added. The API/web build passed on its permitted retry; no application source changed afterward.

Read-only catalogs inspected **120 retained disposable databases**, including31 created for this review;27 of those have0008. All available scope/account/financial-proof gates remained closed: **zero ACTIVE scopes, zero non-UNINSTALLED accounts and zero opened financial proof references**. In the27 fully upgraded review databases, all nine source migration hashes matched and15 relevant routines retained pinned paths/no PUBLIC EXECUTE and expected restricted owners. Their evidence/admission owners have no memberships/schema CREATE/ledger writes. The three R1 harness databases additionally have actual publisher/correlator/worker LOGIN roles with no ledger column/table writes; the final15-case reviewer database retains14 receipts/four proofs/two equivalent attempts/zero conflict barriers, while the65-case database retains57 receipts/13 proofs/22 attempts/18 barriers. These are fixture counts, not production activity.

`node .tmp/r1-independent-preserve.cjs` verified **227 initial files byte-for-byte**, excluding exactly this review's removable index line; all nine historical migrations, schema/journal, existing tests, approved decisions and earlier review/preflight records remain unchanged. HEAD is unchanged, index empty, and exactly14 files comprise the final author-plus-review diff. Saved the current suite database identities separately and restored37 pre-existing ignored database markers. All financial histories are retained. The review cluster was stopped successfully, restoring its initial stopped state. No commit, push, R2 work or activation occurred.
