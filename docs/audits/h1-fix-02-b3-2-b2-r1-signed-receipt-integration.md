# H1 Fix 02 — B3.2 B.2-R1 signed receipt integration

Status: **READY_FOR_INDEPENDENT_REVIEW**, isolated and dormant. No commit, push, financial application or activation.

Started on clean `main` at approved R0.2 commit `8c332fbabc429620924aeacf2ddbbcf1c9b0125f`. A fresh disposable PostgreSQL18.6 database has all nine migrations, verified0006–0008 source hashes and zero ACTIVE scopes. Original migrations, accepted reviews and both historical R1 stop records are preserved. [Webhooks/idempotency](../webhooks-and-idempotency.md), [Security](../security.md), [Database design](../database-design.md) and [Concurrency](../concurrency.md) retain current behavior ownership.

Implementation contract: exact raw-byte SDK verification and server-owned endpoint/account configuration precede a restricted READ COMMITTED transaction. The first inbox plus R0 publication commit together. A unique insert loser performs a fresh statement read, requires an existing trusted receipt AND R0 enrollment, then uses R0.2 for independently verified later bytes. Bare historical identities reject without invented trust. Signature/header refresh is neutral under the installed SQL equivalence rule; genuine later contradictions retain independent immutable evidence/barriers. Failure is not acknowledged as handled.

The adapter and correlator have no live module/controller/worker registration. Dedicated restricted LOGIN pools are mandatory; owner/member/elevated/direct-trusted-table/ledger-write connections are rejected before publication. All grants belong only to disposable test setup. No production credential, role, migration or environment default changes.

Correlation consumes existing immutable command-result/capture provenance only. Sealing and guarded obligation binding use separate fresh transactions. Missing/contradictory canonical evidence leaves the original unknown-owner blocker in place and appends an immutable unresolved review; no command history or financial outcome is manufactured. Existing D02 runtime producers and R2 application/recovery remain required.

## 1. Implementation inventory

| File | Responsibility |
| --- | --- |
| `apps/api/src/webhooks/trusted-signed-receipt.service.ts` | SDK verification, copied raw/header/configuration snapshots, versioned normalization and the two atomic publication paths |
| `apps/api/src/webhooks/trusted-receipt-correlation.service.ts` | Existing immutable witness selection, B.1 sealer then guarded R0 binding, immutable unresolved dependency recording |
| `apps/api/src/webhooks/trusted-receipt-database.ts` | Explicit isolated DI tokens, restricted authenticated-login checks, READ COMMITTED and bounded whole-transaction retry |
| `apps/api/test/support/trusted-receipt-harness.ts` | Fresh private database, test-only LOGIN grants/pools, isolated Nest controller and local HTTP application with raw-body capture |
| `apps/api/test/integration/trusted-signed-receipt-integration.spec.ts` | 65 permanent HTTP/publication/correlation/concurrency/rollback cases |
| This record | Implementation evidence and independent review handoff |
| `docs/README.md`, `docs/webhooks-and-idempotency.md`, `docs/security.md`, `docs/database-design.md`, `docs/concurrency.md`, `docs/verification.md` | Navigation and current owners' isolated behavior/verification description |

No existing src file, migration, Drizzle schema/journal, previous test assertion, provider/broker code or historical audit report changes. There is no new controller/module under src, environment default, migration, generic flag framework or dependency. All setup scripts, database artifacts, caches and JSON/log reports remain ignored. This is twelve deliverables; generated files are not deliverables.

## 2. Signed HTTP and account boundary

The HTTP controller exists only in test support, mounted by a small Nest testing module on an ephemeral loopback port. It passes `request.rawBody`, the signature header and request headers to `TrustedSignedReceiptService`. A second test application without raw capture proves parsed JSON cannot substitute. Tests send actual HTTP requests with Stripe SDK-generated signatures; no real Stripe API, endpoint forwarding or live webhook was used.

The service copies the Buffer before its first asynchronous database boundary and clones retained headers. It calls `stripe.webhooks.constructEvent(raw,signature,webhookSecret)` before database work, uses only that verified event for identity/normalization, and rejects absent/empty bytes, invalid/expired signatures, post-signing byte modification, malformed event identity/normalization and signed account disagreement. It never rebuilds signed bytes from parsed JSON. The endpoint object is copied/frozen, supplied by server composition, without a default secret/account or request-selectable context. One adapter instance represents one configured account; a multi-account live front door is not implemented.

