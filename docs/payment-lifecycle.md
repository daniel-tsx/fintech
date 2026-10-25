# Payment lifecycle

Status: current.

```mermaid
stateDiagram-v2
  [*] --> CREATED
  CREATED --> REQUIRES_AUTHORIZATION
  REQUIRES_AUTHORIZATION --> AUTHORIZED: payment.authorized
  REQUIRES_AUTHORIZATION --> FAILED: authorization failed
  AUTHORIZED --> CAPTURE_PENDING: capture requested
  CAPTURE_PENDING --> CAPTURED: payment.capture_succeeded
  CAPTURE_PENDING --> AUTHORIZED: capture failed, nothing captured
  CAPTURE_PENDING --> CAPTURED: capture failed, prior capture exists
  CAPTURED --> CAPTURE_PENDING: additional partial capture
  CREATED --> CANCELLED
  REQUIRES_AUTHORIZATION --> CANCELLED
  AUTHORIZED --> CANCELLED
  CAPTURED --> PARTIALLY_REFUNDED
  CAPTURED --> REFUNDED: full refund
  PARTIALLY_REFUNDED --> PARTIALLY_REFUNDED
  PARTIALLY_REFUNDED --> REFUNDED
  CAPTURED --> DISPUTED
  PARTIALLY_REFUNDED --> DISPUTED
  REFUNDED --> DISPUTED
```

`POST /payments` creates intent in minor units. Manual capture waits for explicit authorization/capture commands. Automatic capture records an authorization request and, after the authorized webhook, creates a capture outbox event. Partial captures use the same capture operation while the remaining authorized amount is positive.

```mermaid
sequenceDiagram
  participant Merchant
  participant API
  participant DB
  participant Relay
  participant Broker as RabbitMQ
  participant Consumer
  participant PSP as PaymentProvider / Stripe
  participant Inbox
  participant Worker as Inbox processor
  Merchant->>API: POST /payments/:id/capture + Idempotency-Key
  API->>DB: transaction: lock + pending state + attempt + outbox + audit + replay
  API-->>Merchant: 202 CAPTURE_PENDING
  Relay->>DB: claim committed command
  Relay->>Broker: publish original command / confirm
  Relay->>DB: mark PUBLISHED
  Broker->>Consumer: deliver
  Consumer->>PSP: capture with original provider key
  PSP-->>Consumer: synchronous result
  Consumer->>DB: references / PROCESSING only
  Consumer->>Broker: ACK after local commit
  PSP->>Inbox: signed Stripe event
  Inbox->>DB: verify and persist normalized event
  Inbox-->>PSP: 202
  Worker->>DB: transaction: inbox + scope/payment/attempt locks, journal, lot, audit, processed
```

Authorization reserves customer funding capacity only. Capture creates a provider receivable and merchant pending liability. Settlement converts the provider receivable to cash and moves merchant pending to available. Payout consumes available funds. These are deliberately separate.

## Dormant MANUAL authorization application

[Migration0013](../apps/api/drizzle/0013_manual_authorization_application.sql) defines the private P-B SQL contract. A restricted caller prepares from an accepted AUTHORIZE command, its exact signed B1 proof, current inbox claim and expected evidence revisions, then applies the frozen SQL plan in the same READ COMMITTED transaction. It requires the original complete D02 COMMAND_RESULT and a MANUAL payment awaiting authorization. Success establishes the canonical root, tagged proof, successful attempt, AUTHORIZED payment, immutable provider audit, exact source dispositions, scope revision and PROCESSED inbox atomically.

The result is `VERIFIED_NO_EFFECT` with reason `AUTHORIZE_SUCCESS`: authorization recognizes no captured principal, fee, ledger journal or accounting lot. The original source obligations remain stored; only complete owned application evidence suppresses their exact causes for admission. A distinct source, reblocked receipt revision, delivery barrier or OPEN exception remains effective. Original-result recognition verifies historical evidence without repeating effects or requiring today's whole payment image to equal its authorization image.

Installation leaves contracts and enrollment empty and grants no runtime LOGIN capability. Private test composition installs only its DORMANT LEGACY/epoch0 contract. Production handlers remain unchanged. Automatic authorization, protected first-capture intent (P-C), capture preparation/application/recovery and activation require separate checkpoints. The permanent [application](../apps/api/test/integration/manual-authorization-application.spec.ts) and [migration](../apps/api/test/integration/manual-authorization-migration.spec.ts) suites define the acceptance checks; execution results belong to the task checkpoint, not this contract description.

The sequence illustrates successful capture; webhook receipt can precede consumer reference persistence or ACK. Completion is driven by inbox processing, not by the synchronous response. Settlement/payout are internal accounting simulations. Partial capture is modeled by the application, but Stripe multicapture availability is account/payment-method dependent and not externally verified. Cancellation records local `CANCELLED` at request acceptance; see the [provider boundary limits](real-psp-stripe.md#translation-and-terminology-mismatches).

Confirmed new capture success also creates one `capture_accounting_lots` row in this same transaction, linked to the actual POSTED CAPTURE journal. Original gross/fee/net and exact financial posting time come from PostgreSQL journal evidence; eligibility freezes the merchant delay read for that posting as elapsed 24-hour days. A lot failure rolls back the journal, attempt/payment updates, mirror and audit. Duplicate successful attempts return without posting or backfilling old captures. These lots are dormant original evidence: refund/dispute/settlement services still use legacy accounting. See [B2.1 evidence and cutover limits](audits/h1-fix-02-b2-1-capture-integration.md).
