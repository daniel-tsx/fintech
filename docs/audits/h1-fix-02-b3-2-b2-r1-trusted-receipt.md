# H1 Fix 02 — B3.2 B.2-R1 trusted receipt preflight

Status: **BLOCKED_BY_TRUST_OR_ADMISSION_CONTRACT**. Inspected 2026-10-18. No receipt adapter, migration or runtime integration was implemented.

This record documents the request's section 7 stop condition: the installed B.1 foundation cannot express the required receipt-admission lifecycle without a reviewed forward migration. It does not withdraw [B.1's dormant acceptance](h1-fix-02-b3-2-b1-independent-review.md), change the [approved decisions](h1-fix-02-b3-2-human-decisions.md), or replace the [current database owner](../database-design.md).

## 1. Baseline and prerequisites

Started on clean `main` at `cdbad57ccaab9edf83aa5fdf4d18e5c30b4f7514`, synchronized with the local `origin/main` tracking ref. The index was empty. That commit contains migration 0006, the B.1 implementation, its permanent regressions and its independent review. No B.1 source or historical migration was changed in this run.

Started the existing disposable PostgreSQL18.6 cluster at `127.0.0.1:55432` and inspected `fintech_b1_independent_1792297129106`. Its migration catalog has seven entries; the last is timestamp `1792281600000`, the committed 0006 journal entry. Both B.1 sealer and reader signatures exist. The catalog confirms the receipt, proof, review, scope and account columns described below. No migration or test data write was performed.

## 2. Confirmed admission gap

