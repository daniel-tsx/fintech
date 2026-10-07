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
  Worker->>DB: transaction: inbox + attempt/payment locks, journal, audit, processed
```

Authorization reserves customer funding capacity only. Capture creates a provider receivable and merchant pending liability. Settlement converts the provider receivable to cash and moves merchant pending to available. Payout consumes available funds. These are deliberately separate.

The sequence illustrates successful capture; webhook receipt can precede consumer reference persistence or ACK. Completion is driven by inbox processing, not by the synchronous response. Settlement/payout are internal accounting simulations. Partial capture is modeled by the application, but Stripe multicapture availability is account/payment-method dependent and not externally verified. Cancellation records local `CANCELLED` at request acceptance; see the [provider boundary limits](real-psp-stripe.md#translation-and-terminology-mismatches).
