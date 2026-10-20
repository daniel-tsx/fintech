# AI-assisted engineering workflow

Status: current. Owner: working process; [AGENTS.md](../AGENTS.md) owns repository rules.

AI tools help inspect code, trace transaction boundaries, draft changes and run checks. The repository records evidence in code, tests, migrations and documents. Generated explanations and passing mocks do not establish real-money correctness.

## Work loop

1. **Inspect.** Read the [task matrix](AGENT_START_HERE.md), Git status, owning documents and executable code. Identify current versus historical behavior.
2. **Define.** State the concrete outcome, affected invariant and risk-based verification scope. For a race, name both competing transactions and the expected committed result.
3. **Change.** Make the smallest diff. Preserve hand-written migrations, provider/API idempotency, ledger business references and ownership checks.
4. **Verify.** Follow the [risk-based verification commands](verification.md#risk-based-verification), including isolated Docker integration for affected infrastructure boundaries. Observe UI behavior separately when it changes. Report PASS, FAIL or NOT RUN with evidence and reasons; unit mocks do not verify database locks or service integration.
5. **Record.** Assess documentation needs using [AGENTS.md's completion rules](../AGENTS.md#finish); update the owning document when needed. Label evidence as inspected, unit-tested, database-tested or observed in the browser. Record environment and failures.
6. **Review.** Read the final diff against the original scope. Human review remains necessary for financial semantics, security and any use beyond local study.

## Review questions for payment changes

- Does local acceptance still commit intent, command, audit and replay response together?
- Can a retry after response loss reuse the same provider key without assuming failure?
- Can inbox processing receive evidence before consumer bookkeeping commits?
- Are attempt/payment identity, amount, currency and merchant checked before posting?
- Do ledger changes preserve balance, immutability and business-reference uniqueness?
- Does the proposed lock protect every relevant concurrent writer, including refunds/disputes?
- Are settlement, payout and provider state still described as distinct boundaries?

## Portable agent skills

[Agent Workflow & Skill Routing](../AGENTS.md#agent-workflow--skill-routing) is the single source of shared routing rules. Claude Code imports it through `@AGENTS.md` in [CLAUDE.md](../CLAUDE.md). The skills are real repository files in `.agents/skills/` for Codex and `.claude/skills/` for Claude Code; no symlinks, lifecycle hooks, global settings or application dependencies are installed.

### Sources and maintenance

| Skills | Official source revision | Installed from |
| --- | --- | --- |
| `ponytail` | [DietrichGebert/ponytail@09c434ab](https://github.com/DietrichGebert/ponytail/tree/09c434ab73ca43761c5d8b0c5d341926c2fba710/skills/ponytail) | Existing `~/.agents/skills/ponytail`; matched upstream |
| `ponytail-review`, `ponytail-audit` | [DietrichGebert/ponytail@09c434ab](https://github.com/DietrichGebert/ponytail/tree/09c434ab73ca43761c5d8b0c5d341926c2fba710/skills) | Official upstream |
| `grilling` | [mattpocock/skills@5beb35b0](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/productivity/grilling) | Existing `~/.agents/skills/grilling`; matched upstream |
| `grill-me` | [mattpocock/skills@5beb35b0](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/productivity/grill-me) | Official upstream |
| `systematic-debugging` | [obra/superpowers@bb92a777](https://github.com/obra/superpowers/tree/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/systematic-debugging) | Existing local tree; all 11 files matched upstream |
| `supabase-postgres-best-practices` | [supabase/agent-skills@c9be0e93](https://github.com/supabase/agent-skills/tree/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices) | Existing local tree; all 36 files matched upstream |

[Source manifest](../.agents/skill-sources.json) records full commit/tree IDs, original paths and SHA-256 hashes (UTF-8, LF line endings). Each skill carries its upstream MIT `LICENSE`; those licenses apply to the vendored skills, not the application. Original attribution and supporting resources are preserved. The sole host adaptation replaces Grill Me's Claude `Skill`-tool call with a relative link to `grilling/SKILL.md` in the Codex copy. Synchronization restores the original Claude entry point. Its upstream `disable-model-invocation: true` and `agents/openai.yaml` policy keep `grill-me` explicit-only on both hosts.

The two additional skills retain all supporting files; their descriptions are narrowed for focused discovery. Systematic Debugging's four phases are preserved, with its two Superpowers TDD/verification calls mapped to existing repository tests and verification, so no extra skills are required. Postgres guidance applies without Supabase; read relevant rules on demand. The optional upstream `find-polluter.sh` helper requires Bash and a suitable test command; it is not run automatically. Licenses were retrieved from the pinned official revisions.

Treat `.agents/skills/` as canonical. After reviewing a local edit or upstream update, update the affected hashes and provenance in the manifest, then run from the repository root:

```cmd
node scripts/sync-agent-skills.mjs
node scripts/sync-agent-skills.mjs --check
```

The dependency-free Node script copies only the seven manifest-listed skills and checks their recorded resources and hashes. It rejects unexpected files in a managed skill directory instead of deleting them. `--check` is read-only and detects drift, missing resources and links. Frontmatter must also be validated with a YAML parser or the host loader after an update; hash checks alone do not validate YAML or model behavior.

To reuse this setup in another repository, copy both skill trees, the manifest and sync script, then merge the routing section and Claude import into that repository's own instructions. Preserve that repository's domain rules. No global skill installation or network access is needed for synchronization. Retrieve future source updates only from the official repositories above; review them before updating pins.

### Discovery and behavioral checks

The setup machine has global `ponytail`, `grilling`, `systematic-debugging` and `supabase-postgres-best-practices` under `~/.agents/skills/`, with existing Claude junctions. Plugin caches also contain Systematic Debugging in Superpowers and Postgres Best Practices in Supabase. Global configuration remains unchanged. [Codex can list duplicate names](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills), and [Claude's name resolution depends on scope](https://code.claude.com/docs/en/skills#where-skills-live); do not assume repository precedence or load a plugin equivalent alongside its local copy. Shared routing tells agents to read the local file explicitly if needed.

In a fresh session launched from this repository, inspect Codex's skill selector (or app-server `skills/list` with this checkout in `cwds` and `forceReload: true`), and Claude Code's `/` command menu. Confirm all seven skills, including `grill-me`, and inspect the resolved local paths. Use Claude's `/memory` to confirm that `AGENTS.md` is imported. Hosts may cache skills until the next turn or a fresh session. Discovery alone does not prove conditional activation; check these cases without changing application files:

| Request | Expected routing |
| --- | --- |
| "Plan a change to refund allocation; the rounding and lock trade-offs are unresolved." | Inspect domain docs, then `grilling`; recommendations and confirmation before implementation |
| "Implement this agreed non-trivial change with these acceptance criteria." | `ponytail`, relevant domain skills/checks, then `ponytail-review`; no redundant interview |
| "Review this change and its affected callers." | `ponytail-review` plus applicable domain review; report findings before fixes |
| "Audit the repository's correctness and complexity." | `ponytail-audit`; report only |
| `$grill-me` in Codex or `/grill-me` in Claude Code | Explicit entry point delegates to `grilling` |
| "Fix this spelling error in the README." | Direct edit and proportionate verification; no interview or audit |
| "Investigate a recurring test failure whose cause is unknown." | `systematic-debugging` as the investigation skill; reproduce, test hypotheses and verify a regression |
| "Correct this typo; the exact cause is already established." | Direct fix; no debugging investigation or Postgres skill |
| "Review this PostgreSQL query plan, index or transaction lock order." | `supabase-postgres-best-practices`, only relevant references; repository financial rules and database verification still govern |
| "Update a dashboard label without touching SQL." | No debugging or Postgres skill |

Setup verification on **2026-10-20**:

- Parsed all ten skill frontmatters and both hosts' metadata with the existing workspace YAML parser; names, descriptions, explicit-only policy, relative references and MIT notices passed. Reconstructed the five Claude skill Git trees (excluding the separately packaged licenses); all exactly matched the pinned upstream trees. Codex differs only in the documented Grill Me delegate.
- `node scripts/sync-agent-skills.mjs --check`, Node syntax checking and Git whitespace checks passed. Isolated sync fixtures verified initial creation, drift/missing-file detection and repair, rejection of unrecorded source edits, preservation of unexpected target files, and Windows CRLF handling. Repository skill trees contain no links.
- Codex desktop binary `0.163.0-alpha.10.2`: initialization plus app-server `skills/list` with `forceReload: true` returned all five enabled repository paths and no discovery errors. It also returned the existing user copies of Ponytail and Grilling.
- Claude Code `2.1.114`: initialization through its streaming control protocol returned all five `(project)` commands, including explicit `grill-me`, plus the two existing `(user)` copies. This probe disabled hooks and MCP for that process and sent no model prompt. Initial sandboxed host probes timed out; the same read-only initialization probes passed with local host access permitted.
- Compared `AGENTS.md` with its previous content after removing the new section: exact match. Claude-specific guidance and the existing work loop/payment checklist are retained. No application checks were run for this configuration-only change.
- Independent read-only `ponytail-review` found no blocking findings. It confirmed the six routing cases and seven isolated sync cases, including nested resources and reviewed source updates. Windows denied creation of a junction fixture (`EPERM`), so rejection of links was inspected rather than experimentally established.

Two-skill extension verification on **2026-10-20**: both installed hosts returned all seven repository skills, including the two new project commands. All 14 frontmatters, source/resource integrity checks, synchronization and whitespace checks passed. The new packages contain 12 and 37 files per host respectively, including licenses and all upstream support files. All 47 locally installed source files matched pinned official Git blobs; reversing the recorded entry-point adaptations reproduces those blobs in both copies. Independent read-only review found no concrete findings and confirmed the focused routing cases. The original five skills, Claude import, sync script and existing application changes remain unchanged. The Bash helper was not executed.

The host discovery checks above establish loading, not model compliance. Fresh interactive sessions still need the import/path and conditional-activation spot checks above; no end-to-end model interview, implementation or audit is claimed by this setup.

## Handoff

Report what was inspected, changed and executed; show failures and missing evidence plainly. Link the source-of-truth document and propose the next focused audit. Do not convert a configured CI job into a passed CI claim or a seeded dashboard into an end-to-end provider demo.
