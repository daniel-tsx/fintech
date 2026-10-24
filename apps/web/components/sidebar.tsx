import Link from 'next/link';
import { navGroups } from '@/lib/nav';
import { CommandPalette } from './command-palette';
import { Wordmark } from './console';
import { NavLink } from './nav-link';

export function Sidebar() {
  return <aside className="sidebar"><Link href="/" className="brand-link"><Wordmark /></Link><CommandPalette /><nav aria-label="Main">{navGroups.map((group) => <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map(([label, href]) => <NavLink key={href} href={href} label={label} />)}</div>)}</nav><footer><span>External PSP lab</span><span>Stripe-shaped · no real money</span></footer></aside>;
}
