# AI-assisted engineering workflow

Status: current. Owner: working process; [AGENTS.md](../AGENTS.md) owns repository rules.

AI tools help inspect code, trace transaction boundaries, draft changes and run checks. The repository records evidence in code, tests, migrations and documents. Generated explanations and passing mocks do not establish real-money correctness.

## Work loop

1. **Inspect.** Read the [task matrix](AGENT_START_HERE.md), Git status, owning documents and executable code. Identify current versus historical behavior.
2. **Define.** State the concrete outcome, affected invariant and verification. For a race, name both competing transactions and the expected committed result.
3. **Change.** Make the smallest diff. Preserve hand-written migrations, provider/API idempotency, ledger business references and ownership checks.
4. **Verify.** Run the relevant unit checks, then PostgreSQL integration checks for durable effects. Use a disposable database. Observe UI behavior separately when it changes.
5. **Record.** Update the owning document. Label evidence as inspected, unit-tested, database-tested or observed in the browser. Record environment and failures.
6. **Review.** Read the final diff against the original scope. Human review remains necessary for financial semantics, security and any use beyond local study.

## Review questions for payment changes

- Does local acceptance still commit intent, command, audit and replay response together?
- Can a retry after response loss reuse the same provider key without assuming failure?
- Can inbox processing receive evidence before consumer bookkeeping commits?
- Are attempt/payment identity, amount, currency and merchant checked before posting?
- Do ledger changes preserve balance, immutability and business-reference uniqueness?
- Does the proposed lock protect every relevant concurrent writer, including refunds/disputes?
- Are settlement, payout and provider state still described as distinct boundaries?

## Handoff

Report what was inspected, changed and executed; show failures and missing evidence plainly. Link the source-of-truth document and propose the next focused audit. Do not convert a configured CI job into a passed CI claim or a seeded dashboard into an end-to-end provider demo.
