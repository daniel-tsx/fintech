'use client';
import { useState } from 'react';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions, insecure origin); the full ID stays readable in the title.
    }
  }
  return <button type="button" className="copy-button" onClick={copy} title={`Copy ${value}`} aria-label={copied ? `${label} copied` : `Copy ${label}`}>
    <span aria-hidden>{copied ? '✓' : <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"><rect x="3.5" y="3.5" width="7" height="7" /><path d="M1.5 8.5v-7h7" /></svg>}</span>
  </button>;
}
