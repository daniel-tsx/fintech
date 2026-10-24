'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const ref = useRef<HTMLAnchorElement>(null);
  const current = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
  // On phones the nav is one scrolling row; keep the current section visible. A no-op in the desktop sidebar.
  useEffect(() => { if (current) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [current]);
  return <Link ref={ref} href={href} aria-current={current ? 'page' : undefined}>{label}</Link>;
}
