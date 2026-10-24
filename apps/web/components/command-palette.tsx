'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { navGroups } from '@/lib/nav';

const pages = navGroups.flatMap((group) => group.items);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function results(query: string): Array<{ label: string; href: string }> {
  const q = query.trim();
  const jump = uuid.test(q) ? [{ label: `Open payment ${q}`, href: `/payments/${q.toLowerCase()}` }] : [];
  const searches = q ? pages.filter(([, href]) => href !== '/').map(([label, href]) => ({ label: `Search ${label.toLowerCase()} for “${q}”`, href: `${href}?q=${encodeURIComponent(q)}` })) : [];
  const goTo = pages.filter(([label]) => label.toLowerCase().includes(q.toLowerCase())).map(([label, href]) => ({ label: `Go to ${label}`, href }));
  return [...jump, ...goTo, ...searches];
}

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** `/` or Ctrl/⌘+K: jump to a payment by full ID, search a register, or go to a page. */
export function CommandPalette() {
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const items = results(query);

  function open() {
    setQuery('');
    setActive(0);
    dialog.current?.showModal();
  }
  function go(href: string) {
    dialog.current?.close();
    router.push(href);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const shortcut = (event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing(event.target));
      if (!shortcut || !dialog.current || dialog.current.open) return;
      event.preventDefault();
      setQuery('');
      setActive(0);
      dialog.current.showModal();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function onInputKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1));
    } else if (event.key === 'Enter' && items[active]) {
      event.preventDefault();
      go(items[active].href);
    }
  }

  return <>
    <button type="button" className="palette-trigger" onClick={open} aria-keyshortcuts="/ Control+K Meta+K">
      <span>Search or jump to ID</span><kbd aria-hidden>/</kbd>
    </button>
    <dialog ref={dialog} className="palette" aria-label="Search and jump" onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
      <input
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-results"
        aria-activedescendant={items[active] ? `palette-option-${active}` : undefined}
        aria-autocomplete="list"
        aria-label="Payment ID, reference or page"
        placeholder="Payment ID, reference or page"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={onInputKey}
      />
      <ul id="palette-results" role="listbox" aria-label="Results">
        {items.map((item, index) => <li key={item.href} id={`palette-option-${index}`} role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)} onClick={() => go(item.href)}>{item.label}</li>)}
        {!items.length && <li className="palette-empty" role="presentation">No page matches. Paste a full payment ID to open it.</li>}
      </ul>
      <p className="palette-hint" aria-hidden>↑ ↓ to move · Enter to open · Esc to close</p>
    </dialog>
  </>;
}
