# Security and PCI boundary

Status: current; this is an educational control set, not a production compliance claim.

- Merchant API keys are prefixed for identification; SHA-256 hashes are stored. The seed prints its local demo key each time it runs.
- The auth guard establishes `merchantId`, actor ID and role; merchant services use this context and role-decorated endpoints enforce explicit roles. A complete cross-tenant authorization matrix has not been executed; this is not a guarantee about every query.
- Request DTOs are whitelisted and validated; unknown fields fail.
- Helmet, CORS allow-listing, and request rate limiting are enabled.
- Public responses omit raw provider payloads, signatures, hashes, and internal error stacks.
- Sensitive actions append immutable audit records without secrets.
- Correlation IDs are accepted/generated and returned to callers.

No raw PAN, CVV, bank credentials, or cardholder authentication data enters this system. `payment_method_token` is treated as an already-created Stripe PaymentMethod ID. A real merchant client would tokenize sensitive data directly with Stripe-hosted/client-side components, which this branch intentionally does not build. This reduces scope but does not itself certify PCI compliance. Human review is required before using this design outside the lab.

The development user-header fallback is available only outside production. Production would use an external identity provider, short-lived sessions, MFA for administrators, key rotation/revocation workflows, managed secrets, and a formal authorization test matrix.

## Isolated trusted receipt capabilities

[R1 receipt integration](audits/h1-fix-02-b3-2-b2-r1-signed-receipt-integration.md) has no live route or default database/configuration provider. Its isolated composition supplies explicit server-owned Stripe endpoint configuration and separate restricted publisher/correlator LOGIN pools. The connection wrapper rejects elevated/member/inherited-role contexts and direct trusted-table or ledger mutation rights, including the existing owner pool; an ordinary worker cannot execute publication or insert/clear protected evidence. Tests use authenticated restricted database logins rather than SET ROLE on the owner pool. Their role/password/grant setup is confined to newly created disposable databases.

Only verified SDK output reaches the publisher. SQL still trusts that server capability's attestation; it does not verify HMAC itself. HTTP responses omit signed bytes, signatures, secrets and SQL errors. No production login, membership, secret, existing grant or deployment setting changes here. Operational credential provisioning, endpoint-secret rotation, old-worker fencing and live privilege/ingress review remain separate gates. The currently registered legacy receiver and its permissions are unchanged.
