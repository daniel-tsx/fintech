# Observability

Status: current.

`nestjs-pino` emits structured JSON. Middleware returns `x-correlation-id`. Domain logs attach payment, merchant, provider transaction, webhook, job, settlement, payout, and reconciliation IDs when available; request bodies and authentication headers are redacted.

`GET /metrics` exposes a small Prometheus-compatible local registry for counters and histograms. Intended signals are payment authorization/capture outcomes, provider failures, webhook receipt-to-processing latency, outbox failures, capture/refund latency, reconciliation issue count, and payout failures. Production would use a maintained metrics SDK and OpenTelemetry exporters; the lab keeps the mechanics visible and dependencies small.
