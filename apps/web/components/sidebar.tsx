import Link from 'next/link';
import { Wordmark } from './console';

const groups = [
  { label: 'flow', items: [['Overview', '/'], ['Payments', '/payments'], ['Ledger', '/ledger']] },
  { label: 'money movement', items: [['Settlements', '/settlements'], ['Payouts', '/payouts'], ['Disputes', '/disputes']] },
  { label: 'control plane', items: [['Webhooks', '/webhooks'], ['Reconciliation', '/reconciliation'], ['Audit trail', '/audit']] },
];

export function Sidebar() {
  return <aside className="sidebar"><Link href="/" className="brand-link"><Wordmark /></Link><nav>{groups.map((group) => <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}</div>)}</nav><footer><span><i className="live-dot" aria-hidden /> External PSP lab</span><small>Stripe-shaped · no real money</small></footer></aside>;
}
