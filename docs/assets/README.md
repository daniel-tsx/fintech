# Dashboard screenshot

Status: current. Owner: screenshot provenance.

[payment-trace.png](payment-trace.png) was captured on 2026-10-07 at a 1440 × 1000 CSS viewport, full page, from the built Next.js dashboard and local API. Existing dashboard edits were preserved.

The source is the repository's `db:seed` fixture: payment `44444444-4444-4444-8444-444444444444`, USD 100.00 capture, USD 3.00 fee, USD 97.00 pending liability, placeholder provider references and three balanced journal lines. It contains no live payment evidence.

To reproduce, follow [setup](../verification.md), start API/web without workers and open `/payments/44444444-4444-4444-8444-444444444444`. Seed timestamps are relative to execution time, so dates will differ. Take the screenshot before completing settlement if you want the same pending capture view.
