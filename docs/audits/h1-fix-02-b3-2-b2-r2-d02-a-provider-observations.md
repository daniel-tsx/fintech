# H1 Fix 02 — B3.2 B.2-R2 D02-A: immutable provider observations

Status: dormant implementation, local verification completed **2026-10-19**, awaiting independent review. This checkpoint supplies an isolated genuine producer. It does not install a runtime publisher, apply money, activate accounting scopes or close F01/F04/F05/F06.

## 1. Baseline, authority and scope

Started on clean `main`, HEAD **e38d30c851486c23ea4dfe09c48d65884b029b65**, “docs(accounting): approve staged financial application design”. No commit, push, remote update, live provider request or runtime cutover occurred in this run. PostgreSQL work used disposable localhost databases; their fixture history is retained.

Authority is the [approved R2 design](h1-fix-02-b3-2-b2-r2-financial-application-design.md), the [independent review](h1-fix-02-b3-2-b2-r2-design-review.md), particularly §§3 and 11–13, and [H01–H12](h1-fix-02-b3-2-human-decisions.md). Read the original B.1/R0/R0.2/R1 implementations and reviews, including the stopped R1 runs. Those records and approved human decisions are unchanged. Historical SQL0000–0008 and the six F01 assertions are unchanged.

Current provider flow remains API idempotency transaction → accepted operation/outbox/audit/replay → relay → RabbitMQ → `PaymentCommandHandlerService` → provider call outside SQL → mutable mirror/child transaction → ACK. The current handler does not fully compare the received envelope with accepted SQL authority before calling Stripe. Its mirror stores input amount and replaces result metadata. Neither the mirror nor ACK is immutable provider evidence. This checkpoint leaves that live flow unchanged.

## 2. Exact changed files

| Files | Change |
| --- | --- |
| [SQL0009](../../apps/api/drizzle/0009_provider_observation_sources.sql), [migration journal](../../apps/api/drizzle/meta/_journal.json) | One forward migration; no historical SQL rewrite |
| [Drizzle schema](../../apps/api/src/database/schema.ts) | Prospective authority, execution, source, obligation and projection-link mappings; nullable account mode |
| [Observed transport](../../apps/api/src/payment-provider/observed-stripe-transport.ts) | Supported Stripe HTTP boundary, exact bounded response bytes, per-HTTP-attempt lineage |
| [Restricted database](../../apps/api/src/payment-provider/provider-observation-database.ts) | Explicit authenticated publisher session validation and READ COMMITTED transactions |
| [Trusted producer](../../apps/api/src/payment-provider/trusted-provider-observations.ts) | SQL-derived commands, real adapter invocation, recoverable publication and typed lookup |
| [D02 fixture composition](../../apps/api/test/support/provider-observation-harness.ts), [D02 integration tests](../../apps/api/test/integration/provider-observations.spec.ts), [D02 migration tests](../../apps/api/test/integration/provider-observation-migration.spec.ts) | Isolated real SDK transport fixtures, restricted LOGINs, failure/concurrency/upgrade evidence |
| [Capture migration tests](../../apps/api/test/integration/capture-accounting-migration.spec.ts), [integrated verification](../../apps/api/test/integration/integrated-accounting-verification.spec.ts), [R0 migration tests](../../apps/api/test/integration/receipt-admission-migration.spec.ts), [R0.2 migration tests](../../apps/api/test/integration/receipt-delivery-migration.spec.ts), [settlement integration](../../apps/api/test/integration/settlement-accounting-integration.spec.ts), [B.1 migration tests](../../apps/api/test/integration/trusted-evidence-migration.spec.ts), [R1 fixture composition](../../apps/api/test/support/trusted-receipt-harness.ts) | Current migration count/title only, nine → ten. Original financial, fingerprint, security and expected-red assertions remain intact |
| This record, [documentation index](../README.md) | Implementation evidence and navigation |

Temporary scripts, logs, database markers, databases, Jest output, builds and caches remain ignored and are not deliverables. No module/controller/job/consumer/relay registration, package/dependency, runtime configuration, existing payment service, ledger writer, settlement/payout/refund algorithm or reconciliation service changed.

