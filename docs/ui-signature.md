# UI signature: clearing ledger

Status: current. Owner: visual conventions of the `apps/web` inspection dashboard. Tokens live at the top of [`globals.css`](../apps/web/app/globals.css); components in [`console.tsx`](../apps/web/components/console.tsx).

The dashboard reads like a bound ledger held inside deep-ink navigation chrome: ruled hairlines, square panes, a fixed column grid and numerals set like a bank statement. Colour is reserved for money state; everything else is ink on paper. The `TraceRail` keeps one payment's lifecycle on a single line, and `BalanceStrip` / `fact-strip` hold key figures in one divided row.

Users are engineers and operators looking for a record, its state and its amounts. Findability and legibility beat decoration.

## Page structure

Every page uses the same order: `PageHeading` (mono eyebrow, 20px title, one-line description), then key figures when the page has them, then one or more `EvidencePane`s holding tables or traces. The sidebar marks the current section with `aria-current="page"`; a skip link jumps to `main`. Below 720px the sidebar becomes a top bar with one horizontally scrolling row of links.

## Type

- IBM Plex Sans for interface text and IBM Plex Mono for amounts, identifiers, timestamps and eyebrow labels, loaded with `next/font/google` (self-hosted at build time; no runtime request to Google).
- Scale: 11 / 12 / 13 / 15 / 20 / 28px (`--text-xs` … `--text-2xl`). Body and table text is 13px. Nothing renders below 11px.
- Numerals use `font-variant-numeric: tabular-nums`; money columns align right.

## Colour

| Token | Use |
| --- | --- |
| `--paper`, `--surface`, `--surface-sunk` | Page, pane body, pane header |
| `--ink`, `--ink-2` | Primary and secondary text (secondary ≥ 6:1 on every surface) |
| `--rule`, `--rule-strong` | Row hairlines, pane borders |
| `--accent` | Links, focus ring, current trace step. Not used for status |
| `--chrome*` | Navigation rail |

## Status system

`Status` is the only way a state is rendered. Each tone has a glyph, a label and a hue, so meaning never depends on colour alone; the raw API value is the `title`.

| Tone | Glyph | Values |
| --- | --- | --- |
| authorized | ○ | `AUTHORIZED` |
| captured | ◐ | `CAPTURED` |
| settled | ● | settlement `SUCCEEDED`, labelled "settled" |
| paid out | ■ | payout `SUCCEEDED`, labelled "paid out" |
| refunded | ↺ | `REFUNDED`, `PARTIALLY_REFUNDED`, refund `SUCCEEDED` |
| pending | … (dashed) | `PENDING`, `PROCESSING`, `REQUIRES_AUTHORIZATION`, `CAPTURE_PENDING`, `IN_PROGRESS`; provider attempt/refund `PROCESSING` reads "processing · outcome unknown" |
| attention | ▲ | `DISPUTED`, `OPEN`, `RETRY`, `ACCOUNTING_EXCEPTION`, `HIGH`/`CRITICAL` severity |
| failed | ✕ | `FAILED`, `DEAD`, `MERCHANT_LOST` |
| done | ✓ | Non-money success: attempt `SUCCEEDED`, `PROCESSED`, `POSTED`, `PUBLISHED`, `RESOLVED`, `CLOSED`, `MERCHANT_WON` |
| neutral | — | `CREATED`, `CANCELLED`, `IGNORED`, anything unmapped |

Rules the UI must not blur:

- Captured, settled and paid out are different tones and glyphs. A record type whose raw value is generic (`SUCCEEDED`) passes `of` so it renders as its money state.
- An unknown or in-flight provider outcome is pending, never success or failure.
- Business types (capture, refund, settlement) are labels, not statuses.

## Density, shape and motion

- Table cells pad 8px × 12px (about 34px rows); panes use 2px corners and 1px rules, no drop shadows.
- Spacing steps of 4px (`--space-1` … `--space-7`).
- Motion is 120–180ms ease-out and only explains change (hover, current item). `prefers-reduced-motion` turns all transitions and animations off.

## States

Empty states name the next financial event that will appear. The offline state lists the local commands to start the stack. Loading skeletons keep the heading and pane geometry. Error screens say the underlying record was not changed and how to retry.
