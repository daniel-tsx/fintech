# Fintech Lab

A reference payment platform: merchants take card payments through a provider (Stripe), and an internal double-entry ledger records what the platform owes and holds. Settlement and payout are internal lab accounting, not bank movements.

## Language

### Payments

**Merchant**:
The business that accepts payments and to whom the platform owes the net proceeds; the unit of tenancy.
_Avoid_: Tenant, seller, account

**Payment**:
A merchant's request to collect one amount in one currency from a customer, tracked through its workflow status.
_Avoid_: Charge, order, transaction

**Authorization**:
The provider's approval to hold funds on the customer's card for a payment, without moving them.
_Avoid_: Pre-auth, hold

**Capture**:
Collecting authorized funds through a capture payment attempt.
_Avoid_: Charge, settle

**Payment attempt**:
One authorize or capture try for a payment (`AUTHORIZE` or `CAPTURE`), with its own provider key.
_Avoid_: Request, try

**Refund**:
Returning captured funds to the customer, fully or partially.
_Avoid_: Reversal, chargeback

**Dispute**:
A customer's challenge to a captured payment raised through the card network, which can end won or lost.
_Avoid_: Chargeback (use only for the network's own term), claim

### Provider boundary

**Provider**:
The external payment service behind the `PaymentProvider` port; currently Stripe.
_Avoid_: PSP (except in ledger account names), gateway, processor

**Provider command**:
An instruction to the provider (authorize, capture, refund…) written to the outbox and executed by a worker, never inline in the API request.
_Avoid_: Job, task, call

**Provider key**:
The idempotency key sent to the provider for one payment attempt or refund, such as `capture:<attemptId>` or `refund:<refundId>`; it never changes across retries or redelivery.
_Avoid_: Request ID, new key

**Webhook event**:
A provider notification received, verified and stored in the inbox before any business effect.
_Avoid_: Callback, notification

### Reliability

**Idempotency key**:
The client-supplied key that scopes an API request so a replay returns the original status and body.
_Avoid_: Request ID, dedupe key

**Outbox**:
The PostgreSQL table where provider commands and internal events commit atomically with local state, later relayed to RabbitMQ.
_Avoid_: Queue, event log

**Inbox**:
The PostgreSQL table where received webhook events are stored and processed at least once.
_Avoid_: Queue, webhook log

**Reconciliation**:
Comparing local payment state with the provider's and recording each mismatch as an issue.
_Avoid_: Sync, audit

### Ledger

**Ledger account**:
A named balance per platform or merchant and currency, such as `MERCHANT_PENDING`; each has a type and a normal side.
_Avoid_: Wallet, balance

**Journal**:
One balanced, immutable group of ledger entries recording a single business event, unique by its business reference.
_Avoid_: Ledger transaction, transaction, posting

**Entry**:
One debit or credit line of a journal against one ledger account.
_Avoid_: Posting, leg, line item

**Business reference**:
The key that makes a journal unique for its business event, so a retry finds the existing journal instead of posting twice.
_Avoid_: Reference ID, idempotency key

**Compensating journal**:
A new journal that corrects an earlier one; posted journals are never edited or deleted.
_Avoid_: Reversal entry, adjustment, fix

### Settlement and payout

**Merchant pending**:
The part of a merchant's captured net not yet settled, held in `MERCHANT_PENDING`.
_Avoid_: Unsettled balance, pending balance

**Settlement**:
The internal step that moves a merchant's eligible captured net from pending to available after the merchant's delay; it is not a bank or provider settlement.
_Avoid_: Payout, clearing, provider settlement

**Merchant available**:
Settled funds that can be paid out, held in `MERCHANT_AVAILABLE`; payouts never make it negative.
_Avoid_: Balance, withdrawable

**Payout reservation**:
Moving an amount from merchant available to payout clearing when a payout is requested, under the merchant/currency lock.
_Avoid_: Hold, reserve

**Payout**:
The internal lab transfer of available funds to a merchant, completed by a journal; no bank transfer happens.
_Avoid_: Withdrawal, settlement, transfer

## Relationships

- A **Payment** has authorize and capture **Payment attempts**; a captured payment may have **Refunds** and **Disputes**.
- Every provider effect starts as a **Provider command** in the **Outbox** and returns as a **Webhook event** in the **Inbox**.
- Captured ≠ settled ≠ paid out: a **Capture** credits **Merchant pending**, **Settlement** moves it to **Merchant available**, and a **Payout reservation** then a **Payout** move it out.
- Workflow status, provider state and **Journals** are separate; provider success alone never posts a journal.
