# Documentation index

Status: current. Owner: navigation and source-of-truth routing.

Start with the [project overview](../README.md). Each document below owns its named subject; executable code and checked-in SQL win when prose disagrees. Update the owning document instead of adding parallel notes.

## Engineering workflow

- [Agent start here](AGENT_START_HERE.md) — task reading matrix and code entry points.
- [AI workflow](AI_WORKFLOW.md) — inspect → define → change → verify → record → review.
- [Repository rules](../AGENTS.md) — financial invariants and safety; [Claude entry point](../CLAUDE.md).

## Architecture and correctness

| Document | Owns |
| --- | --- |
| [Architecture](architecture.md) | Runtime units, module boundaries, provider/internal ownership |
| [Database design](database-design.md) | Schema, checked-in SQL constraints and triggers |
| [Ledger](ledger.md) | Accounts, capture postings, rounding and immutable accounting |
| [Concurrency](concurrency.md) | Locks/uniqueness, executed race coverage and gaps |
| [Portfolio architecture diagrams](architecture/portfolio-diagrams-notes.md) | Supporting visuals for Architecture, editable sources, exports and review limits |

## Payment flows

- [Payment lifecycle](payment-lifecycle.md) — authorization/capture states and asynchronous completion.
- [Refunds and disputes](refunds-and-disputes.md) — refundable limits, holds and compensating journals.
- [Settlement and payout](settlement-and-payout.md) — internal pending/available transfers and reservation.

## Reliability and provider boundary

- [Webhooks and idempotency](webhooks-and-idempotency.md) — API replay, signed inbox, deduplication and retries.
- [Transactional outbox / RabbitMQ](outbox-rabbitmq.md) — current relay/consumer topology, confirms, ACK/retry/DLQ and duplicate-publication gap.
- [Stripe boundary](real-psp-stripe.md) — current provider mapping/ownership; parent-branch polling comparison is explicitly historical.
- [Failure recovery](failure-recovery.md) — current mocked exercises and recovery limits.
- [Reconciliation](reconciliation.md) — referenced-object drift detection and recorded resolution.

## Operations and security

- [Setup and verification](verification.md) — supported tools, environment placement, migration/seed, exact checks, CI coverage and executed evidence.
- [Observability](observability.md) — correlation, logs, database snapshot metrics and health limits.
- [Security](security.md) — inspected controls, development identities and unverified authorization/compliance boundaries.

## Presentation

- [UI signature](ui-signature.md) — dashboard visual conventions.
- [Dashboard screenshot](assets/README.md) — seeded fixture provenance and reproduction.

## Audit evidence

