import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatAmount, formatMoney, formatTime } from '@/lib/format';
import { currentSort, hrefWith, type SearchParams } from '@/lib/list';
import { describeStatus, glyphs, type StatusOf, type Tone } from '@/lib/status';
import { CopyButton } from './copy-button';

export function Wordmark() {
  return <span className="wordmark"><span aria-hidden className="wordmark-mark">FL</span><span>fintech-lab<small>payment trace system</small></span></span>;
}

export function EvidencePane({ label, title, action, children, className = '' }: { label: string; title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`evidence-pane ${className}`}><header><div><span className="micro-label">{label}</span><h2>{title}</h2></div>{action}</header><div className="pane-body">{children}</div></section>;
}

export function Status({ value, of }: { value: string; of?: StatusOf }) {
  const { tone, label } = describeStatus(value, of);
  return <Chip tone={tone} label={label} title={value} />;
}

/** A status chip for states that are not a raw API value (for example "not reported"). */
export function Chip({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  return <span className={`status tone-${tone}`} title={title}><span aria-hidden>{glyphs[tone]}</span>{label}</span>;
}

export interface Balance { currency: string; pending: string; available: string }
/** One strip per currency. Pending (captured, not settled) and available (settled, not paid out) never merge. */
export function BalanceStrip({ balances }: { balances: Balance[] }) {
  if (!balances.length) return <p className="inline-empty balance-empty">No balance yet. A confirmed capture creates pending money.</p>;
  return <div className="balance-list">{balances.map((balance) => <div key={balance.currency} className="balance-strip" aria-label={`${balance.currency} balances`}>
    <div className="balance-primary"><span className="micro-label">available · {balance.currency}</span><strong title={`${balance.available} minor units`}>{formatMoney(balance.available, balance.currency)}</strong><small>settled, eligible for payout</small></div>
    <div><span className="micro-label">pending · {balance.currency}</span><strong title={`${balance.pending} minor units`}>{formatMoney(balance.pending, balance.currency)}</strong><small>captured, awaiting settlement</small></div>
  </div>)}</div>;
}

export interface TraceItem { label: string; detail: ReactNode; at?: string | null; state: 'done' | 'active' | 'waiting' | 'failed' }
export function TraceRail({ items }: { items: TraceItem[] }) {
  return <ol className="trace-rail" aria-label="Payment lifecycle">
    {items.map((item, index) => <li key={`${item.label}-${index}`} className={`trace-${item.state}`}>
      <span className="trace-node" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
      <div><strong>{item.label}</strong><p>{item.detail}</p></div><time>{formatTime(item.at)}</time>
    </li>)}
  </ol>;
}

export function EmptyTrace({ noun, promise }: { noun: string; promise: string }) {
  return <div className="empty-trace"><span className="empty-coordinate" aria-hidden>00 — 00</span><h3>No {noun} recorded yet</h3><p>{promise}</p></div>;
}

export function ConnectionState() {
  return <div className="connection-state"><span className="micro-label">local systems offline</span><h1>The trace desk is waiting for a signal.</h1><p>Start PostgreSQL and Redis, run migrations and seed data, then launch the API and worker. This surface will fill with real local workflow state.</p><code>docker compose up -d · pnpm db:migrate · pnpm db:seed · pnpm dev</code></div>;
}

export interface Column { key: string; label: string; align?: 'right'; mono?: boolean; sortable?: boolean }

/** Server-rendered table. Sorting is a link per header, so it works without JS and is shareable. */
export function DataTable({ columns, rows, empty, caption, sort }: { columns: Column[]; rows: Array<Record<string, ReactNode>>; empty: ReactNode; caption?: string; sort?: { path: string; params: SearchParams; defaultKey: string } }) {
  if (!rows.length) return <p className="inline-empty">{empty}</p>;
  const current = sort && currentSort(sort.params, sort.defaultKey);
  const header = (column: Column) => {
    if (!sort || !current || !column.sortable) return column.label;
    const active = current.key === column.key;
    const next = active && current.dir === 'desc' ? 'asc' : 'desc';
    return <Link className="sort-link" href={hrefWith(sort.path, sort.params, { sort: column.key, dir: next === 'asc' ? 'asc' : undefined })}>{column.label}<span aria-hidden>{active ? (current.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕'}</span></Link>;
  };
  const ariaSort = (column: Column) => current?.key === column.key && column.sortable ? (current.dir === 'asc' ? 'ascending' : 'descending') : undefined;
  const cellClass = (column: Column) => column.align === 'right' ? 'align-right numeric' : column.mono ? 'numeric' : undefined;
  return <div className="table-scroll"><table>{caption && <caption className="sr-only">{caption}</caption>}<thead><tr>{columns.map((column) => <th key={column.key} scope="col" className={column.align === 'right' ? 'align-right' : undefined} aria-sort={ariaSort(column)}>{header(column)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={typeof row.key === 'string' ? row.key : typeof row.id === 'string' ? row.id : index}>{columns.map((column) => <td key={column.key} className={cellClass(column)}>{row[column.key]}</td>)}</tr>)}</tbody></table></div>;
}

/** Shortened identifier with the full value in the title, for screen readers, and one click from the clipboard. */
export function IdCell({ id, href, label = 'ID' }: { id: string; href?: string; label?: string }) {
  const short = id.length <= 20 ? id : `${id.slice(0, /^[0-9a-f]{8}-/i.test(id) ? 8 : 18)}…`;
  return <span className="id-cell">{href
    ? <Link className="mono-link" href={href} title={id} aria-label={`${label} ${id}`}>{short}</Link>
    : <span className="mono" title={id}><span aria-hidden>{short}</span><span className="sr-only">{id}</span></span>}<CopyButton value={id} label={`${label} ${id}`} /></span>;
}

/** Exact amount without currency (tables carry a currency column); raw minor units on hover. */
export function Amount({ value, currency }: { value: string; currency: string }) {
  return <span title={`${value} minor units`}>{formatAmount(value, currency)}</span>;
}

export function PageHeading({ eyebrow, title, children, action }: { eyebrow: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <header className="page-heading"><div><span className="micro-label">{eyebrow}</span><h1>{title}</h1><p>{children}</p></div>{action}</header>;
}

export function PaymentLink({ id }: { id: string }) { return <IdCell id={id} href={`/payments/${id}`} label="Payment" />; }
