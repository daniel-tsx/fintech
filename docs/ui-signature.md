# UI signature: clearing ledger

Status: current. Owner: visual conventions of the `apps/web` inspection dashboard. Tokens live at the top of [`globals.css`](../apps/web/app/globals.css); components in [`console.tsx`](../apps/web/components/console.tsx).

The dashboard reads like a bound ledger held inside deep-ink navigation chrome: ruled hairlines, square panes, a fixed column grid and numerals set like a bank statement. Colour is reserved for money state; everything else is ink on paper. The `TraceRail` keeps one payment's lifecycle on a single line, and `BalanceStrip` / `fact-strip` hold key figures in one divided row.

Users are engineers and operators looking for a record, its state and its amounts. Findability and legibility beat decoration.

## Page structure

Every page uses the same order: `PageHeading` (mono eyebrow, 20px title, one-line description), then key figures when the page has them, then one or more `EvidencePane`s holding tables or traces. The sidebar marks the current section with `aria-current="page"`; a skip link jumps to `main`. Below 720px the sidebar becomes a top bar (see [Responsive behaviour](#responsive-behaviour)).

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

## Money and time

[`lib/format.ts`](../apps/web/lib/format.ts) is the only formatter, covered by `lib/format.test.ts`.

- Amounts arrive as integer minor units and are converted with string arithmetic and `BigInt`, never floating point. Exponents follow Stripe: zero-decimal (`JPY`, `KRW`, `VND`, `CLP` …), three-decimal (`BHD`, `JOD`, `KWD`, `OMR`, `TND`), otherwise two. A value that is not an integer string is shown raw rather than guessed.
- Tables carry a `Ccy` column and show the bare amount (`Amount`, raw minor units on hover). Elsewhere money reads `USD 1,234.56`; ISO codes avoid ambiguous symbols.
- Times read `2026-10-24 07:15:36 UTC` everywhere, with seconds so events in the same minute keep their order.

## Finding records

- Every register follows the same order: search box (plus currency where records have one), facet chips with counts, a one-line summary, then the table. Filters, sort and page live in the URL, so views are shareable and work without JS; `next/form` keeps navigation client-side when JS is present.
- Filters apply to the rows the API returned, and the summary says so (for example "the API returns the latest 200"); payments page through the API 100 at a time. The ledger currency filter is passed to the API.
- Sortable headers are links with `aria-sort`. The default is newest first, the API's own order. Money sorts within a currency: by currency code, then exact minor units.
- `IdCell` shows a short identifier, keeps the full value in the title and for screen readers, links payments to their trace and has a copy button.
- The command palette (`/`, Ctrl/⌘+K, or the sidebar button) opens a payment from a full UUID, searches any register, or jumps to a page.
- The ledger groups lines by journal with debit and credit totals. When the API's 500-line limit is reached, the oldest journal is marked as possibly incomplete instead of showing a misleading total.
- A filtered list with no rows says so and offers "Clear filters"; an empty register describes the next event that will fill it.

## Detail and overview

- **Payment detail** reads top to bottom: heading (full ID with copy, state, amount, link to its audit entries), the five amounts, then *Lifecycle* (the `TraceRail` built from audit events) beside *Where the money is*, then attempts, refunds, journals (`JournalTable`, shared with the ledger) and related disputes and reconciliation issues.
- *Where the money is* lists authorized, captured and refunded amounts from the API. Settled and paid out show "not reported", because the payment API does not link a payment to a settlement batch or payout; the UI never infers them.
- The trace ends with an active step only while the workflow is open. `REQUIRES_AUTHORIZATION` and `CAPTURE_PENDING` read "outcome unknown … not a failure".
- Audit metadata is shown as `key value` pairs; `amount`, `gross`, `fee` and `net` are treated as minor units and formatted in the record's currency.
- A malformed or unknown payment ID renders the 404 page, not an error.
- **Overview** shows one balance strip per currency (available: settled, eligible for payout; pending: captured, awaiting settlement), the latest payments, and an attention list counted from real records (dead, retrying or exception webhook events, open reconciliation issues, open disputes), each linking to the filtered register. It states which records it checked and which could not be loaded; there is no derived "system healthy" claim.

## Density, shape and motion

- Table cells pad 8px × 12px (about 34px rows); panes use 2px corners and 1px rules, no drop shadows.
- Spacing steps of 4px (`--space-1` … `--space-7`).
- Content stops widening at 1680px so rows stay readable on large screens.

## Motion

Motion is 120–180ms ease-out and only explains a change:

- **Loading → content:** a route's content settles in once (fade and 4px rise). Filter, sort and page changes re-render in place without it, so results never flicker.
- **Loading:** skeleton bars pulse while a route's data loads.
- **Waiting:** the active step of an open workflow (the last `TraceRail` node) pulses slowly.
- **Palette:** opens with a short fade; hover and current states ease their colour.

`prefers-reduced-motion: reduce` removes every animation and transition, and content appears in its final state.

## Responsive behaviour

- Below 980px the paired panes stack. Below 720px the sidebar becomes a top bar: brand, palette button and one horizontally scrolling row of links with edge shadows; the current link scrolls into view.
- Wide tables scroll sideways inside their pane, with edge shadows showing more columns. On phones the first column (the record's ID or time) stays pinned, so a row stays identifiable while scrolling.
- Pages reflow without horizontal page scrolling down to 320px.

## Accessibility

- Text contrast is at least 4.5:1 everywhere (secondary text about 6:1); form control edges are at least 3:1 (`--rule-control`). Checked on rendered pages, not only on tokens.
- Every interactive element is reachable by keyboard and shows a 2px accent focus ring (the chrome accent in the sidebar). Targets are at least 24×24px.
- Status, current page and selection never rely on colour alone: glyph plus label for status, `aria-current`/`aria-selected` plus a visual mark; in Windows high-contrast mode those marks become outlines.
- Tables have captions and column scopes; sortable headers expose `aria-sort`; the palette follows the combobox pattern; shortened IDs carry the full value for screen readers.

## States

Empty states name the next financial event that will appear. The offline state lists the local commands to start the stack. Loading skeletons keep the heading and pane geometry. Error screens say the underlying record was not changed and how to retry.