Version1 normalization is the unchanged current normalizer. Its output and exact bytes/signature/transport headers are retained. `stripe-node/<installed SDK version>;R1_RECEIPT_V1` identifies the verifier/adapter. R0 SQL independently owns relevance/contradiction classification: an unsupported customer lifecycle is nonfinancial, unsupported financial events retain an unknown blocker, and genuine pending/requires_action refunds preserve Option A. Owner metadata/account headers do not select provider-account or internal financial authority. SDK authenticity alone never seals internal ownership.

## 3. First and later publication

After verification, a READ COMMITTED transaction attempts only `ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id`. A successful INSERT calls0007 `publish_admitted_receipt` before commit. New inbox, original verified receipt, admission, required obligation/review and revision therefore succeed or roll back together. The initial financially relevant owner is unknown; no metadata-selected merchant/scope or speculative financial effect is installed. Known ownership is established through the separate proof/binding path.

The index loser waits for the winner and then executes a **separate** SELECT with a fresh READ COMMITTED snapshot. It requires both original trusted receipt and R0 admission before calling0008 `publish_verified_receipt_delivery` with the original inbox ID, server account and newly verified raw/signature/headers/normalization/version. It does not catch an aborted transaction and continue within it or use a stale single-statement CTE snapshot.

The original and its classification stay immutable. The first exact duplicate appends a neutral later witness; repeated identical attempts reuse its identity. Refreshed signatures/headers remain equivalent when signed JSON/account/normalization agree. Genuine contradictions use the installed independent immutable review/barrier/revision contract. An originally nonfinancial receipt keeps zero original obligations while later financial evidence blocks independently. Different independently configured trusted accounts preserve separate provenance and protect only the implicated authorities. A mismatched signed account on one endpoint rejects before SQL.

A bare legacy inbox or B.1 receipt without R0 enrollment returns `HISTORICAL_RECEIPT_REVIEW_REQUIRED`/409, without mutation, fabricated trust, reclassification or acknowledgment of handling. That error is not a durable quarantine for existing legacy money movements. Historical D03 treatment remains a separate reviewed prerequisite before live routing; neither enabling a route nor granting a credential may silently promote those rows.

The adapter awaits COMMIT, including deferred checks, before returning success. A failed first publisher rolls back its newly inserted inbox. A later failure between witness and barrier construction returns an HTTP failure and retains the prior original/revisions without partial evidence; a normal retry then commits the full witness/barrier. Unexpected uniqueness, permission and domain errors propagate, not successful duplicate responses.

## 4. Existing provenance and correlation

Correlation has an internal inbox-ID API; it is not mounted as HTTP or called by the receiver/worker. A fresh transaction reads the admitted original's configured account and attempt revision. For refunds it selects an existing same-account COMMAND_RESULT/REFUND observation for the verified original provider object, deterministically by ID. It cannot insert observations or accept an unverified caller-selected owner. B.1's sealer revalidates that witness against accepted command/key/payload, exact refund owner/principal/currency, immutable original capture journals/lots, capture command provenance and competing object ownership.

Disputes use B.1's uniquely owned capture/provider evidence, with no refund observation argument or invented dispute command. The sealer returns the same SQL effective projection used by existing validators. The positive fixtures explicitly publish synthetic trusted command results using the pre-existing test helper; they prove integration with already trusted sources, not a real D02 producer. Without those sources, original metadata or a mutable mirror cannot replace missing capture evidence. Missing optional metadata works only with independently retained canonical witnesses.

After proof commit, another fresh transaction calls `bind_receipt_obligation`, which revalidates the owned tuple under its own locks and advances account/scope revisions atomically. BOUND means the scoped obligation is AWAITING_APPLICATION and still blocks the reader. It does not clear or resolve anything financially. A binding permission failure leaves one committed proof and the original blocking unknown obligation; retry reuses that proof and completes the guarded transfer. Duplicate sealing/binding preserves one proof and stable revisions.