- [H1 Fix 02 B3.2 B.2-R2-A / A.1 / A.2: shared financial application foundation](audits/h1-fix-02-b3-2-b2-r2-a-financial-application-foundation.md) — ownership correction drafted; BLOCKED_BY_FINANCIAL_OWNERSHIP_CONTRACT because PostgreSQL access is restricted. Original history, reviewer regressions and REQUEST_CHANGES preserved; independent re-review required before R2-B, with no installation or activation authorized.
- [H1 Fix 02 B3.2 B.2-R2-A: independent foundation review](audits/h1-fix-02-b3-2-b2-r2-a-independent-review.md) — REQUEST_CHANGES: two P1 ownership defects, four retained failing regressions, exact SQL predicates and corrective checkpoint; interrupted authorization experiments not resumed, implementation and fixtures unchanged.
- [H1 financial correctness audit](audits/h1-financial-correctness.md) — historical findings for the audited revision, with follow-up links.
- [H1 Fix 01: posted ledger immutability](audits/h1-fix-01-posted-ledger-immutability.md) — F02 implementation, migration considerations and regression evidence. Current accounting/database behavior remains owned by Ledger and Database design above.
- [H1 Fix 02: settlement accounting design](audits/h1-fix-02-settlement-design.md) — approved Approach A / pending-refund Option A contract and regression matrix, preserving original Run A evidence; runtime integration remains planned.
- [H1 Fix 02 B1: allocation foundation](audits/h1-fix-02-b1-allocation-foundation.md) — dormant schema/helper checkpoint, migration safeguards and executed regressions; F01 remains open and current flow ownership stays above.
- [H1 Fix 02 B2.1: capture integration](audits/h1-fix-02-b2-1-capture-integration.md) — atomic new-capture journal/lot evidence, capture lock compatibility and dormant cutover contract; runtime refund/dispute/settlement cutover remains pending.
- [H1 Fix 02 B2.2: refund integration](audits/h1-fix-02-b2-2-refund-integration.md) — gated dormant refund service, frozen FIFO reservations, exact source-specific journals and exception evidence; runtime dispatch/cutover remains blocked pending coordinated writers.
- [H1 Fix 02 B2.3: dispute integration](audits/h1-fix-02-b2-3-dispute-integration.md) — dormant capture-owned holds, win/loss and shared refund/loss hold reductions; isolated transaction/concurrency evidence and remaining runtime cutover requirements.
- [H1 Fix 02 B2.4: settlement integration](audits/h1-fix-02-b2-4-settlement-integration.md) — dormant capture-owned candidate generation, authoritative completion, independent asset/release effects, zero finalization and historical replay; live cutover/F01/F04 remain open.
- [H1 Fix 02 B3.1: integrated verification](audits/h1-fix-02-b3-1-integrated-verification.md) — actual capture-to-payout lifecycle evidence, account oracles, controlled cross-writer schedules and explicit receipt/exception/legacy cutover gaps; authorizes no activation.
- [H1 Fix 02 B3.2 Run A: runtime cutover design](audits/h1-fix-02-b3-2-runtime-cutover-design.md) — human-approved design for admission, dispatch, fencing and trusted evidence; implementation staged, with no activation.
- [H1 Fix 02 B3.2 Run A: independent design review](audits/h1-fix-02-b3-2-design-review.md) — original findings and A.1 acceptance; D01 design-resolved, with implementation gates and no runtime authorization.
- [H1 Fix 02 B3.2: approved human decisions](audits/h1-fix-02-b3-2-human-decisions.md) — twelve signed-off architecture choices and D01 evidence policy; B.1 schema implementation only is authorized, activation remains prohibited.
- [H1 Fix 02 B3.2 B.1: trusted evidence schema](audits/h1-fix-02-b3-2-b1-trusted-evidence-schema.md) — immutable receipt/provenance/object ownership and shared SQL proof contract; financial application remains closed pending B.2, with isolated role/migration/concurrency evidence.
- [H1 Fix 02 B3.2 B.1: independent evidence review](audits/h1-fix-02-b3-2-b1-independent-review.md) — dormant checkpoint acceptance, independently rerun financial/role/migration checks, both receipt/header race orders and explicit B.2 dependencies.
- [H1 Fix 02 B3.2 B.2-R1: receipt preflight](audits/h1-fix-02-b3-2-b2-r1-trusted-receipt.md) — blocked before implementation: installed B.1 schema lacks the required durable admission lifecycle; receipt-only forward DDL and sealer composition need review.
- [H1 Fix 02 B3.2 B.2-R1: post-R0 implementation preflight](audits/h1-fix-02-b3-2-b2-r1-implementation.md) — original lifecycle dependency resolved by R0; implementation stopped at the remaining guarded conflicting-delivery retention/barrier contract, with unchanged-foundation verification and D02 publisher limits.
- [H1 Fix 02 B3.2 B.2-R0: receipt admission foundation](audits/h1-fix-02-b3-2-b2-r0-admission-foundation.md) — dormant forward obligation/revision schema, restricted SQL lifecycle and receipt-side concurrency evidence; R1 publisher and R2 financial dispatch remain unimplemented.
- [H1 Fix 02 B3.2 B.2-R0: independent review](audits/h1-fix-02-b3-2-b2-r0-independent-review.md) — changes requested for nonblocking contradictory pending classification; independent PostgreSQL/concurrency/privilege evidence and permanent review regressions.
- [H1 Fix 02 B3.2 B.2-R0.1: independent re-review](audits/h1-fix-02-b3-2-b2-r0-1-independent-review.md) — dormant checkpoint acceptance after independently reproduced classification correction; preserved pending neutrality, SQL barriers and privileges, with hosted PostgreSQL17 CI still required.
- [H1 Fix 02 B3.2 B.2-R0.2: conflicting delivery foundation](audits/h1-fix-02-b3-2-b2-r0-2-conflicting-delivery.md) — additive immutable later-delivery evidence and checked account/scope barriers, observed by the dormant R0 reader; SDK/HTTP integration and evidence-backed recovery remain separate R1/R2 gates.
- [H1 Fix 02 B3.2 B.2-R0.2: independent conflicting delivery review](audits/h1-fix-02-b3-2-b2-r0-2-independent-review.md) — dormant checkpoint acceptance after independent PostgreSQL, replay/conflict, atomicity, privilege and controlled concurrency verification; R1/R2 and hosted checks remain separate gates.
- [H1 Fix 02 B3.2 B.2-R1: isolated signed receipt integration](audits/h1-fix-02-b3-2-b2-r1-signed-receipt-integration.md) — SDK-verified HTTP harness, atomic first admission, retained later-delivery evidence, restricted login capabilities and separate correlation/binding; no live routing, D02 producer, financial application or activation.
- [H1 Fix 02 B3.2 B.2-R1: independent signed receipt review](audits/h1-fix-02-b3-2-b2-r1-independent-review.md) — dormant checkpoint acceptance after 633 independent PostgreSQL cases, authenticated role/SDK/rollback checks and preserved legacy failures; operational credentials, D02, R2 and hosted validation remain separate gates.
- [H1 Fix 02 B3.2 B.2-R2 Run A: financial application design](audits/h1-fix-02-b3-2-b2-r2-financial-application-design.md) — proposed D02 producer, operation-specific atomic application/disposition, SQL invariants, lock schedules and small dormant checkpoints; design only, with no implementation or activation authorization.
- [H1 Fix 02 B3.2 B.2-R2 Run A: independent design review](audits/h1-fix-02-b3-2-b2-r2-design-review.md) — design accepted for planning separate dormant D02, capture-first application and subsequent writer/recovery checkpoints; no implementation, installation or activation authorization, with runtime findings and operational gates preserved.
- [H1 Fix 02 B3.2 B.2-R2 D02-A: immutable provider observations](audits/h1-fix-02-b3-2-b2-r2-d02-a-provider-observations.md) — isolated genuine SDK producer, prospective immutable authority/source evidence, restricted publication and local PostgreSQL verification; awaiting independent review, with financial application and runtime activation still closed.
- [H1 Fix 02 B3.2 B.2-R2 D02-A: independent provider observation review](audits/h1-fix-02-b3-2-b2-r2-d02-a-independent-review.md) — REQUEST_CHANGES: pinned-SDK retries omit available response bodies; permanent native transport regression and independent SQL/concurrency evidence, with financial application and activation still closed.
- [H1 Fix 02 B3.2 B.2-R2 D02-A R1: native transport correction](audits/h1-fix-02-b3-2-b2-r2-d02-a-r1-transport-correction.md) — eager bounded response retention before SDK retry selection, preserved reviewer regression and native retry/recovery evidence; awaiting independent re-review, with runtime and financial application still closed.
- [H1 Fix 02 B3.2 B.2-R2 D02-A R1: independent transport correction review](audits/h1-fix-02-b3-2-b2-r2-d02-a-r1-independent-review.md) — dormant checkpoint approval after unchanged native retry regression, exact committed bytes/hashes and736 independent PostgreSQL cases; original P1 resolved, with financial application and activation still closed.

## Historical material

- [Original Mock PSP failure scenarios](archive/failure-scenarios.md) — historical; runtime scenario controls were removed before this checkout.
- Git history: `4f1cf61` introduced the Mock PSP lab; `286c8c3` replaced the provider boundary with Stripe; `5b6ebd1` introduced RabbitMQ relay/consumers.

Historical text explains earlier design decisions; it does not define current setup commands or verification. The former [failure-scenarios path](failure-scenarios.md) remains a redirect for existing links.
