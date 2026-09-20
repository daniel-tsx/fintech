import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Sidebar } from '@/components/sidebar';
import './globals.css';

export const metadata: Metadata = { title: { default: 'fintech-lab', template: '%s · fintech-lab' }, description: 'A local payment engineering laboratory for tracing money and state.' };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en"><body><div className="app-shell"><Sidebar /><main>{children}</main></div></body></html>;
}