Pending, nonfinancial or unclassified operations return NOT_SEALABLE. SQL evidence/prerequisite refusals P0001/P0002 append an immutable UNRESOLVED review keyed by inbox/attempt/SQL state in a separate transaction after rollback. It records a trusted-correlation dependency, not a financial outcome or oracle about why provider money moved. The original unknown blocker remains; repeated identical refusal does not duplicate the review. Other errors propagate. Wrong ownership/principal/currency/object, competing bindings and missing sources never produce guessed proof. Existing R0.2 barriers remain independently blocked even if the original later obtains a legitimate proof/binding; original nonfinancial evidence is never resealed to absorb its later contradiction.

## 5. Capability and lock evidence

The isolated composition explicitly supplies separate publisher and correlator transaction tokens. `RestrictedReceiptDatabase` rejects a pool whose current user differs from session user, is non-login/elevated/inheriting/a member of another role, lacks its restricted function capability, or can directly mutate protected receipt/proof/observation/delivery tables or ledger tables. Catalog and persistent table queries are schema qualified. There is no fallback to global DatabaseService, owner pool, SET ROLE, broad grants or PUBLIC EXECUTE.

Test setup creates fresh limited LOGIN principals with random fixture passwords, not production credentials. Publisher rights are narrowly enumerated inbox INSERT/identity reads and publication EXECUTE. Correlator rights are necessary receipt/admission/observation identity reads, sealer/binding EXECUTE and append-only unresolved reviews. A separate ordinary worker has only admission-reader EXECUTE. They have no owner membership, schema CREATE or ledger writes. HTTP publication actually uses those authenticated sessions. Ordinary SQL cannot publish/fabricate/clear/reset; an elevated owner pool is refused even after valid SDK verification. SQL still trusts the capability holder's attestation; operational secret/credential isolation and provisioning remain unverified deployment gates.

Publication retains the installed private inbox → account authority → advisory/scope order. It never runs a network request while holding database locks. Sealing begins in a fresh transaction before its private-inbox/account-UPDATE/advisory/scope/payment/children/lot prefix. Binding starts another fresh transaction; no sealer is invoked after reader SHARE or later financial locks. Failed correlation review INSERT occurs only after rollback, without account/scope locks or another operation's inbox dependency.

Ten controlled schedules observe real `pg_blocking_pids` on distinct backends and verify committed state: identical first deliveries; identical conflicting replay; both acquisition orders for first/conflicting delivery, conflict/reader, unknown account conflict/another known scope's binding, and sealer/binder. Gates/timeouts are bounded and all started transactions awaited. Reader-first completes its earlier clearance before publication; conflict-first reader rejects after commit; saved revisions become stale. No deadlock is counted as success. Concurrent local HTTP requests also use separate restricted pools.

Only40001/40P01 retry the entire transaction, at most three attempts, after `begin` has rolled back, using unchanged already verified bytes/context. Two **injected PostgreSQL error-state** tests prove rollback/retry without duplicates; these are not reproduced deadlocks. Exhaustion propagates, and23505 is not retried or acknowledged. No application mutex, SQL isolation weakening, financial writer registration or universal deadlock claim is introduced.

## 6. Executed verification

Local Node24.19.0, pnpm10.26.0, PostgreSQL18.6 on disposable loopback55433. The initial setup applied all nine migrations and verified0006/0007/0008 source hashes. The new suite uses its own private database so pending admitted events cannot enter other suites' legacy global pollers. Earlier database-marker files were restored after full runs; financial histories are retained.

Root commands used installed offline Corepack (`COREPACK_HOME=C:/Users/Daniel/AppData/Local/node/corepack`, `COREPACK_ENABLE_NETWORK=0`) and ignored workspace TEMP/TMP. Ran `pnpm lint`, `pnpm test`, `pnpm build`, then `pnpm typecheck` after build. Final root results: lint/typecheck passed;50 units in12 suites passed, with624 DB opt-ins skipped there and separately exercised as618 green plus six expected red. API/web builds passed on the permitted retry after sandbox EPERM creating Next output. No dependency install/upgrade occurred. The web test script remains a notice, not dashboard browser coverage.

Exact PostgreSQL commands from `apps/api`, using explicit disposable DATABASE_URL/MIGRATION_ADMIN_URL and workspace TEMP/TMP:

