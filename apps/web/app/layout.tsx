import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { Sidebar } from '@/components/sidebar';
import './globals.css';

// Self-hosted IBM Plex (latin, OFL-1.1, see ./fonts) so builds never depend on Google Fonts.
const sans = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex-sans',
});
const mono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-plex-mono',
});

export const metadata: Metadata = { title: { default: 'fintech-lab', template: '%s · fintech-lab' }, description: 'A local payment engineering laboratory for tracing money and state.' };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en" className={`${sans.variable} ${mono.variable}`}><body><a className="skip-link" href="#main">Skip to content</a><div className="app-shell"><Sidebar /><main id="main" tabIndex={-1}>{children}</main></div></body></html>;
}