The [approved receipt protocol](h1-fix-02-b3-2-runtime-cutover-design.md#5-webhook-receipt-and-correlation-protocol) requires a durable receipt-linked blocker, known or unresolved ownership, guarded resolution/application linkage and a scope evidence revision. Receipt-first and reader-first must serialize on the same intake/advisory/scope authority. Blocking status must survive retry, DEAD, unsupported normalization and delayed application.

The installed schema supplies different, deliberately narrower structures:

| Installed structure | Verified boundary |
| --- | --- |
| `financial_evidence_accounts` | Provider/account key, immutable UNINSTALLED state and creation time; usable as a lock target, but no receipt obligation state |
| `provider_financial_receipts` | Immutable signed bytes, signature, headers, normalized snapshot and verifier provenance; no known scope or admission lifecycle |
| `webhook_financial_evidence` | Immutable confirmed refund/dispute ownership proof; no pending/unknown marker, current clearance or application disposition |
| `financial_evidence_reviews` | Immutable inbox/review-key/reason/observations; no checked scope/account lifecycle or guarded resolution linkage |
| `capture_accounting_scopes` | Merchant/currency, FOUNDATION_ONLY or REVIEW_REQUIRED, creation time; no `evidence_revision` |
| `webhook_events` | Legacy mutable status/attempts/lease; current worker can process, ignore or dead-letter without the proposed admission contract |

See [0006](../../apps/api/drizzle/0006_trusted_financial_evidence.sql) and [0004](../../apps/api/drizzle/0004_capture_accounting_foundation.sql). In 0006 all six new relations reject UPDATE/DELETE/TRUNCATE. Unresolved and contradictory reviews are evidence, not an implemented admission state machine. An arbitrary JSON convention in `observations` would introduce an application-only interpretation rather than the requested checked contract. Using legacy inbox status as clearance would let unrelated legacy processing change that interpretation.

This is an expected staged-schema limitation, not a newly discovered defect in the accepted dormant checkpoint. The [B.1 review's mandatory dependencies](h1-fix-02-b3-2-b1-independent-review.md#12-mandatory-b2-dependencies) explicitly defer current intake/scope policy, blockers and financial application linkage.

## 3. Required forward contract for review

Before implementing this complete R1 request, review a receipt-only forward migration after 0006. No migration is supplied or authorized by this report. The smallest contract to settle is:

1. **Receipt admission identity:** durable metadata keyed by the original inbox UUID, with owned receipt/provider/account references; explicit financial relevance and pending/confirmed/unsupported classification. Known merchant/currency must have checked canonical ownership; unresolved ownership has no invented scope. A sealed proof reference, when present, must identify the exact owned inbox/revision tuple.
2. **Durable blocker lifecycle:** enforce known-unapplied, unresolved and contradictory obligations independently of legacy inbox status. Define checked transitions and append-linked reasons/provenance. Mapping an unknown obligation to a known scope must atomically remove the broad obligation and retain its scoped successor. No timeout, arbitrary review note, proof existence alone or legacy PROCESSED/IGNORED mark may clear it. Financial application/no-effect clearance remains closed until R2.
3. **Scope evidence revision:** add a guarded nonnegative monotonic revision to the existing scope authority, advancing atomically on relevant receipt admission/mapping/review transitions. Do not add ACTIVE or relax the existing financial gates. Policy/admission epochs and activation certificates remain coordinated R2 work.
4. **Database-owned admission operations and predicates:** validate the actual stored receipt/proof/owned references under READ COMMITTED after the approved locks. Enforce uniqueness, ownership, transition permissions and immutable history in SQL; expose the same blocker predicates to an isolated admission-aware reader. Pin function paths, qualify persistent references and review restricted publisher/correlator rights. Default grants or an owner-pool fixture are insufficient evidence of runtime privilege separation.
5. **Sealer composition:** retain the B.1 sealer as an entry point in a separate correlation transaction, before its lock prefix, then guardedly link the admitted obligation. Review every replay/mapping branch. Alternatively review a coordinated forward routine change. Do not call the existing self-locking sealer after intake SHARE or scope locks.

These are required contracts, not approved enum names, executable DDL or authorization to widen financial behavior. Migration review must cover populated 0006 upgrade, unchanged original evidence, failure rollback, lock duration and both receipt/reader acquisition orders. Existing financial reference CHECKs, version0 compatibility, UNINSTALLED and the absence of ACTIVE must remain closed during receipt-only staging.

## 4. Lock order and composition evidence

The approved known-scope receipt order is private inbox → account intake SHARE → canonical merchant/currency advisory lock → scope → authoritative revalidation and marker/revision writes. Unknown ownership selects account intake UPDATE before later locks. Resolution must not upgrade SHARE after acquiring a scope or lock another operation's inbox after financial locks. No provider request belongs inside those transactions.

The existing 0006 publisher trigger locks its private inbox, advances its row version with a same-value timestamp write, then takes account SHARE. The existing sealer locks private inbox → account UPDATE → advisory/scope → payment NO KEY UPDATE → ordered children/lots/allocations → immutable owner/proof. It revalidates ownership and does not create an admission marker or scope revision. Its replay branch returns the existing SQL projection without acquiring the later scope/child prefix.

Consequently, merely adding an adapter around these routines would not implement the receipt-side protocol. In particular, publication followed by sealing after SHARE/scope acquisition is not an accepted composition. The approved separate correlation transaction is available as a design option; no new deadlock experiment or universal lock-safety claim was made here.

## 5. Trusted receipt, ownership and original payload

The existing [receiver](../../apps/api/src/webhooks/webhook-receiver.service.ts) verifies exact request bytes with Stripe SDK `constructEvent`, normalizes and inserts the legacy inbox; a duplicate returns the original ID. It does not retain the raw body in B.1 receipt storage or publish B.1 attestation. Its conflict branch does not implement the requested contradictory-delivery evidence lifecycle. The controller/module remain unchanged.

The [normalizer](../../apps/api/src/webhooks/stripe-event.normalizer.ts) retains capture/refund/dispute outcomes under its current mapping. Pending refunds become `provider.unsupported` with NULL normalized data. Future R1 classification must preserve the signed original and distinguish an unknown financial outcome from an irrelevant event; attaching a proof cannot manufacture confirmation. B.1's shared proof contract supports confirmed refund/dispute operations, not capture proof sealing. Retaining a capture receipt must not be misreported as a new capture proof/application path.

The SQL sealer derives refund identity from accepted refund/command/key and frozen capture evidence, requiring an exact trusted command-result witness when refund metadata is absent. Disputes use owned capture provenance without an invented dispute command. Mutable mirrors alone are insufficient. The [command handler](../../apps/api/src/payment-commands/payment-command-handler.service.ts) currently stores mutable provider results, not these immutable observations. The existing B.1 fixture publishers do not establish a real receiver/result producer. Missing prerequisites must remain unresolved and retryable; explicit contradictions must remain reviewable. None of those runtime adapters was added here.

`load_effective_financial_evidence` remains the authoritative immutable ownership projection. A truthful sealed proof is not current admission or permission to post money. Original payloads, signed bytes already retained by B.1, provider references, mirrors and financial history remain unchanged.

## 6. Known/unknown admission and R2 gates

**Neither requested receipt-admission path was implemented.** Existing evidence rows can be stored and SQL-sealed under their B.1 contract, but this does not supply known-scope pending admission or an operational account-wide unresolved barrier. Current legacy settlement/payout behavior remains unchanged and is not described as quarantined.

R2 still requires protected historical-era/default1/no-downgrade enforcement before any new-policy intent or financial application; coordinated SQL reader adapters and bidirectional effect/workflow/audit/inbox linkage; claim/disposition fencing; current policy/epochs/permits; trusted non-inbox obligation publication and linkage; coordinated writers and operational old-worker fencing. R1 must not authorize new financial effects through version0 or a proof-free fallback. F01/F04/F05/F06 remain open.

## 7. Executed verification

Executed from the repository root:

```powershell
git -c safe.directory='C:/Work/Learning Projects/learn-fintech' status --short --branch
git -c safe.directory='C:/Work/Learning Projects/learn-fintech' log -1 --format='%H %s'
& 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' status -D '.tmp/verification-pg18'
& 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' start -D '.tmp/verification-pg18' -l '.tmp/b2-r1-preflight-postgres.log' -o '-p 55432 -h 127.0.0.1' -w
```

Initial status confirmed the stopped disposable cluster. Start exited0. A read-only Node `postgres` client, loaded from the API's installed dependency, queried the database named by `.tmp/b1-independent-db.txt`. It checked `drizzle.__drizzle_migrations`, `information_schema.columns`, `pg_constraint`/`pg_get_constraintdef`, the two `to_regprocedure` signatures, and counts from scopes/accounts/receipts/proofs. No private environment file or provider credentials were loaded. Results:

| Check | Result |
| --- | --- |
| Migrations | 7; last timestamp1792281600000 |
| Sealer/reader | Both present with committed signatures |
| Scope CHECK | Only FOUNDATION_ONLY / REVIEW_REQUIRED |
| Account CHECK | Only UNINSTALLED |
| ACTIVE scopes / enabled accounts | **0 / 0** in the inspected verification database |
| Receipts / proofs | 0 / 0 in that database; no rows manufactured for preflight |
| Admission columns | Missing lifecycle/scope revision confirmed against actual catalog |

Final commands:

```powershell
node .tmp/validate-docs.cjs
git -c safe.directory='C:/Work/Learning Projects/learn-fintech' diff --check
git -c safe.directory='C:/Work/Learning Projects/learn-fintech' diff -- docs/README.md
git -c safe.directory='C:/Work/Learning Projects/learn-fintech' diff --cached --name-only
& 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' stop -D '.tmp/verification-pg18' -m fast -w
& 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' status -D '.tmp/verification-pg18'
```

Documentation validation passed: **41 Markdown files, 527 relative links/anchors**, CI YAML parsing/structure, no errors. It extracted19 existing Mermaid blocks; no diagram parser/rendering was run. `git diff --check` passed. Manual diff and a Node inventory/newline/whitespace assertion verified exactly the two documentation deliverables and an empty index; source, migration and F01 test files are unchanged. Stop exited0; final status reported no server running (the expected status exit1). Retained histories were not removed.

Existing B.1 review records 404 green PostgreSQL cases, 50 unit passes and six expected F01 failures; those are **historical results, not reruns in R1**.

**NOT RUN in this stopped implementation:** lint, typecheck, unit tests, build, new signed HTTP tests, correlation/admission schedules or full financial PostgreSQL suites. No R1 code exists to exercise. No broker/worker, live Stripe, hosted CI, PostgreSQL17, shared/production database or credential/session verification occurred. The six F01 tests are unchanged and remain tracked; they were not rerun here.

## 8. Changed files, disposition and independent review priorities

Changed only this preflight record and its documentation-index link. No migration, dependency, source service, module registration, normalizer, financial test or financial writer changed. No commit or push was performed. The initial stopped cluster state is restored without deleting retained histories.

The requested checkpoint is **not ready for implementation acceptance or independent code review**. The next review should settle the receipt-only DDL and lock composition in section3, then authorize implementation with permanent signed HTTP, ownership, rollback and both-order PostgreSQL receipt/reader schedules. Full R2 dispatch/application, scope activation and B.3 remain out of scope.