```powershell
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
$env:MIGRATION_ADMIN_URL='postgres://fintech@127.0.0.1:55433/postgres'
$env:DATABASE_URL='postgres://fintech@127.0.0.1:55433/'+(Get-Content '../../.tmp/r1-signed-db.txt').Trim()
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/trusted-signed-receipt-integration.spec.ts --cacheDirectory ../../.tmp/jest-r1-signed --json --outputFile ../../.tmp/r1-signed-targeted-final.json
node node_modules/jest/bin/jest.js --runInBand test/integration --testPathIgnorePatterns settlement-f01.pending --cacheDirectory ../../.tmp/jest-r1-signed --json --outputFile ../../.tmp/r1-signed-accepted-pg.json
$env:RUN_F01_PENDING='1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-r1-signed --json --outputFile ../../.tmp/r1-signed-f01.json
```

| Coverage | Result |
| --- | --- |
| New signed HTTP/publication/provenance | 31 passed |
| New correlation, missing evidence and proof/binding | 20 passed |
| New controlled waits / injected abort-retry | 10 +4 passed |
| **New targeted suite** | **65 passed /0 skipped** |
| Existing accepted PostgreSQL matrix | **553 passed**, unchanged assertions |
| **Combined financial/evidence/migration matrix** | **618 passed /17 suites /0 skipped** |
| Separate six original F01 assertions | **6 expected financial failures /0 skipped**; source/names/statuses/financial messages preserved |

The combined run includes B.1 evidence/migration, R0 admission, R0.1 classification, R0.2 delivery/migration, F02, capture/allocation/refund/dispute/settlement/B3.1 and existing financial concurrency. The final explicitly qualified catalog query change was followed by a second complete matrix command with output `.tmp/r1-signed-qualified-pg.json`, without weakening financial assertions. No green result is inferred from skipped tests.

Initial evidence is retained: the first27-case run passed26 and hit a five-second cold Nest startup timeout in the first HTTP test. A bounded15-second integration test timeout allowed the full test to complete; later runs passed. Initial lint exposed untyped Supertest responses/server handles and two asymmetric-matcher assignments; the harness now types HTTP responses/Server and assertions, without disabling lint rules. Initial build failed sandbox EPERM; the permitted retry passed. These were corrected test/environment issues, not hidden passing claims.

Read-only catalogs verify the installed SQL owners/paths/ACLs, nine-migration hashes and closed scope/financial evidence gates across the retained isolated cluster. Final preservation and documentation counts are recorded in [Verification](../verification.md). `node .tmp/validate-docs.cjs` validates links/anchors and CI YAML structure and extracts existing Mermaid blocks; it does not rerun diagram parsing/rendering. `git diff --check` and new-file whitespace/newline checks are required at handoff. No financial test history is deleted; the local cluster returns to its initial stopped state.

## 7. Remaining boundaries and independent review

R1 is safe to review as an **isolated** SDK/SQL integration, not ready for live routing. Operational restricted credentials/grants, endpoint/account/secret ownership, raw-body ingress/rate limits, historical D03 handling and old-worker fencing need separate deployment/cutover review. D02 still needs genuine immutable provider command-result/reconciliation producers; this adapter deliberately leaves unresolved receipts blocked when they are absent. No provider lookup network path was added.

R2 still owns financial application, current policy/epochs/claims/permits, coordinated all-writer admission, full effect/workflow/audit/inbox linkage, protected financial-era/default1/no-downgrade gates, operation-specific resolution, conflict recovery and separate guarded resume. No ACTIVE scope, live refund/dispute/settlement/payout change, legacy worker cutover, provider transport change, or F01/F04/F05/F06 closure is claimed.

Independent review priorities: raw-byte/configuration snapshots and SDK-before-SQL trust; authenticated capability grants/owner-pool refusal; fresh-snapshot insert-loser routing; no acknowledgment of partial retention; exact versus equivalent/conflicting identities; legacy-only409 boundary; witness selection and canonical sealer interpretation; the proof-commit/bind gap; refusal recording without fabricated financial evidence; both lock schedules and bounded abort retry; immutable original/barrier/revision preservation; and absence of production module registration.

**NOT RUN for this R1 diff:** hosted CI, PostgreSQL17, Node22, live Stripe/API/webhook forwarding, RabbitMQ/Redis/BullMQ, live financial dispatch/admission, production role provisioning, mixed-version/fencing, scope activation or R2 recovery. Prior accepted R0.2 hosted success verifies that commit only. Local signed HTTP is explicitly separate from live Stripe verification. No commit or push performed.
