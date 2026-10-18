# H1 Fix 02 — B3.2 B.2-R0.2 conflicting delivery foundation

Status: **READY_FOR_INDEPENDENT_REVIEW — dormant, uncommitted**. Contract recorded before SQL changes, 2026-10-18. No commit, push, R1 adapter, R2 financial application or activation is authorized by this checkpoint.

## 1. Baseline and trust contract

Started on `main`, HEAD `5c8b1e02ba543d641526beab0ba03f7e0cc78283`. The index is empty. Existing uncommitted work is exactly the [post-R0 R1 preflight](h1-fix-02-b3-2-b2-r1-implementation.md) and its documentation-index link; both are preserved. The [earlier R1 preflight](h1-fix-02-b3-2-b2-r1-trusted-receipt.md), all accepted reviews and migrations0000–0007 remain unchanged. The journal ends at index7; this extension is0008.

The confirmed R1 gap is a later financial contradiction for an original validly enrolled as nonfinancial. R0 correctly preserves its immutable original and rejects replacement bytes; its existing review API requires an obligation, while the original nonfinancial enrollment has none. A separate delivery child and independent checked blocker must preserve both histories. [Database design](../database-design.md) remains the current schema owner; this document records the contract and executed evidence.

### Delivery categories, defined before implementation

| Category | Trust/storage and admission requirement |
| --- | --- |
| A: exact repeated attempt | Return the same deterministic attempt identity; no duplicate barrier or revision increment |
| B: equivalent verified event, refreshed signature/transport headers | Retain the distinct verified attempt; same signed JSON event and normalized facts/account mean equivalent retry, no new financial blocker |
| C: independently verified conflicting event/normalization | Retain later bytes/signature/headers/normalization distinctly from the original. Financial relevance requires an immutable review and durable checked barrier |
| D: changed unverified input | Ordinary callers have no publication capability. Future R1 must reject failed SDK verification before SQL; no authoritative blocker from a failed/unverified request |
| E: account conflict | A signed account claim must match its trusted configured publishing context. Reject an untrusted/mismatched context. If both original and later configured contexts are independently trusted but differ, retain both identities, never reassign the original; protect each financially relevant side under its own established authority |
| F: nonfinancial original, verified financial contradiction | Original remains nonfinancial, without an invented original obligation. The later child independently creates its applicable provider-account barrier |

Equivalence compares parsed signed JSON and normalized JSON plus configured account, excluding signature/transport headers and verifier build version. JSON object key order/whitespace do not change facts. A distinct signed event document or normalized document under the same provider event identity is conflicting evidence; it is not silently substituted for the first document. Exact attempt identity includes the full raw bytes, signature, headers, normalization and verifier/account attestation, so separate witnesses are not collapsed. Hashing only indexes that complete identity; conflicting hash contents must reject rather than silently replay.

Only R0's explicit customer lifecycle allowlist with unsupported/null normalization is nonfinancial. Other unsupported/unclassified events remain financially relevant. A contradiction involving pending evidence is a review case; an equivalent pending retry remains Option A neutral and introduces no posted hold.

### Authority and resolution policy

Apply existing H04 independently to each verified financially relevant side. A canonical scope is usable only from the original immutable B.1 proof, validated by its effective reader. The later side may share that scope only when its provider/account/object, amount/currency, provider references and any explicit owner claims agree with that proof. Otherwise that side stays at its configured provider-account barrier. No caller supplies a merchant/currency selector. If one side of an account is unknown, use its account barrier rather than a redundant scoped barrier. A nonfinancial side creates no barrier; different unimplicated accounts remain clear. This applies the existing account/scoped authority, not a global freeze.

H03 local transaction ordering and existing evidence revisions govern reader invalidation. H10 requires trusted reconciliation/no-effect and actor/identity linkage before resolution. R0.2 supplies **no successful conflict-clearance operation**: immutable conflict barriers remain BLOCKING_REVIEW until a separately reviewed forward R2 recovery contract can satisfy that evidence. Notes, legacy statuses, timeout, original obligation completion or an unrelated journal cannot clear them. No fabricated resolution record or financial outcome is introduced.

