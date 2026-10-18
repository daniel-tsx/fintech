# H1 Fix 02 — B3.2 B.2-R1 post-R0 implementation preflight

Status: **BLOCKED_BY_TRUST_OR_ADMISSION_CONTRACT**, 2026-10-18. Implementation stopped at the request's conflicting-duplicate condition. No R1 adapter, route, publisher grant, migration or financial integration was added.

This record supplements the [original R1 blocked preflight](h1-fix-02-b3-2-b2-r1-trusted-receipt.md), preserving it unchanged. Its original missing-admission-lifecycle dependency **was resolved** by R0. The remaining conflict-delivery requirement below is narrower and distinct. It does not withdraw [R0's dormant acceptance](h1-fix-02-b3-2-b2-r0-1-independent-review.md) or replace [Database design](../database-design.md) as schema owner.

## 1. Git baseline and inspected boundaries

Started on clean `main`, HEAD `5c8b1e02ba543d641526beab0ba03f7e0cc78283`, matching local `origin/main`, with an empty index. That accepted R0 commit contains immutable migration0006, corrected migration0007, the eighth journal entry, original/corrective reviews and the final independent acceptance. No historical source was modified.

Read AGENTS/CLAUDE, routing/workflow, overview/index/scripts, approved human decisions, B.1 implementation/review, R0 implementation/original review/R0.1 response/independent acceptance, original R1 preflight and database/security/webhook/concurrency owners. Inspected the actual WebhooksController, receiver, processor, normalizer, DatabaseService, command result/mirror bookkeeping, reconciliation, ownership proof builder/sealer/reader, admission lifecycle functions and restricted capabilities.

| Boundary | Inspected implementation |
| --- | --- |
| Existing HTTP verification | [WebhooksController](../../apps/api/src/webhooks/webhooks.controller.ts) supplies exact request.rawBody/signature; [receiver](../../apps/api/src/webhooks/webhook-receiver.service.ts) invokes Stripe SDK constructEvent before inserting the legacy inbox |
| Existing normalization | [Normalizer](../../apps/api/src/webhooks/stripe-event.normalizer.ts) preserves supported terminal mapping; pending refunds become provider.unsupported/null; R0 SQL separately determines relevance |
| Existing processor | [Processor](../../apps/api/src/webhooks/webhook-processor.service.ts) claims legacy inboxes and invokes existing financial handlers; it does not consume R0 admission |
| Atomic admission foundation | [0007](../../apps/api/drizzle/0007_receipt_admission_foundation.sql) owns publication/enrollment, mandatory obligations, reviews, revisions and reader predicates |
| Trusted correlation | [0006](../../apps/api/drizzle/0006_trusted_financial_evidence.sql) owns immutable command provenance, ownership, proof builder, sealer and effective projection |
| Live result bookkeeping | [Command handler](../../apps/api/src/payment-commands/payment-command-handler.service.ts) writes mutable provider_transactions and attempt/refund references; it does not publish immutable financial observations |

The current signed receiver is not the proposed R1 adapter: its inbox INSERT autocommits and it does not call the protected receipt publisher. Nothing was registered in the production module/controller/worker. No production/shared database, provider API, broker or runtime credential was used.

## 2. Confirmed remaining contract gap

R0.1 handles contradictory facts **within one original admitted receipt**. R1 also requires durable handling of a **later conflicting delivery** with the same provider event identity. R0's safe rejection of replacement bytes is not a complete later-delivery retention/review protocol.

Exact SQL evidence:

1. Migration0006 makes provider_financial_receipts one immutable row per original inbox. It stores first raw bytes/signature/headers/normalization/account; a second delivery cannot replace them.
2. Migration0007 `publish_admitted_receipt` rejects changed raw bytes/account/verifier with `Contradictory duplicate receipt; original retained`. That attempted transaction does not append a conflicting-delivery witness or create a new review/blocker.
3. The same migration deliberately creates **no obligation** for a genuine nonfinancial customer event. The existing permanent admission test asserts that committed state and a clear isolated reader.
4. `review_receipt_obligation` begins with `SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox`. It can reblock an existing obligation, but cannot review-block an admitted inbox that has none.
5. The deferred consistency function requires `a.financially_relevant IS DISTINCT FROM FOUND` to be false. An obligation cannot simply be inserted for an immutable nonfinancial enrollment; original enrollment/payload/receipt reclassification is also prohibited.
6. `inspect_receipt_admission` reads actual account/scoped obligations and OPEN accounting exceptions, not arbitrary financial_evidence_reviews JSON. Appending a note alone is not an admission barrier.
7. Original provider/event identity is unique in webhook_events. Inventing a different provider event ID to store a conflicting signed delivery would break the signed identity contract.

Consequently the required combination **nonfinancial original enrollment → later same-ID financial contradiction → retained evidence plus durable applicable blocker** cannot be implemented through the installed guarded APIs. The same absence of a general conflict-delivery contract needs review for conflicting normalization/account context and for already scoped originals. A publisher exception or HTTP error alone does not retain and block that later evidence.

This conclusion is a source/catalog contract assessment, supported by executed existing admission regressions. No new conflicting-delivery simulation, new signed R1 HTTP route or access-control bypass experiment was executed. The old byte-conflict regression proves refusal and original preservation; it does not prove automatic conflict retention or that a previously clear event becomes blocked. The 31 R0.1 classification cases do not claim that extra capability either.

Granting direct review INSERT would not fix the missing-obligation case. Generic review JSON can describe observations but cannot become financial proof or a new SQL reader predicate by application convention. No such permission/path was introduced. Accepted R0 remains valid as its reviewed dormant foundation; the new R1 request explicitly stops when conflicting-delivery retention needs a database extension.

## 3. Minimum forward contract requiring review

Before completing R1, review a narrow **forward** conflict-delivery extension after0007. Do not rewrite0006/0007 or broaden financial writer behavior. It must provide:

- Immutable, idempotent conflicting-delivery provenance linked to the actual original event/inbox: exact later raw bytes/signature/headers, normalized snapshot, trusted configured provider/account context and verification version. Preserve the first receipt, enrollment, proof and financial references.
- A restricted guarded publication capability, callable after SDK verification, that atomically retains the conflict and establishes the applicable durable review blocker/revision. It must cover originals with no obligation, unknown owners and already owned originals without guessed ownership or fabricated inbox IDs.
- Checked same-event/account/review linkage, exact replay behavior and current-reader participation. Define affected account/scope authority for conflicting account/ownership evidence under H04; do not infer that authority from caller metadata or a JSON note.
- The existing private inbox → chosen account mode → canonical advisory/scope prefix, no SHARE upgrade/reversed financial-row dependency, and transaction rollback that retains any earlier committed original/blocker. Pin function context, revoke PUBLIC execution, use narrow owner capabilities and preserve closed ACTIVE/financial-version gates.
- Ordinary-role and concurrency regressions for first nonfinancial/pending/confirmed receipts followed by conflicting bytes/normalization/account, replay of a conflict, reader-first/receipt-first, resolution races and stale revision refusal. Distinguish legitimate retransmission with a fresh valid signature from a material evidence conflict.

These are requirements for a separate review, not executable DDL or an implementation authorization inferred by this run. No additional accounting policy, feature flags or workflow framework is proposed. Pending-refund Option A is unchanged.

## 4. Intended R1 transaction and correlation boundaries

The supported first-publication architecture remains: verify exact raw bytes with SDK and a trusted configured endpoint/account context; normalize; begin READ COMMITTED; insert/get the original inbox; invoke publish_admitted_receipt; commit inbox/receipt/enrollment/obligation/revision together. Any new-contract publication failure must roll back its newly inserted inbox too. Do not reinterpret a legacy bare inbox/receipt as an admitted historical contract fallback. This architecture was inspected, not implemented here.

Identical deliveries must return the same durable identity, preserve original bytes/headers, and add no obligation/proof/revision. R0 already supplies stable SQL publication/enrollment for identical stored evidence. The missing conflict contract must be available before a complete signed ingress adapter can safely cover all requested delivery cases. A catch-and-ignore, owner-pool direct INSERT, account guess or alternative synthetic provider event ID is not an acceptable substitute.

After durable intake, use separate correlation work: trusted lookup → B.1 sealer under its own private-inbox/account-UPDATE/advisory/scope/financial-reference prefix → effective SQL proof projection → guarded R0 binding. Binding revalidates proof ownership after its locks and atomically transfers unknown account authority to the verified scoped blocker. Do not call the sealer after a shared intake/scope prefix, claim that proof alone authorizes application, or invoke any network request under those locks. No new lock edge was introduced in this run.

### D02 publisher dependency

The checked-in runtime has no producer of provider_financial_observations; its only src declaration is schema storage. Command execution updates mutable provider_transactions/attempt/refund references, and reconciliation records its own findings. Those are not B.1 immutable command-result attestations.

The B.1 builder requires a same-provider/account refund command-result witness when refund metadata is absent, and original capture command-result provenance even when an explicit refund owner is supplied. It validates accepted command identity/key/payload, canonical owner/amount/currency, frozen capture sources and original POSTED journals. Dispute correlation uses capture/provider provenance, without an invented dispute command. Missing genuine D02 sources must leave correlation unresolved and the account barrier intact. Existing approved test publishers are explicitly synthetic trusted fixtures; they do not establish a real runtime producer. None was manufactured for R1 here.

## 5. Roles, dormancy and compatibility

Inspected six relevant installed admission/sealer routines in four disposable databases: eight migrations and the exact approved0007 hash; no PUBLIC EXECUTE; pinned `pg_catalog, pg_temp`. SQL persistent tables are schema-qualified. The original NOLOGIN capability owners remain unchanged, and the accepted suites exercise restricted publisher/worker permissions. No production/runtime grants or credential changes were made. A trusted stored receipt still does not authorize financial application.

All four inspected databases had **zero ACTIVE scopes and zero enabled evidence accounts**. Existing schema constraints continue to exclude ACTIVE and new financial proof-version use. Two isolated admission suites retain an executed genuine nonfinancial admission with no obligation, consistent with the source analysis above. Catalog evidence is `.tmp/r1-post-r0-catalog.json`; it does not assert the missing R1 path passed.

Legacy HTTP receiver, inbox processor, provider/mirror bookkeeping, refund/dispute/settlement/payout writers and transport remain unchanged. The admitted pending fixtures stay in the existing suites' private databases, so the legacy shared-database pollers cannot consume them. The six original F01 assertions are untouched. Old R1 preflight and all B.1/R0 implementation/review history are preserved.

## 6. Executed verification

Local environment: Node24.19.0, pnpm10.26.0, disposable PostgreSQL18.6 at127.0.0.1:55432. Fresh matrix database: `fintech_r1-post-r0_1792319715726`, all8 unchanged migrations. No private environment values were loaded/printed. New adapter, HTTP and correlation integration tests are **NOT RUN: implementation stopped before adding them**.

| Executed check | Result |
| --- | --- |
| Existing complete PostgreSQL matrix | **491 passed /14 suites /0 failures /0 skips**,106.640s |
| Separate original F01 | **6 expected financial assertion failures /0 skips**,17.689s; original names/statuses/financial differences preserved |
| pnpm lint | Passed |
| pnpm test | Passed:50 units;497 DB opt-ins skipped here, executed separately above |
| pnpm build | Passed on permitted retry after sandbox EPERM writing Next output |
| pnpm typecheck | Passed after build |
| Catalog check | Four isolated databases: approved0007 hash, zero ACTIVE/enabled, six relevant pinned/no-PUBLIC routines and exact installed missing-obligation/review preconditions |

The491 cases include all requested existing capture/refund/dispute/settlement, B3.1, B.1 evidence/migration, R0 admission/classification/migration, F02, allocation and financial concurrency suites. They verify the unchanged foundation; they do not certify a signed R1 adapter or the missing conflicting-delivery contract. The six red F01 cases remain separate financial defects and were not weakened into passes.

Exact commands, root unless marked API directory:

```powershell
git -c safe.directory='C:/Work/Learning Projects/learn-fintech' status --short --branch
git -c safe.directory='C:/Work/Learning Projects/learn-fintech' log -3 --format='%H %s'
& 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' start -D '.tmp/verification-pg18' -l '.tmp/r1-post-r0-postgres.log' -o '-p 55432 -h 127.0.0.1' -w
node .tmp/r1-post-r0-prepare.cjs
node .tmp/r1-post-r0-setup.cjs

# apps/api
$env:TEMP=(Resolve-Path '../../.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
$env:MIGRATION_ADMIN_URL='postgres://fintech@127.0.0.1:55432/postgres'
$env:DATABASE_URL='postgres://fintech@127.0.0.1:55432/'+(Get-Content '../../.tmp/r1-post-r0-db.txt').Trim()
node node_modules/jest/bin/jest.js --runInBand test/integration --testPathIgnorePatterns settlement-f01.pending --cacheDirectory ../../.tmp/jest-r1-post-r0 --json --outputFile ../../.tmp/r1-post-r0-pg.json
$env:RUN_F01_PENDING='1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-r1-post-r0 --json --outputFile ../../.tmp/r1-post-r0-f01.json

# Root, separate static-check processes; no DB opt-ins inherited.
$env:COREPACK_HOME='C:/Users/Daniel/AppData/Local/node/corepack'
$env:COREPACK_ENABLE_NETWORK='0'
$env:TEMP=(Resolve-Path '.tmp/b1-independent-temp').Path
$env:TMP=$env:TEMP
$env:RUN_DB_TESTS='0'
$env:RUN_MIGRATION_TESTS='0'
$env:NEXT_TELEMETRY_DISABLED='1'
pnpm.cmd lint
pnpm.cmd test
pnpm.cmd build
pnpm.cmd typecheck
node .tmp/r1-post-r0-catalog.cjs
node .tmp/validate-docs.cjs
git -c safe.directory='C:/Work/Learning Projects/learn-fintech' diff --check
```

Ignored output uses `.tmp/r1-post-r0-*.log`/JSON. Initial build log records the sandbox EPERM; `r1-post-r0-build-accepted.log` records the successful retry, followed by standalone typecheck. The catalog/marker tools only inspect state or manage ignored local evidence; they are not shipped code. Final documentation/preservation/cluster-restoration results are recorded below after completion.

### Hosted and external evidence

Inspected the retained [successful R0 CI run](https://github.com/daniel-tsx/fintech/actions/runs/39118922335) evidence for this exact starting SHA: Node22/24 and PostgreSQL17.11 passed, including all migration suites,491 integration tests and six opt-in F01 skips. That is **historical R0 hosted evidence**, not a newly triggered R1 run. No new hosted job, signed HTTP ingress, Stripe/test-account API, RabbitMQ/Redis, live financial adapter, production migration, real-history reconciliation, credential fence or activation was executed here.

## 7. Changed files and independent handoff

Only this new post-R0 preflight record and its documentation-index link changed. **Runtime files changed: none.** Migrations0000–0007, Drizzle journal/schema, all permanent tests, accepted review history and the original R1 stop report are unchanged. No staging, commit or push. No scope was activated; R2/B.3/B.4 were not started.

Review the minimum conflict-delivery contract before another R1 implementation attempt. Prioritize no-obligation originals, later pending/financial/account contradictions, preserved first and conflicting evidence, protected barrier/revision creation, safe role grants and both reader acquisition orders. Separately require actual D02 provenance producers before claiming runtime correlation readiness. Then implement and verify the requested signed HTTP/correlation matrix without weakening the accepted foundations. F01/F04/F05/F06 and all R2 financial application/claim/policy/fencing obligations remain open.

Completion: `node .tmp/validate-docs.cjs` passed **45 Markdown files /564 relative links and anchors**, plus CI YAML parsing/structure checks. It extracted19 existing Mermaid blocks without parsing/rendering. `git diff --check` and direct final-newline/trailing-whitespace checks passed. `node .tmp/r1-post-r0-finish.cjs` verified exactly two documentation changes, unchanged HEAD/empty index, unchanged runtime/schema/journal/tests and all eight migrations, byte-preserved original R1 report,491 green PostgreSQL tests and exact original six F01 names/statuses/financial assertion differences. Current suite database identities were retained separately and earlier marker files restored. `pg_ctl.exe stop -D .tmp/verification-pg18 -m fast -w` exited0, restoring the initial stopped cluster without removing financial histories. No commit, push or R1/R2 implementation occurred.
