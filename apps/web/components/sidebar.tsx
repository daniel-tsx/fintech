import Link from 'next/link';
import { Wordmark } from './console';
import { NavLink } from './nav-link';

const groups = [
  { label: 'flow', items: [['Overview', '/'], ['Payments', '/payments'], ['Ledger', '/ledger']] },
  { label: 'money movement', items: [['Settlements', '/settlements'], ['Payouts', '/payouts'], ['Disputes', '/disputes']] },
  { label: 'control plane', items: [['Webhooks', '/webhooks'], ['Reconciliation', '/reconciliation'], ['Audit trail', '/audit']] },
];

export function Sidebar() {
  return <aside className="sidebar"><Link href="/" className="brand-link"><Wordmark /></Link><nav aria-label="Main">{groups.map((group) => <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map(([label, href]) => <NavLink key={href} href={href} label={label} />)}</div>)}</nav><footer><span>External PSP lab</span><span>Stripe-shaped · no real money</span></footer></aside>;
}
