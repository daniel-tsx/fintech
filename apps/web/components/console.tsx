import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatMoney, formatTime } from '@/lib/api';

export function Wordmark() {
  return <span className="wordmark"><span aria-hidden className="wordmark-mark">FL</span><span>fintech-lab<small>payment trace system</small></span></span>;
}

export function EvidencePane({ label, title, action, children, className = '' }: { label: string; title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`evidence-pane ${className}`}><header><div><span className="micro-label">{label}</span><h2>{title}</h2></div>{action}</header><div className="pane-body">{children}</div></section>;
}

export function Status({ value }: { value: string }) {
  const kind = /FAILED|DEAD|DECLINED|LOST/.test(value) ? 'failed' : /PENDING|PROCESSING|REQUIRES|DISPUTED|OPEN/.test(value) ? 'held' : /SUCCEEDED|CAPTURED|AUTHORIZED|PROCESSED|POSTED|RESOLVED|REFUNDED/.test(value) ? 'verified' : 'neutral';
  return <span className={`status status-${kind}`}><span aria-hidden />{value.replaceAll('_', ' ').toLowerCase()}</span>;
}

export interface Balance { currency: string; pending: string; available: string }
export function BalanceStrip({ balances }: { balances: Balance[] }) {
  const balance = balances[0] ?? { currency: 'USD', pending: '0', available: '0' };
  return <div className="balance-strip" aria-label="Merchant balances">
    <div className="balance-primary"><span className="micro-label">available / {balance.currency}</span><strong>{formatMoney(balance.available, balance.currency)}</strong><small>eligible for payout</small></div>
    <div><span className="micro-label">pending / {balance.currency}</span><strong>{formatMoney(balance.pending, balance.currency)}</strong><small>awaiting settlement</small></div>
    <div><span className="micro-label">rail state</span><strong className="text-value">Operational</strong><small><i className="live-dot" aria-hidden /> inbox + outbox active</small></div>
  </div>;
}

export interface TraceItem { label: string; detail: string; at?: string | null; state: 'done' | 'active' | 'waiting' | 'failed' }
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

export function DataTable({ columns, rows, empty }: { columns: Array<{ key: string; label: string; align?: 'right' }>; rows: Array<Record<string, ReactNode>>; empty: string }) {
  if (!rows.length) return <p className="inline-empty">{empty}</p>;
  return <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column.key} className={column.align === 'right' ? 'align-right' : ''}>{column.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{columns.map((column) => <td key={column.key} className={column.align === 'right' ? 'align-right numeric' : ''}>{row[column.key]}</td>)}</tr>)}</tbody></table></div>;
}

export function PageHeading({ eyebrow, title, children, action }: { eyebrow: string; title: string; children: ReactNode; action?: ReactNode }) {
  return <header className="page-heading"><div><span className="micro-label">{eyebrow}</span><h1>{title}</h1><p>{children}</p></div>{action}</header>;
}

export function PaymentLink({ id }: { id: string }) { return <Link className="mono-link" href={`/payments/${id}`}>{id.slice(0, 8)}…</Link>; }
