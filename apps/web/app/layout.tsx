import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import { Sidebar } from '@/components/sidebar';
import './globals.css';

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex-sans' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono' });

export const metadata: Metadata = { title: { default: 'fintech-lab', template: '%s · fintech-lab' }, description: 'A local payment engineering laboratory for tracing money and state.' };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en" className={`${sans.variable} ${mono.variable}`}><body><a className="skip-link" href="#main">Skip to content</a><div className="app-shell"><Sidebar /><main id="main" tabIndex={-1}>{children}</main></div></body></html>;
}