SQL cannot perform Stripe SDK verification. The only accepted writer is a restricted EXECUTE capability for a future SDK-verifying adapter with server-configured account context. No verified boolean or public table INSERT grants establish authority. Test-only capabilities must be explicit and remain outside production runtime credentials. Fixtures prove SQL permissions/lineage, not HTTP authenticity. No provider network call belongs inside the transaction.

## 2. Storage, transaction and lock contract

Use two additive relations: immutable later delivery attempts and immutable delivery review barriers. Reuse existing financial_evidence_reviews, receipt_intake_authority, capture scope revisions, NOLOGIN admission owner and isolated receipt reader. Preserve the original receipt/admission/proof exactly. No automatic historical delivery/backfill or financial repair.

Guarded publication owns the original private inbox, then all distinct original/later configured account rows in deterministic account order with UPDATE from the start. It freezes any existing original proof revision, derives authority, takes canonical advisory/scope locks in deterministic order, then writes attempt/review/barriers and advances the applicable revisions in one transaction. Never acquire SHARE first then upgrade. It never acquires another operation's inbox after account/scope. Deferred validation requires the exact derived barrier set and matching immutable review before commit. Identical replay returns the first immutable result without advancing revisions again.

Reader-first holds R0 account/scope authority until commit; conflict-first prevents a later reader from clearing before seeing the committed barrier. Both acquisition orders need permanent real PostgreSQL wait tests and committed-state assertions. Existing B.1/R0 entry points retain their private-inbox-first prefix. No financial writer or network operation is added. A future R1 branch must not acknowledge a delivery if atomic conflict retention fails.

## 3. Implemented SQL and storage

[Forward migration0008](../../apps/api/drizzle/0008_conflicting_receipt_deliveries.sql) appends journal index8 after the accepted eight migrations. Drizzle declares the two storage models; SQL owns the executable checks/capabilities.

| Structure/routine | Implemented responsibility |
| --- | --- |
| `receipt_delivery_attempts` (22 columns) | Original inbox FK, original event/account and later configured account, SHA256 complete-attempt key, raw bytes/signature/headers/normalized JSON, normalization1/STRIPE_SDK/verifier version, frozen optional proof revision, derived classification/reason/operation/relevance, review, timestamp and database principal |
| `receipt_delivery_barriers` (11 columns) | Immutable per-delivery derived authority key, provider/account or merchant/currency, matching review, R0 revisions, timestamp and fixed BLOCKING_REVIEW disposition |
| `receipt_delivery_facts(uuid,text,bytea,jsonb,integer)` | Shared source/classification/authority derivation, original R0 validation, configured context and original event-ID validation, signed account-claim agreement, canonical known-scope proof validation |
| `check_receipt_delivery_barriers()` | Deferred row triggers on both INSERT paths rederive source/classification/fingerprint, require the exact immutable review and complete barrier set, and validate authority/revision references |
| `publish_verified_receipt_delivery(uuid,text,bytea,text,jsonb,jsonb,text)` | Restricted atomic publication and replay, deterministic authority locks, review/attempt/barrier insertion and applicable revision advancement |
| `inspect_receipt_admission(text,text,uuid,text,bigint,bigint)` | Replaced in place, preserving R0 signature, owner, grants, isolation/lock/revision checks and original obligation/exception predicates; adds unknown-account and pooled scoped delivery-barrier predicates |

There is no accepted `verified=true` input or caller-provided ownership selector. SQL requires configured account provenance and matching original/raw/normalized event identity. Signature bytes and verifier identity are retained attestations, not database HMAC verification. Unsupported financial evidence is conservative; raw/normalized contradictions cannot borrow the customer allowlist exemption. Later owner/object/amount/currency/reference disagreements widen the implicated account's protection rather than borrow the original sealed scope. A frozen unknown witness is never silently narrowed by subsequent correlation.

