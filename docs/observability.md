# Observability

Status: current.

`nestjs-pino` emits structured logs (pretty output in development). Middleware accepts/generates and returns `x-correlation-id`; audit records retain it when the actor carries it. API logger configuration redacts API-key/authorization headers and payment/destination tokens. Relay envelopes use payload correlation IDs when present, falling back to attempt/refund/payment IDs; this is not full distributed tracing.

`GET /api/v1/metrics` returns six Prometheus-style values queried from current database state: captured/failed payments, dead inbox/outbox rows, open reconciliation issues and failed payouts. Despite some `_total` names, these are snapshot counts, not instrumented monotonic counters. No histograms, latency instrumentation or OpenTelemetry exporters are implemented. `GET /api/v1/health` checks PostgreSQL connectivity only; it does not probe Redis, RabbitMQ or Stripe.
