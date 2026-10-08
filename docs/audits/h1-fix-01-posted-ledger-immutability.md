# H1 Fix 01: posted ledger immutability

Status: current. Owner: F02 implementation and verification evidence. Date: 2026-10-07.

Current behavior is owned by [Ledger](../ledger.md), [Database design](../database-design.md) and [Concurrency](../concurrency.md). This record follows [F02 in the historical H1 audit](h1-financial-correctness.md#f02--posted-journals-are-not-sealed-against-inserts); it does not replace those documents. No other H1 finding is addressed here.

## Original finding and reproduction

A POSTED journal could accept a balanced pair of new entries. In the durable [regression suite](../../apps/api/test/integration/posted-ledger-immutability.spec.ts), a posted debit/credit total of `100/100` became `150/150`, with four entries instead of two. Its business reference did not change.

The qualified audit race also reproduced: session A marked a balanced draft POSTED, executed `SET CONSTRAINTS ALL IMMEDIATE` and paused. Session B inserted an unbalanced debit while seeing the committed parent as DRAFT and committed. A then committed, leaving POSTED totals `200/100`. LedgerService does not issue that SET command; the regression deliberately exercises the direct-SQL database guarantee.

An additional F02 regression established a stale repeatable-read snapshot: A took its snapshot, B committed an unbalanced draft entry, then A posted using its earlier view. Before the fix, A committed and the journal was durably `200/100`.

The first 13 tests ran before the migration: **three failed, ten passed**. Existing entry/header UPDATE/DELETE rejection, normal DRAFT construction and separate correction journals already worked. Two subsequent rollback-only tests also failed before the fix because TRUNCATE was accepted. Their explicit fallback exception rolled back the truncation, preserving test history.

## Root cause and invariant

The original `ledger_entries_immutable` trigger covered only UPDATE/DELETE. It did not seal entry INSERT. The deferred balance function read the parent and entries without serializing against concurrent construction. A completed immediate check could have no pending check left at commit; a repeatable-read transaction could retain a stale entry snapshot. TRUNCATE bypassed both row mutation and deferred balance triggers entirely.

The invariant is now: build entries while the journal is DRAFT; transition to POSTED only if the existing deferred checks succeed; then preserve the header and entry set. No later entry INSERT/UPDATE/DELETE, header UPDATE/DELETE or ledger-table TRUNCATE may change that evidence. Corrections require a new journal.

## Database mechanism

[Forward migration 0002](../../apps/api/drizzle/0002_seal_posted_ledger.sql) adds `ledger_entries_draft_insert`, a BEFORE INSERT trigger. It executes a same-value UPDATE on the parent **only if its status is DRAFT**. No matching draft means the insertion raises `Ledger entries can only be inserted into DRAFT transactions; post a compensating journal`.

This UPDATE acquires the same parent write lock as posting and creates a new row version. If posting commits first, a waiting insert rechecks the parent and rejects. If construction commits first, posting validates the resulting entries, or a stale repeatable-read writer receives serialization error `40001`. Merely taking `SELECT FOR UPDATE` would serialize overlapping writers but would not create the row version needed to invalidate the independently established entry snapshot. PostgreSQL documents the relevant [locking](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS) and [snapshot/update behavior](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-REPEATABLE-READ).

Existing deferred exact balance/currency checks, immutable UPDATE/DELETE triggers, account uniqueness, journal business uniqueness, audit protection and webhook protection remain unchanged. Two BEFORE TRUNCATE statement triggers reject truncation of ledger entries and transaction headers. The PostgreSQL mechanism works for direct SQL as well as LedgerService.

In the audit's posting-first race, the fixed insert waits and then rejects **during INSERT, before it can commit**; the valid posting succeeds. This is stronger than allowing an unsafe insert and detecting it at commit. A separate regression proves deferred commit rejection when an unbalanced draft entry commits first. No successful transaction leaves the journal posted and unbalanced in these schedules.

## Compatibility and migration considerations

- Historical migrations `0000` and `0001` are preserved. Forward migrations `0002_seal_posted_ledger.sql` and `0003_pin_ledger_function_context.sql` add sealing and the defensive function-context follow-up, with their Drizzle migration-journal entries. No migration regeneration, schema push, column redesign or dependency installation was used.
- Installation takes `SHARE ROW EXCLUSIVE` locks on ledger headers/entries and checks all existing POSTED journals with exact SQL sums and the existing journal/entry currency rules. Invalid history causes migration failure; it is never silently rewritten. The Drizzle migrator executes this in a transaction, so failed preflight does not register the migration or install a partial trigger set.
- Apply through the repository migrator in a controlled maintenance window: the preflight scan/DDL blocks competing writes while permitting ordinary reads. Existing corruption needs a separate reviewed recovery decision. A new compensating journal alone does not make an already unbalanced original journal satisfy the preflight.
- [schema.ts](../../apps/api/src/database/schema.ts) documents the SQL-owned guarantees. Drizzle table definitions do not represent the trigger protocol; no structural schema snapshot was regenerated for this trigger-only migration.
- LedgerService already builds DRAFT → entries → POSTED atomically and required no implementation change. The existing deferred-rejection test now follows that sequence rather than inserting a POSTED header before its entries.
- [The seed](../../apps/api/src/database/seed.ts) previously inserted a POSTED header before entries. It now constructs a new draft, inserts the fixture entries and posts it in the same transaction. On reseed it skips entry construction when the journal already exists, because BEFORE INSERT also runs before `ON CONFLICT DO NOTHING` can skip an existing entry.
- The existing `reversal_of_id` foreign key still permits a new balanced correction journal pointing to the original. Its rows and the original remain separate. No general reversal API, automatic amount inversion or new reversal product behavior was introduced.

## Regression coverage

The original sealing suite contains 15 tests; the defensive follow-up below adds two function-context cases, for 17 total:

| Case | Established protection |
| --- | --- |
| A: balanced append to POSTED | INSERT rejected; original two entries/totals unchanged |
| B: posting, immediate check, concurrent append | Writer waits or finishes; after posting it must reject; no unbalanced POSTED result |
| Draft append committed first | Posting reaches the transaction callback's end, then fails the deferred commit check |
| Stale repeatable-read posting snapshot | Concurrent entry construction changes parent version; posting rejects with `40001` |
| C: entry UPDATE and DELETE | Both reject and preserve original totals |
| Header description/status/delete | All three reject, including reopening a POSTED journal as DRAFT |
| Ledger entries/header TRUNCATE | Both reject; rollback fallback protects history on the old schema |
| D: atomic direct SQL construction | Balanced DRAFT → entries → POSTED commits |
| LedgerService and replay | Normal service posting commits; identical business reference returns the original without extra entries |
| Mixed entry currencies | Existing deferred currency check still rejects |
| Correction journal | New balanced journal references original; original unchanged; merchant net returns to zero |

Concurrency tests use explicit gates and PostgreSQL blocker inspection rather than assuming a sleep proves a race. Fixtures use UUIDs and are retained in disposable databases; no production or shared financial history is touched.

## Verification evidence

Windows, Node `24.19.0`, pnpm `10.26.0`, local PostgreSQL `18.6`. The configured CI service is PostgreSQL 17; no hosted CI run or PostgreSQL 17 container is claimed.

Before-fix evidence used `fintech_h1_fix01_before`, migrated with only the two original migrations. The final chain was applied from empty to `fintech_h1_fix01_fresh`. A separate `fintech_h1_fix01_upgrade_final` was prepared with the original migrations and a balanced fixture before applying 0002. All databases used the isolated local cluster at `127.0.0.1:55432`; no external workers, Stripe calls or RabbitMQ calls ran.

The isolated cluster was stopped after verification. Disposable fixtures and temporary verification helpers remain locally under ignored `.tmp/`.

| Command/check | Result |
| --- | --- |
| New F02 regressions before fix | Expected failures: posted balanced append, qualified concurrent race, stale repeatable-read posting; ten existing protections passed |
| Rollback-only TRUNCATE regressions before fix | Two expected failures: SQL accepted truncation; fallback rolled it back |
| `pnpm db:migrate`, final empty database | Passed all three migrations |
| Forward migration over existing balanced fixture | Passed; original posted fixture retained |
| Forward migration over corrupted baseline | Expected refusal: `Existing POSTED ledger transactions must be balanced in one currency before sealing migration`; no history rewrite |
| `pnpm lint` | Passed after replacing five unsafe Jest matcher assignments in the new tests |
| `pnpm typecheck` | Passed, API and web |
| `pnpm test` | 11 unit suites / 34 tests passed; two database suites / 20 tests skipped without opt-in; web has no automated browser suite |
| `pnpm build` | Nest and Next production builds passed |
| `RUN_DB_TESTS=1 pnpm --filter @fintech-lab/api test:integration --runTestsByPath test/integration/posted-ledger-immutability.spec.ts` | 15/15 passed on the final upgraded existing-ledger database |
| `RUN_DB_TESTS=1 pnpm --filter @fintech-lab/api test:integration` | Two suites / 20 tests passed on the final fresh migrated database, without seed |
| Seed/reseed and catalog inspection | Balanced three-entry fixture retained after upgrade/reseed; valid databases have three registered migrations, all original ledger triggers plus three new triggers, and zero invalid POSTED journals. Refused baseline retains two migrations/two intentionally invalid posted journals and no partial sealing trigger |
| Documentation links and whitespace | Local link/anchor and CI-YAML validation passed; `git diff --check` and direct untracked-file whitespace checks passed. Existing Mermaid sources unchanged; no re-render claimed |

Initial Windows quoted `set` assignments did not reach the child process as intended: migration attempts hit refused localhost:5432 and the test suite skipped. Unquoted assignments set the intended disposable database and `RUN_DB_TESTS=1`; the reruns produced the actual failing baseline and passing fixed evidence above. No external database was reached. Expected mock broker/provider error logs during unit tests were not test failures.

An untracked-file check initially treated Git's no-index difference exit code as a whitespace error. Git emitted only its LF/CRLF advisory; direct line checks then verified those files for trailing whitespace, final newline and blank lines at EOF. No unrelated line-ending normalization was performed.

## Defensive function-context review, 2026-10-08

The retained balance function used unqualified `ledger_transactions`, `ledger_entries` and `ledger_status` references, and the ledger functions had no fixed search path. Correctness-critical object resolution therefore depended on session configuration. Ordinary functional tests with `SET LOCAL search_path=pg_catalog` established this dependency: both new cases failed before hardening with `type "ledger_status" does not exist` rather than performing the intended balance check.

[Forward migration 0003](../../apps/api/drizzle/0003_pin_ledger_function_context.sql) qualifies the persistent tables/type and replaces the balance function in place. All four ledger trigger functions use `SECURITY INVOKER` and `search_path=pg_catalog, pg_temp`; balance validation remains VOLATILE. Existing function identities, owners, execution grants and trigger bindings are preserved. No definer privileges or database-role redesign is introduced. Invoker writers still need the ledger SELECT/INSERT and parent UPDATE privileges required by the existing sealing protocol. PostgreSQL documents [function replacement, execution context and configuration](https://www.postgresql.org/docs/17/sql-createfunction.html).

The migration rechecks existing POSTED history before replacing functions. It runs transactionally with header/entry `SHARE ROW EXCLUSIVE` locks. Drain financial writers first: ordinary reads can continue, but writers wait while the scan and replacement run. Table locks are acquired header then entry; direct entry writers can begin with an entry-table lock, so maintenance must not assume unrestricted concurrent writes. Retry an aborted migration as a whole. Historical migrations 0000–0002 are unchanged, and no history is rewritten or repaired.

Lock review found LedgerService inserts its own DRAFT header, resolves accounts, inserts entries (updating that parent), then posts it. Its business-reference conflict branch adds no entries. Capture locks attempt/payment before posting; refund completion locks refund/payment; settlement completion locks settlement; payout completion locks payout; payout reservation takes its advisory lock. Dispute open locks payment before its new journal, while dispute close locks dispute, posts its own new journal, then locks payment. A separate correction journal holds a foreign-key reference to the original and constructs its own parent. No new shared-parent inversion was found in these callers; arbitrary multi-journal SQL writers still require consistent ordering.

The same-value parent UPDATE fires the existing immutable-header and deferred balance triggers. DRAFT is allowed by the former, and the latter queues validation. Ledger headers have no updated timestamp/version column, and no header trigger emits audit/change records. The intended physical row version changes; no application-level timestamp or ORM update hook is introduced.

Interrupted review helpers were identified as ignored `.tmp/h1-fix01-review.cjs`, `.tmp/h1-fix01-review-locks.cjs` and their result JSON files. They remain dormant and were not rerun during this continuation. New verification used ordinary integration tests and `.tmp/h1-fix01-hardening-verify.cjs` for catalog/history comparisons; no new bypass scenario or access-control experiment was constructed.

Verification used the same isolated PostgreSQL 18.6 cluster and new disposable databases `fintech_h1_fix01_hardened_fresh`, `fintech_h1_fix01_hardened_upgrade` and `fintech_h1_fix01_hardened_invalid`. The last reused retained invalid history solely to check migration refusal.

| Check | Result |
| --- | --- |
| Two ordinary session-context cases before 0003 | Expected failures resolving the unqualified enum |
| `pnpm db:migrate`, empty database | All four migrations passed |
| `pnpm db:migrate`, valid existing database | 0003 passed; ledger row fingerprints, function OIDs/owners/grants and trigger OIDs/bindings unchanged |
| `pnpm db:migrate`, retained invalid history | Expected refusal before function replacement; still three registered migrations and no partially pinned functions |
| PostgreSQL integration, fresh without seed | Two suites / 22 tests passed |
| F02 integration, upgraded database | All 17 passed, including the original 15 cases |
| `pnpm lint`, `pnpm typecheck`, `pnpm test` | Passed; 34 unit tests passed and 22 opt-in database cases skipped in default tests |
| `pnpm build` | API/web passed after retrying sandbox output-directory `EPERM` with permitted filesystem access |
| Documentation and whitespace | 28 Markdown files / 225 relative links and anchors passed; CI YAML structure passed. `git diff --check` and checks of all five untracked deliverables passed; unchanged Mermaid sources were not re-rendered |

The catalog helper's first comparison rejected the driver's Array subclass against a JSON Array. Normalizing only that helper's result container fixed the comparison; the actual catalog/history checks then passed. No product change was needed for that harness issue.

## Remaining limitations and scope

F01 settlement/refund/dispute allocation and F04 payout/refund admission remain untouched and open, as do money representation, currency/account semantics, capture-state and general Stripe/RabbitMQ findings. Sealing header/entry rows does not freeze account metadata (F09). No general reversal API or financial repair was added.

Administrators able to disable/drop triggers or alter/drop tables can bypass database protections; this change is not a database-role/security audit. The same-value parent UPDATE adds per-entry row versions and serializes construction within one journal. Long transactions or inconsistent multi-journal lock order can block or deadlock; rollback/whole-transaction retry preserves correctness. Not every concurrency schedule or higher-isolation interaction was exhaustively tested.

The F02 implementation and defensive review are complete, with no known unresolved correctness finding in this scope. Commit identity is recorded in Git history. No push, deployment, production migration or real payment occurred. Remaining audit findings require separate authorized fix runs.