Exact-attempt replay compares all fingerprinted arguments before returning the existing row. Changed signature/header witnesses have distinct keys but are EQUIVALENT when parsed event/account/normalization agree. Conflicting witnesses have separate immutable reviews, even on the same original inbox. No mutable mirror, transport ACK or inbox disposition is financial authority.

## 4. Atomicity and admission

Publication acquires the private original inbox and all account authorities before selecting/fixing proof scope. It rereads derived facts after scope locks. Within that transaction it inserts the immutable review and later attempt, advances the unknown account's intake revision or known merchant/currency evidence revision, and inserts the exact required barriers. Cross-account financial evidence may require both a canonical original scope and a later unknown-account barrier; a nonfinancial side does not freeze an unimplicated account.

The attempt and barrier constraint triggers are initially deferred. A parent-only INSERT that returns normally still fails COMMIT; a barrier without its parent/review fails FK validation; an extra barrier or a false EQUIVALENT label fails derivation. Statement failure, deferred failure or explicit rollback leaves no partial attempt/review/barrier or revision change. Forcing all constraints immediate before publication deliberately fails at the parent-before-child point and rolls the complete transaction back. Publication expects the normal deferred contract.

The reader uses the existing R0 account SHARE/advisory/scope authority. A known barrier blocks the pooled merchant/currency even through another configured account. An unknown barrier blocks that provider/account's scopes without guessing merchant ownership; unrelated accounts remain clear. Stored scope/intake clearance revisions become stale when their authority changes. This is the **dormant SQL admission reader**: current legacy settlement/payout services do not call it and are not claimed to be quarantined by this migration.

## 5. Privileges, review and closed resolution

All four new/replaced functions pin `search_path=pg_catalog, pg_temp`; persistent financial relations are explicitly qualified. The derivation helper is INVOKER. The two new definers reuse `fintech_admission_<database hash>`, the existing restricted NOLOGIN owner. It gains SELECT/INSERT on the two new relations, not UPDATE/DELETE/TRUNCATE or ledger writes. PUBLIC function/table rights are revoked; temporary schema CREATE used for ownership transfer is revoked. The existing reader's owner/ACL remain in place. No runtime publisher/worker login, membership or credential changes are introduced. Disposable test roles receive explicit test-only EXECUTE grants.

Normal roles cannot insert accepted witnesses, publish, clear barriers or reset revisions. Existing evidence immutability rejects original receipt/proof/review mutation, and both new relations reject UPDATE/DELETE/TRUNCATE. An authorized adapter capability is the trust boundary: a holder falsely attesting SDK success cannot be authenticated by SQL. The tests explicitly distinguish local SDK fixtures from HTTP ingress verification.

No resolution API or mutable clearance state exists. Legacy RETRY/DEAD/PROCESSED/IGNORED, expired leases, arbitrary review notes, original obligation resolution and elapsed time do not clear a barrier. H10 recovery remains **blocked pending R2**. A later separately reviewed contract must match original plus later delivery identity and configured provenance, authorized actor/audit, and exact trusted reconciliation or verified no-effect evidence; append immutable idempotent resolution history, reject contradictory resolution, advance revisions under authority locks and separately recheck resume admission. This checkpoint creates no purported resolution, no financial outcome and no unrelated journal link.

## 6. Lock and migration compatibility

Publisher order is original private inbox FOR UPDATE → all distinct configured accounts FOR UPDATE in sorted order → canonical advisory/scope NO KEY UPDATE → new review/attempt/barriers and R0 revisions. It does not take account SHARE then upgrade, acquire another inbox after authority locks, mutate provider mirrors/payment/ledger rows or call an external service. A future adapter must not compose this self-locking publisher after an admission reader's SHARE or later financial locks. Correlation sealing remains a separate fresh transaction as required by B.1/R0.

Thirteen permanent controlled schedules identify distinct backend PIDs, observe actual `pg_blocking_pids`, release gates and await all started transactions under bounded timeouts. They cover duplicate publication and both acquisition orders for equivalent/conflict, conflict/reader, conflict/scoped enrollment, same pooled scope through another account, unknown barrier/another known scope, and opposing cross-account publication. Assertions check committed witnesses/barriers/revisions and reader rejection. Deadlock errors are never treated as successful serialization. A separate migration schedule observes FK-DDL waiting on a held referenced-table lock.