## 3. Immutable contract

SQL0009 adds five append-only structures:

1. `provider_command_authorities`: outbox FK, STRIPE/account/mode, operation and internal operation UUID, merchant/payment/currency, accepted amount, original provider key, complete accepted payload, recorded policy/epoch and acceptance time. One authority per outbox and operation; account/key uniqueness also applies.
2. `provider_command_executions`: local invocation UUID, authority FK, preparation time and authenticated database principal. Preparation commits before any remote call. A prepared execution means **possibly sent**, not success or no effect.
3. `provider_observation_sources`: immutable source UUID/order, authority FK, COMMAND_RESULT execution or PROVIDER_LOOKUP target/run/actor, explicit predecessor, request destination/method/path/safe headers/form bytes, complete/partial/absent original response bytes, HTTP status/request ID, transport category, observation time, SDK version, `D02_A_V1` interpretation and full publication fingerprint. No-object outcomes are legal.
4. `provider_observation_obligations`: one atomic source disposition/reason, known scope or unscoped account blocker and admission revisions. Only AWAITING_CONFIRMATION, AWAITING_APPLICATION and BLOCKING_REVIEW are representable. No clearance is implemented.
5. `provider_observation_projections`: immutable source-to-existing-object-observation link. This companion preserves the original object-observation row format and historical fingerprint assertions. Deferred checks require the appropriate exact projection and obligation together with the source.

The new nullable account mode is set only when an isolated account is inserted. Existing immutable accounts retain NULL and cannot be retrospectively configured through UPDATE. No migration backfills authority, execution, source, projection or obligation.

`accept_provider_command` is an isolated acceptance capability, never granted to the D02 publisher LOGIN. It validates outbox/accepted-child/payment identity, kind, amount/currency, canonical key and account/mode. It requires current-transaction row versions of both child and outbox. Existing committed commands fail this prospective path. Financial identity then becomes immutable; operational outbox status/lease/attempt fields remain mutable. As with the existing evidence contracts, trusted acceptance code and database administrators remain a trust boundary; row-version checks do not authenticate arbitrary owner SQL.

Only prospective **LEGACY / epoch 0** acceptance is represented, because the existing accepted-intent schema has no approved installed CAPTURE_OWNED policy writer. This records the current policy; it does not invent or activate a cutover policy. Runtime intent acceptance, recording future policy/epoch and enrollment of eligible scopes require their later authorized checkpoint. The fixture takes the account lock before constructing the accepted child and outbox through `OutboxService` in one transaction. No new API intent writer is registered.

## 4. Actual producer and provenance

`TrustedProviderObservations.execute` uses a separate restricted database connection to compare outbox UUID, aggregate UUID, event type and the entire broker payload with protected accepted authority. It then builds the provider input from SQL fields. A mismatched envelope/account fails before HTTP. The provider key always comes from acceptance.

The isolated composition constructs the existing `StripePaymentProvider` with an actual stripe-node client and `ObservedStripeTransport`. That wrapper uses Stripe's public HTTP client/response interfaces and the Node response byte stream. It captures the request and each received response **before** UTF-8/JSON decoding. It does not reconstruct original bytes from `ProviderResult`, a mirror, `lastResponse` or a parsed SDK event. Tests fail if the inner fixture's `toJSON` is consumed instead of its original bytes.

An AsyncLocalStorage context isolates concurrent invocations. Every HTTP attempt, including SDK retries, receives its own source key under the invocation UUID. HTTPS/api.stripe.com/443, configured Stripe-Account, accepted POST key and retry horizon are checked before transport dispatch. The producer owns copied account/mode settings; broker metadata cannot select them. Authorization headers and API keys are never retained. Safe API-version/request-ID headers are retained.

