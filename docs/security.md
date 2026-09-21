# Security and PCI boundary

Status: current; this is an educational control set, not a production compliance claim.

- Merchant API keys are prefixed for identification but only SHA-256 hashes are stored. They are shown once by the seed script.
- The auth guard establishes `merchantId`, actor ID, and role. Every merchant query includes that tenant scope. Platform-admin endpoints require an explicit role.
- Request DTOs are whitelisted and validated; unknown fields fail.
- Helmet, CORS allow-listing, and request rate limiting are enabled.
- Public responses omit raw provider payloads, signatures, hashes, and internal error stacks.
- Sensitive actions append immutable audit records without secrets.
- Correlation IDs are accepted/generated and returned to callers.

No raw PAN, CVV, bank credentials, or cardholder authentication data enters this system. `payment_method_token` is treated as an already-created Stripe PaymentMethod ID. A real merchant client would tokenize sensitive data directly with Stripe-hosted/client-side components, which this branch intentionally does not build. This reduces scope but does not itself certify PCI compliance. Human review is required before using this design outside the lab.

The development user-header fallback is available only outside production. Production would use an external identity provider, short-lived sessions, MFA for administrators, key rotation/revocation workflows, managed secrets, and a formal authorization test matrix.