Install transactionally with a migration identity possessing the existing function-ownership privileges, after draining receipt writers. New table FK DDL needs referenced-table locks; replacing functions/adding constraints and indexes also holds DDL locks until commit. `lock_timeout=10s` bounds lock waits, not total installation time. A lock timeout/error aborts the install; retry the whole migration after the drain. No historical evidence scan/backfill, monetary rewrite, original reclassification, role provisioning or automatic repair occurs in0008. A deliberately late error rolls back both tables/functions/capability grants and the reader replacement; fingerprints and prior reader ACL/definition survive unchanged. Once live evidence exists, rollback must preserve it and use a reviewed forward change rather than DROP evidence.

## 7. Files and preservation

Task changes:

- `apps/api/drizzle/0008_conflicting_receipt_deliveries.sql`, `apps/api/drizzle/meta/_journal.json`, `apps/api/src/database/schema.ts`.
- New `apps/api/test/integration/receipt-delivery-conflicts.spec.ts` and `receipt-delivery-migration.spec.ts`.
- Latest-chain count/title updates only in `capture-accounting-migration.spec.ts`, `integrated-accounting-verification.spec.ts`, `receipt-admission-migration.spec.ts`, `settlement-accounting-integration.spec.ts` and `trusted-evidence-migration.spec.ts`. Staged historical rollback assertions keep their original migration counts.
- This record plus current-owner updates in `docs/database-design.md`, `docs/concurrency.md`, `docs/verification.md` and navigation in `docs/README.md`.

The pre-existing untracked post-R0 R1 record remains byte-for-byte unchanged, as does the committed earlier R1 record. Hash comparison confirms SQL0000–0007 unchanged; the journal's first eight entries are unchanged. The six original F01 assertions are unchanged. The original navigation, including its pre-existing R1 link, is preserved with one new R0.2 link. All disposable databases, logs, caches, script helpers and generated build output remain ignored. No staging, commit or push was performed; HEAD remains the baseline.

## 8. Executed verification

Local environment: Node24.19.0, pnpm10.26.0, PostgreSQL18.6, isolated localhost port55432. No seed, ingress, provider consumer, scheduler or external provider/broker was started. Migration tests create private disposable databases with administrative fixture authority; SQL publication/management tests switch to restricted non-owner roles. Immutable financial test histories are retained.

Root checks used the installed offline Corepack cache (`COREPACK_HOME=C:/Users/Daniel/AppData/Local/node/corepack`, `COREPACK_ENABLE_NETWORK=0`) and ignored workspace TEMP/TMP. Exact root commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Final lint/typecheck passed, including typecheck sequentially after the successful build. Default tests passed **50 unit tests /12 suites**, skipping559 database opt-ins; those were all executed separately as553 green plus6 expected red. API/web builds passed on the permitted retry after the initial Next output creation failed with sandbox EPERM.

PostgreSQL commands below run from `apps/api`; `MIGRATION_ADMIN_URL` points only to the local disposable cluster, `DATABASE_URL` to the newly migrated unseeded test database, and TEMP/TMP to `../../.tmp/b1-independent-temp`:

```powershell
$env:RUN_DB_TESTS='1'
$env:RUN_MIGRATION_TESTS='1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/receipt-delivery-conflicts.spec.ts test/integration/receipt-delivery-migration.spec.ts --cacheDirectory ../../.tmp/jest-r02 --json --outputFile ../../.tmp/r02-targeted-final.json
node node_modules/jest/bin/jest.js --runInBand test/integration --testPathIgnorePatterns settlement-f01.pending --cacheDirectory ../../.tmp/jest-r02 --json --outputFile ../../.tmp/r02-accepted-pg.json
$env:RUN_F01_PENDING='1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-r02 --json --outputFile ../../.tmp/r02-f01.json
```