Response retention is bounded to 1 MiB. A truncated, stalled or oversized body retains its received prefix as PARTIAL; no received body is ABSENT. Invalid JSON/UTF-8 retains COMPLETE original bytes but yields no authoritative object. No replacement-character JSON is blessed. Normalized actual provider amount/currency remain distinct from accepted requested amount/currency. SQL parses the actual retained form bytes and response bytes, checks accepted operation/path/key/account/financial request fields and derives the owned projection. Explicit account/mode/owner/PI/amount/currency conflicts retain truthful sources and block review.

The publisher capability attests a real transport result. PostgreSQL validates lineage, normalization and atomic publication; it cannot prove TLS, validate a Stripe API credential's external account rights or turn an API response into a signed webhook. The actual tests use the real SDK/adapter against a controlled HTTP-client fixture, with no external Stripe request. External credential/account validation remains unverified. Stripe's supported client interface and retry behavior are documented in [stripe-node](https://github.com/stripe/stripe-node).

`lookup` is a separate PROVIDER_LOOKUP path through the real adapter's `fetchStatus`. It requires a durable reconciliation run and actor, configured account/mode, the accepted PI for CAPTURE/VOID or a previously owned returned object, and predecessor lineage where available. A lost-response execution may authorize a lookup of its accepted PI without pretending a prior response existed. An arbitrary refund ID is rejected before GET. A refund/authorization with no known owned returned object cannot be discovered by guessing: safe same-key recovery or later reviewed evidence is still required. Lookup cannot satisfy predicates specifically requiring COMMAND_RESULT.

## 5. Outcome and retry semantics

| Evidence | D02 disposition / effect |
| --- | --- |
| Owned returned refund success | RETURNED_OBJECT, CONFIRMED_PROVIDER_RESULT, AWAITING_APPLICATION; protected object projection; no local financial effect |
| Owned returned refund failed/canceled | RETURNED_OBJECT, DEFINITIVE_PROVIDER_FAILURE, AWAITING_APPLICATION; no automatic reservation release or workflow finality |
| Owned authorization/void result | Confirmed source/obligation, no fabricated CAPTURE projection |
| Capture response with aggregate PI amount | CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED, BLOCKING_REVIEW; preserved response and accepted-command lineage, no per-capture projection |
| Genuine pending, timeout, partial/malformed body or uncertain transport | AWAITING_CONFIRMATION, Option A neutral; never guessed failed |
| HTTP429/5xx | RETURNED_ERROR when a complete error body exists, RETRYABLE_TRANSPORT_FAILURE; still no no-effect proof |
| Other returned API error/resource missing | Returned error/unknown tracking; no automatic definitive financial failure |
| Terminal contradiction or owner/account/object conflict | Independent BLOCKING_REVIEW source; prior bytes/projections remain immutable |
| Exact publication replay | Same source identity and full fingerprint return the original row; no new revision or obligation |
| Actual later same-key HTTP response | New execution/source, linked to prior history; no overwriting |
| Reused source key with changed publication | Independent immutable conflict witness, SOURCE_KEY_CONFLICT, unscoped account blocker; cannot disappear behind ON CONFLICT |

Source row UUIDs remain unique; the fingerprint distinguishes exact replay from a changed-key collision witness. The latter deliberately remains visible under the colliding claimed source key. Pending→terminal progression is permitted without inventing a contradiction; incompatible terminal result or object ownership remains blocked.

There is no exactly-once provider execution claim. SQL preparation and remote execution are separate commits. Reinvocation uses the original key and new local invocation identity. The earliest preparation establishes a conservative **23-hour** automatic POST replay limit; SQL and the per-HTTP-attempt transport guard enforce it. After expiry, use an owned lookup or review. No key rotation or fresh-key monetary retry exists. Stripe may prune keys after at least 24 hours and caches error responses too; see [idempotent requests](https://docs.stripe.com/api/idempotent_requests) and [advanced error handling](https://docs.stripe.com/error-low-level).

## 6. Failure windows

| Boundary | Demonstrated recovery / remaining dependency |
| --- | --- |
| Preparation rolls back | No HTTP call dispatched through this invocation |
| Prepared, worker stops before publication | Prepared row survives; missing source is not failure. Redelivery creates a new invocation with the original key |
| Provider success, SQL publication fails while bytes survive | `PendingObservation.publish()` retains original bytes/keys/times in a closure. The transaction rolls back source/projection/obligation/revisions together. Republish that handle without another HTTP call |
| Process loses copied response | No claim to recover original historical bytes. Safe-window same-key execution records the response received now; an expired key stops POST recovery. Known-PI lookup records its actual present source |
| Signed receipt arrives first | Existing R1 receipt/obligation remains durable. Correlation must be retried after genuine command evidence is available; no SDK response manufactures an inbox or silently clears the receipt |
| Reconciliation contradicts an earlier outcome | Append separately sourced lookup/review; preserve the original result and financial history |
| Source commits, mirror/ACK later fails | Source and blocker survive. Future runtime integration must revalidate progress and retry subordinate bookkeeping; this checkpoint changes neither mirror nor ACK |
| No usable signed event / per-capture amount attribution | Keep source obligation unresolved. R2 proof/application/recovery checkpoints are still required |

The retained publication handle is process memory, not a durable response spool. The explicit prepared execution plus same-key/owned-lookup path covers process loss conservatively; it does not reconstruct a lost response or discover an unknown refund by heuristic matching.

## 7. SQL ownership, admission and locking

SQL0009 creates a database-specific NOLOGIN/NOINHERIT observation owner, with no superuser/role-management/replication/RLS bypass attributes, no owner-role membership and no ledger permissions. Security-definer routines pin `search_path=pg_catalog,pg_temp` and qualify table references. PUBLIC cannot execute the new publication, preparation, acceptance or helper capabilities. The migration creates no publisher LOGIN or production credential grant.

Only the existing guarded admission owner can advance receipt/scope evidence revisions and insert the atomic source obligation. The new owner receives narrow source/projection INSERT, required SELECT, sequence usage and the column privilege needed for account row locks. It cannot directly advance guarded scope/intake revisions. The isolated publisher LOGIN has only required reads and prepare/publish EXECUTE; no receipt/proof/table/ledger DML, schema CREATE or owner membership. Every transaction checks actual `current_user=session_user`, role attributes/membership and table **and column** privileges. Elevated or broadened sessions are rejected. SQL transactions do not include provider calls or blindly retry remote operations.

Publication takes account UPDATE before A/S and scope NO KEY UPDATE; the staged reader takes account SHARE before the same scope order. This serializes first intake insertion, unknown account blockers, exact duplicate publication and cross-scope publication against clearance. READ COMMITTED is mandatory. Confirmed/contradictory sources advance revisions with their mandatory obligations. The reader retains all B.1/R0/R0.2 predicates and additionally rejects unresolved D02 scoped/account blockers. Pending-only observation tracking stays neutral. No ACTIVE scope, runtime-ready permit, application journal, compensation, source clearance or new financial writer is installed.

## 8. Executed local verification

PostgreSQL **18.6**, x86_64-windows, MSVC19.44.35228. Node24.19.0, pinned pnpm10.26.0, stripe-node22.6.2. Disposable cluster at localhost:55433; no hosted database or actual provider verification. Tests authenticate separate restricted LOGIN connections, rather than SET ROLE as an owner.

Final scope audit: **18 changed/new files**, empty index and unchanged starting HEAD; no commit or push. Approved design SHA256 remains `ed2c3656c85aa1e47d187dd6ad460ee750140e8e831eecf31fbfe0c1d420a0dd`; independent review remains `12536494574969553d30f3f8d24a8d1a0c3f5a1fa2c00b272fb3daed0cf1d171`. Restored all38 pre-existing ignored database-marker contents after the suites. The disposable cluster was returned to its initial stopped state, with databases/history retained.

| Executed check | Final result |
| --- | --- |
| Full PostgreSQL integration matrix, `RUN_DB_TESTS=1`, `RUN_MIGRATION_TESTS=1`, explicit local disposable URLs; Jest `--runInBand test/integration --testPathIgnorePatterns settlement-f01.pending` | **686 passed / 20 suites**, 122.065 seconds. Includes **51 D02 integration + 2 D02 migration tests** and all **633 pre-existing green regressions** |
| Explicit `RUN_F01_PENDING=1`, Jest `settlement-f01.pending.spec.ts` | **6 failed / 1 suite, intentionally expected**. Every failure is its unchanged financial balance assertion, not infrastructure/permission/setup failure |
| `pnpm lint` | Passed API and web |
| `pnpm typecheck` | Passed API and web |
| `pnpm test` | **50 passed / 12 suites**; **692 skipped / 21 suites** (database suites are executed separately above), 742 total assertions discovered |
| `pnpm build` | Passed Nest API and Next web production builds; no deployment |
| Documentation validator | **52 Markdown files, 747 relative links/anchors**, CI YAML parsed/structure checked; 19 unchanged Mermaid blocks inventoried, no new diagram syntax introduced |
| `git diff --check` and new-file whitespace checks | Passed |

The dedicated focused D02 run and affected R0/R0.2 migration run passed **63 tests / 4 suites** before the final two adverse cases were added. The final full matrix above includes those additional cases. Repeated runs are not added together as distinct coverage.

Earlier iterations exposed a fixture attempting to UPDATE an immutable account, TypeScript/lint issues, and whole-row historical fingerprints changing under a proposed observation column. Those issues were fixed by prospective account insertion, typed fixtures and the companion projection link; original preservation assertions were not weakened. Sandbox-only Jest cache rename/Next artifact EPERM and an uncached Corepack location were resolved using the existing offline pnpm cache and unsandboxed local checks. No dependency download or upgrade was needed.

Failure/concurrency assertions cover all18 requested scenario families: accepted success/failure; remote success then local rollback; worker interruption; repeated broker command and exact response publication; later terminal contradiction; wrong command/aggregate/event/key/account/merchant/payment/amount/currency; timeout; owned lookup after unknown/lost response; simultaneous duplicate and distinct publishers; reader-before-publisher lock waiting; unauthorized/owner sessions; immutable UPDATE/DELETE/TRUNCATE; deferred incomplete-source rejection; rollback/republication; R1 closed-proof behavior; and unchanged ledger/payment/lot fingerprints. Additional tests cover complete/partial/oversized/invalid-UTF8/invalid-JSON/error bodies, SDK HTTP retries, explicit returned-account conflict, unique accepted operation and expired replay horizon.

The full financial matrix retains B.1/R0/R0.2/R1, capture, refund, dispute, settlement, payouts, journal immutability, migrations and controlled PostgreSQL races. The six legacy F01 cases assert the approved correct outcomes and remain intentionally red; a green dormant suite does not repair those legacy runtime algorithms.

## 9. Independent review priorities and remaining work

Review the wire-byte boundary and every SDK retry, safe account/key ownership, exact replay versus conflict witnesses, SQL definer/default/column privileges, prospective acceptance trust, deferred source/obligation/projection completeness and the account-first lock schedules. Verify that lookup never becomes COMMAND_RESULT and cumulative PI amount never becomes a per-capture amount witness. Review the conservative 23-hour boundary and missing-object recovery restrictions against the intended operating environment.

Independent approval is required before treating this checkpoint as accepted. Runtime installation, real credential/account rights, deployed ACL audit, TLS/provider behavior, broker ACK/mirror sequencing and process-supervisor recovery remain unverified. Historical accounts with NULL mode cannot use this producer; any later configuration path for those accounts needs separate review without retrospective attestation. Nothing here grants permission to install those capabilities or use real credentials.

R2-A still needs the transaction permit, typed operation proof/application and all-writer finalization/disposition guards. R2-B must prove owned pre-lot capture success and exact attributable operation amount without circular dependence on the capture journal/lot, then apply capture atomically. Later refund/dispute/settlement/payout and reviewed recovery gates remain. Do not start capture application or activate scopes from this implementation record.

Author verdict: **READY_FOR_INDEPENDENT_REVIEW**.
