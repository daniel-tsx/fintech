# Failure scenarios

Status: historical — describes the original Mock PSP branch, not `real-psp-stripe`.

Each Mock PSP profile is deterministic and selectable per request with `scenario` or via development endpoints.

| Scenario | Behavior | Expected recovery |
| --- | --- | --- |
| `SUCCESS` | normal result and webhook | inbox processes once |
| `DECLINE` | authorization rejected | payment becomes failed |
| `TIMEOUT_BEFORE_PROCESSING` | provider sees nothing | bounded retry with same provider key |
| `PROCESSED_RESPONSE_LOST` | provider commits then call throws | webhook or reconciliation resolves unknown outcome |
| `DELAYED_WEBHOOK` | webhook outbox is delayed | payment remains pending |
| `DUPLICATE_WEBHOOK` | same event delivered twice | inbox unique constraint deduplicates |
| `OUT_OF_ORDER_WEBHOOK` | capture arrives before authorization | prerequisite retry, then processing |
| `TEMPORARY_500` | first attempts fail | exponential retry |
| `REFUND_RETRY_THEN_SUCCESS` | refund fails transiently | retry using same provider key |
| `AMOUNT_MISMATCH` | provider report is inconsistent | reconciliation issue, no silent repair |
| `UNEXPECTED_TRANSACTION` | report includes unknown payment | reconciliation issue |

The real-PSP branch removes these request controls and development injection endpoints. Equivalent adapter/network outcomes are covered with mocked Stripe SDK tests.
