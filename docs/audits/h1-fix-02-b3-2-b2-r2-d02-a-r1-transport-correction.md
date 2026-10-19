# H1 Fix 02 — B3.2 B.2-R2 D02-A R1: native transport evidence correction

Status: dormant correction, **2026-10-19**, awaiting independent re-review. The original [D02-A independent review](h1-fix-02-b3-2-b2-r2-d02-a-independent-review.md) and its **REQUEST_CHANGES** verdict remain unchanged. This record corrects the transport claim in the [original implementation report](h1-fix-02-b3-2-b2-r2-d02-a-provider-observations.md); it does not rewrite that report or certify the checkpoint as independently accepted.

## 1. Starting state and authorized scope

HEAD **e38d30c851486c23ea4dfe09c48d65884b029b65**, branch main, empty index. The worktree started with **21 uncommitted deliverables**: the original18 D02-A files, two reviewer-owned regression suites and the independent review. The complete tracked diff and all untracked source, SQL, tests and review records were inspected. A starting byte-hash inventory covers242 tracked/untracked files; existing ignored database markers were saved separately.

Authority remains [H01–H12](h1-fix-02-b3-2-human-decisions.md), [approved R2 design §§3–4](h1-fix-02-b3-2-b2-r2-financial-application-design.md), [independent design review §3](h1-fix-02-b3-2-b2-r2-design-review.md#3-d02-provider-observation-assessment), and the specific D02-A-R01 correction request. No commit, push, runtime registration, credential grant, scope activation, capture application or other financial implementation is authorized or performed.

## 2. Reproduced P1 before editing source

Ran the unchanged [four-case reviewer native transport suite](../../apps/api/test/integration/provider-observation-review.spec.ts) using disposable PostgreSQL and the installed Stripe Node transport. Result: **3 passed, 1 failed, 0 skipped**,19.419s. The exact failing assertion at line79 was:

```typescript
expect(stored[0]).toEqual({ response_body: raw, body_completeness: 'COMPLETE', http_status: 503 });
```

The fixture sent an actual Node `IncomingMessage` with a complete73-byte HTTP503 error body, then a valid HTTP200 response. Only native `https.request` was intercepted; both Stripe NodeHttpClient/NodeHttpClientResponse classes and RequestSender ran unchanged. No Stripe endpoint was contacted.

Read-only SQL inspection confirmed the committed state in retained database `fintech_r1_signed_9dcf4c74fbf34bb1bcbfcb031c16a1f9`:

| Attempt | HTTP / request ID | Stored bytes / completeness | SQL interpretation / obligation |
| --- | --- | --- | --- |
| execution `697d892e-d27f-4f9c-9512-ca011464c3cc`, key suffix1 | 503 / req_review_1 | NULL / ABSENT, despite73 bytes provided | UNKNOWN_OUTCOME / OUTCOME_UNCONFIRMED / AWAITING_CONFIRMATION |
| same execution, key suffix2 | 200 / req_review_2 | 472 / COMPLETE | RETURNED_OBJECT / CONFIRMED_PROVIDER_RESULT / AWAITING_APPLICATION |

There were two committed sources and two obligations, with scope/intake revisions1 then2 and only one protected result projection. The P1 is lost available evidence; the intermediate error did not incorrectly finalize money. The original author retry assertion only counted attempts and compared keys/dispositions, so it missed this defect.

## 3. Root cause in the installed SDK

Installed and lockfile-resolved **stripe-node22.6.2**. Inspected its actual `cjs/RequestSender.js`, `cjs/net/NodeHttpClient.js`, `cjs/net/HttpClient.js` and public type declarations. Package/lockfile and installed SDK source are unchanged.

RequestSender `_request` calls the configured public HTTP client's `makeRequest`. When that promise resolves, `_shouldRetry` examines status/headers **before** choosing JSON handling. A retryable503 never reaches `toJSON`. The original D02 wrapper created a response object whose only byte read occurred lazily in `toJSON`, leaving the intermediate body's exchange at its initial NULL/ABSENT values.

The original native NodeHttpClient resolves when headers arrive, returning a NodeHttpClientResponse. Its supported `toStream` exposes the original `IncomingMessage`; its ordinary `toJSON` consumes and parses that stream. A returned Stripe object or a later JSON serialization cannot recover the skipped original bytes. The public custom-client contract supports retaining the stream at the earlier boundary without patching RequestSender. The corresponding [pinned SDK source](https://github.com/stripe/stripe-node/blob/v22.6.2/src/RequestSender.ts) and [supported client customization](https://github.com/stripe/stripe-node) describe the same boundary.

## 4. Exact correction and changed files

Only five files change relative to this correction's dirty starting worktree:

| File | Correction |
| --- | --- |
| [Observed Stripe transport](../../apps/api/src/payment-provider/observed-stripe-transport.ts) | Await bounded raw-body retention before returning a response to SDK retry selection; cache body-read errors and lazy JSON decode |
| [Original author observation tests](../../apps/api/test/integration/provider-observations.spec.ts) | Strengthen the existing retry case with exact committed503 and200 body/completeness/status assertions; remove no expectations |
| [Native transport correction tests](../../apps/api/test/integration/provider-observation-native-transport.spec.ts) |17 permanent cases through real pinned Node transport, SDK retry selection and restricted SQL publication |
| This correction record | Before/after evidence, limits and re-review handoff |
| [Documentation index](../README.md) | One additive navigation entry |

The two reviewer-owned suites and review record are byte-for-byte preserved, including the original acceptance assertion and historical red-test comment. Existing SQL0009, its journal entry, schema, producer, role composition and all historical migrations0000–0008 remain unchanged. No dependency upgrade, private SDK patch or replacement provider adapter is introduced.

`ObservedStripeTransport.makeRequest` still establishes accepted account/key/destination authority and one exchange per actual HTTP attempt. After the inner Node transport returns headers, it constructs `CapturedResponse`, awaits `retainBody`, and only then returns that response to RequestSender. Every received response is consumed or safely terminated before retry selection can skip JSON handling.

`retainBody` consumes raw Buffer chunks from the supported stream, copying original bytes before any decoding. It retains at most1MiB and terminates oversized retention as PARTIAL. A complete empty body is `Buffer.alloc(0)`/COMPLETE, distinct from no HTTP response (NULL/ABSENT). Truncation, premature close, timeout during body reading and incomplete native HTTP framing retain the available prefix/PARTIAL. Native `IncomingMessage.complete` supplies the additional framing check. Observation time is recorded when the bounded read completes or fails.

Body-read errors are saved on the response as the SDK's public `makeResponseBodyError` type, retaining the underlying error code. They do not escape as a new pre-header connection failure. The SDK can therefore continue selecting a retry from the original status/headers, even for a partial503. For a nonretryable200 body timeout/truncation, SDK JSON handling receives the cached body error and preserves its original connection/API error behavior.

`toJSON` lazily creates a cached decode promise from retained bytes or the saved body error. Invalid JSON/UTF-8 in an intermediate503 is retained but is not prematurely parsed before the SDK chooses its retry. The final selected response still goes through SDK JSON/error mapping and the existing StripePaymentProvider. No transport response is synthesized from a parsed result, mirror or lookup.

Retry **rules**, maximum counts, header overrides, original provider key and SDK backoff remain owned by RequestSender. Capture necessarily waits for its bounded body read before handing back the response, so retry timing now includes that read. The existing native request timeout remains armed during body acquisition; no new indefinite wait or private retry implementation is added. A closed-socket ECONNRESET can still receive the SDK's one retry even with maxNetworkRetries0, using the original accepted key.

## 5. Per-attempt storage and corrected committed evidence

The existing contract already distinguishes accepted authority, local execution UUID and received HTTP exchanges. Source keys remain `<execution UUID>:<one-based HTTP attempt>`, with each attempt's exact raw bytes/completeness/status/request-ID/safe headers, observation time and SDK version. Existing publication fingerprints include those bytes and context. The SQL source order and immutable predecessor FK retain ordered history under the same execution. No schema adjustment is required.

An HTTP attempt is not a separate provider operation or a financial finality assertion. Earlier transport evidence remains independently visible when the final SDK response succeeds or the SDK exhausts retries. The final SDK operation uses the cached body/error of its selected response; no additional source pretending to be original wire bytes is created from its returned object. SQL continues interpreting genuine provider object/error facts from each actual retained body.

The unchanged reviewer suite passed **4/4, 0 failed/skipped** after correction,18.434s. A combined native run then passed **21/21 across2 suites**, including17 new cases,41.377s. These repeated executions are not summed as distinct coverage.

Read-only SQL confirmed the corrected two-attempt state in retained database `fintech_r1_signed_7b196cd0c5e7427ab7302e2345479162`:

| Attempt | HTTP / request ID | Stored bytes / completeness | SQL interpretation / obligation |
| --- | --- | --- | --- |
| execution `ddd3b56f-cc8c-4f2a-b5a0-3b8108c3985b`, key suffix1 | 503 / req_review_1 | **73 / COMPLETE** | **RETURNED_ERROR / RETRYABLE_TRANSPORT_FAILURE / AWAITING_CONFIRMATION** |
| same execution, key suffix2 | 200 / req_review_2 |472 / COMPLETE, exact fixture bytes | RETURNED_OBJECT / CONFIRMED_PROVIDER_RESULT / AWAITING_APPLICATION |

The exact73-byte error SHA256 is **8bb3bc9196c2bc84721e06143d98d6c18363b28954390790b43256f1cae46882**, equal to both the fixture's Node hash and PostgreSQL `sha256(response_body)`. Scope/intake revisions remain1 then2. Both attempts retain mandatory tracking obligations; only the confirmed supported result creates an AWAITING_APPLICATION cause and protected projection. Exact republication creates neither another source nor another obligation/revision. The malformed pre-correction fixture rows remain immutable and are not backfilled or repaired using fabricated evidence.

## 6. Permanent regression matrix and security

The17 new cases cover all requested correction families, alongside the unchanged reviewer and original author suites:

- Complete503 → success; complete503 retry exhaustion; distinct503/500 bodies → success; complete200 success; genuinely empty503; pre-header connection failure; pre-header timeout; partial drop, body timeout and premature close; partial503 retry; native oversize bound; invalid intermediate UTF-8; retry-header true/false overrides; SDK closed-socket retry; and retained-evidence publication rollback/retry.
- Exact bytes and PostgreSQL SHA256, status/request-ID headers, execution ownership, ordinal keys, predecessor order, stable account/key/form bytes and safe request/response headers are asserted on committed records.
- A503 is unconfirmed retryable transport evidence, never definitive financial failure/no-effect. Exhausted retries leave zero financial application obligations/projections.503 → success retains tracking obligations for each source but only one confirmed financial cause. HTTP status alone cannot produce a journal or supported result projection.
- Tests compare committed source/obligation/projection counts and scope/intake revisions, exercise reader neutrality/blocking, reject direct publisher INSERT/UPDATE, and verify unchanged payment/refund/journal/entry/lot fingerprints. After an injected publication rollback, the retained batch republishes without any further HTTPS request or duplicate revision.
- Existing independent SQL privilege, eight-stage rollback and observed PostgreSQL lock schedules are preserved and rerun. Real authenticated restricted LOGINs are used; no owner pool is substituted for publication.

Authorization/API secrets remain excluded from retained headers. Raw provider bodies remain protected private evidence with the inherited access/retention assumptions; this fix is not a production encryption or retention audit. Intercepted test HTTPS requests use fixture API keys and unconnected native sockets. No external provider request, real credential validation or TLS handshake is claimed.

## 7. Full verification record

Local environment: PostgreSQL**18.6**, x86_64-windows/MSVC19.44.35228, localhost55433; Node**24.19.0**, pnpm**10.26.0**, stripe-node**22.6.2**. All database tests use explicitly selected disposable databases and the unchanged ten-migration chain. Installed offline dependencies were used; no package install or upgrade.

| Executed check | Passed | Failed | Skipped | Suites / notes |
| --- | --- | --- | --- | --- |
| Unchanged native reviewer suite before source change |3 |**1 P1** |0 |1 suite,19.419s; exact missing503-body assertion above |
| Unchanged native reviewer suite after correction |**4** |0 |0 |1 suite,18.434s |
| Focused native correction + reviewer controls |**21** |0 |0 |2 suites,41.377s;17 new cases plus4 original controls |
| Final complete PostgreSQL integration matrix |**736** |**0** |**0** |**23 suites**,171.003s;686 original author/financial cases +33 reviewer cases +17 new native cases |
| Separate unchanged F01 expected-red invocation |0 |**6 expected** |0 |1 suite,25.894s; failures are the same financial balance assertions, not setup/privilege/transport failures |
| `pnpm test` |**50** |0 |742 |12 unit suites passed,24 DB opt-in suites skipped;792 tests discovered. Green DB cases and expected-red F01 executed separately above |
| `pnpm lint`, `pnpm typecheck` |PASS |0 |— |API and web, including all reviewer/correction files |
| `pnpm build` |PASS |0 |— |Nest API and Next web production builds; no deployment |
| Documentation validation |PASS |0 |— |**54 Markdown files /792 relative links and anchors**, CI YAML structure checked;19 unchanged Mermaid blocks inventoried, no diagram parser/render run |
| Preservation and whitespace |PASS |0 |— |**239 of242 starting files byte-for-byte unchanged**, exactly3 authorized existing-file edits and2 additions; `git diff --check` plus all5 correction-file newline/trailing-whitespace checks passed |

Repeated focused runs are not summed into distinct coverage. The final full matrix includes both original reviewer suites unchanged and all17 new native cases. Fresh-install and populated migration upgrades, publisher privileges, source/obligation rollback, original financial semantics and R1 signed receipts are exercised in that matrix. Hosted PostgreSQL17 CI was not run.

Initial correction lint found that the moved `toJSON` method no longer needed async; the cached lazy Promise implementation fixed it without disabling the rule. Documentation validation found an incorrect new section anchor, corrected to the owning design document. The original financial/SQL/role assertions and reviewer expectations were not weakened.

Primary commands, from `apps/api`, with RUN_DB_TESTS1 and an explicit local MIGRATION_ADMIN_URL:

```powershell
# Before and after, unchanged reviewer suite:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/provider-observation-review.spec.ts --cacheDirectory ../../.tmp/jest-d02-a-r1
# Native correction plus reviewer controls:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/provider-observation-native-transport.spec.ts test/integration/provider-observation-review.spec.ts --cacheDirectory ../../.tmp/jest-d02-a-r1
# Full matrix additionally sets RUN_MIGRATION_TESTS=1 and disposable DATABASE_URL:
node node_modules/jest/bin/jest.js --runInBand test/integration --testPathIgnorePatterns settlement-f01.pending --cacheDirectory ../../.tmp/jest-d02-a-r1
# Separate F01 invocation additionally sets RUN_F01_PENDING=1:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/integration/settlement-f01.pending.spec.ts --cacheDirectory ../../.tmp/jest-d02-a-r1-f01
```

Root commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, documentation validation and `git diff --check`. Temporary logs/JSON/before-after SQL evidence and hash inventories are ignored `.tmp/d02-a-r1-*`; they are not deliverables or replacements for permanent assertions.

Final scope audit verified unchanged HEAD and empty index, exactly the five correction files listed above, and **23 total uncommitted deliverables** including the preserved starting work. Both reviewer suites, the REQUEST_CHANGES report, approved design/review, original author report, schema, journal and SQL0000–0009 retain their exact starting bytes. The F01 source and all six financial failure messages match the earlier baseline exactly. Saved current suite database identities separately and restored all39 starting ignored database-marker contents. The disposable cluster stopped successfully; fixture databases and immutable history are retained. No staging, commit or push occurred.

## 8. Remaining limits and independent re-review

Re-review the original unchanged P1 regression, eager bounded byte acquisition before retry selection, cached decode/error handling, partial503 versus nonretryable200 body errors, empty versus absent evidence, key/attempt ownership and committed SQL obligations/revisions. Verify the original review's SQL, admission, source immutability and concurrent schedules remain green.

Not executed: actual Stripe API/TLS/account verification, hosted PostgreSQL17/Node22 CI, live broker/ACK/DLQ workers, process kill/database wire-loss experiments, production ACL/credential installation, scope activation or financial application. The native tests exercise real pinned SDK transport and retry classes with deterministic fake native HTTP responses; they do not certify external behavior or exactly-once provider execution.

No new runtime registration or financial capability is installed. Unknown outcomes remain neutral where approved, the23-hour original-key replay bound and lookup provenance are unchanged, and signed-receipt R1 semantics remain separate. Capture aggregate evidence still requires the later attributable pre-lot proof and independently reviewed R2 application/disposition checkpoint. Do not begin capture application or activate scopes from this correction.

Author verdict: **READY_FOR_RE_REVIEW**.