| Permanent PostgreSQL suite | Final result |
| --- | --- |
| R0.2 delivery / migration | 56 +6 passed |
| R0 admission / corrective review / migration | 50 +31 +6 passed |
| B.1 trusted evidence / migration | 64 +6 passed |
| Capture / allocation foundation / foundation migration | 27 +30 +5 passed |
| Refund / dispute / settlement / integrated lifecycle | 63 +70 +73 +44 passed |
| F02 / existing financial concurrency | 17 +5 passed |
| **Green total** | **553 passed /16 suites /0 skipped** |
| Original opt-in F01 | **6 failed /0 skipped**, expected financial mismatches; F01 remains unresolved |

New coverage includes nonfinancial original replay and financial contradiction, equivalent refreshed signatures/headers, raw whitespace, normalization disagreements, canonical versus unknown ownership, wrong owner/object/amount/currency/references, trusted cross-account evidence, distinct/repeated conflicts, rollback, missing/extra barriers at commit, false classification, stale scope/intake revisions, immutable history, restricted capabilities, no clearance by statuses/notes, frozen unknown proof, Option A neutrality and all controlled lock orders. Existing R0.1 contradictory-refund regressions pass unchanged. Fresh nine-migration installation/repeat, populated0007 upgrade, preserved sixteen-table evidence fingerprints, late transactional rollback, expected DDL wait and capability/gate checks pass.

The initial targeted run passed50/51: its TRUNCATE assertion hit the FK guard before the immutability guard. The permanent test now uses cascading TRUNCATE to reach the rejecting immutable trigger; no history was deleted. The initial full run passed552/553: one existing DDL test expected8 installed migrations; only that current-chain assertion changed to9, and the complete final matrix passed on a fresh database. The F01 test names, failure statuses and financial mismatch messages match the retained post-R0 baseline. An initial F01 execution request was not executed when automatic approval review hit a usage limit; after the user requested continuation, the same approval path executed it successfully. No verification bypass was used.

Final read-only catalog/hash checks confirm nine applied migrations with the exact0008 source hash, Drizzle column/nullability parity (22/11 columns), pinned paths/no PUBLIC execution, zero ACTIVE scopes, all configured accounts UNINSTALLED, and refund/dispute evidence versions still0. Historical SQL and R1 records match initial hashes. The documentation/link/YAML validator and `git diff --check` are run at final handoff; their exact final counts are recorded in [Verification](../verification.md). Mermaid blocks are extracted by that validator; parser/render execution is not claimed for this run.

## 9. Remaining R1/R2 work and independent review gate

R1 is **not resumed**. Its future adapter must independently SDK-verify every later raw delivery outside lock-held transactions with the correct server-owned account secret/context; normalize with the declared version, identify the original immutable inbox, distinguish exact/equivalent/conflicting witnesses, and invoke only the restricted atomic branch. A failed original publisher must roll back before a fresh conflict-publication transaction. Retention failure must not be acknowledged as handled. Successful SQL fixtures do not establish signed HTTP behavior, credential separation, live Stripe authenticity or safe application routing. D02 command-result trust and old-worker fencing remain separate integration gates.

R2 still owns evidence-backed conflict recovery, full application/disposition linkage, coordinated writer admission, safe reconciliation/resume and activation prerequisites. No scope becomes ACTIVE, no policy default changes, and legacy financial writers/readers remain unchanged. This foundation does not fix legacy F01/F04 or certify financial cutover.

Independent review should prioritize complete-attempt identity versus semantic equivalence; raw/normalized cross-account and canonical-scope derivation; exact deferred barrier/review enforcement; reused owner privileges and pinned function context; both lock orders including pooled scope; reader revision invalidation; closed recovery; and transactional upgrade/rollback. No reviewer acceptance is claimed by this implementation report.

**NOT RUN:** hosted R0.2 CI/PostgreSQL17, signed HTTP adapter verification, real Stripe, RabbitMQ/Redis, mixed-version/old-worker fencing, live settlement/payout admission or R2 recovery. Earlier R0 hosted success remains historical evidence for that commit only. PostgreSQL test histories are preserved and the local cluster is returned to its initial stopped state at handoff.
