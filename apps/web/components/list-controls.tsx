import Form from 'next/form';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { hrefWith, param, type SearchParams } from '@/lib/list';

export interface Facet { name: string; label: string; options: Array<{ value: string; count: number }>; render?: (value: string) => ReactNode }

/**
 * Search box, optional currency select and facet chips, all kept in the URL.
 * `next/form` navigates client-side when JS is available and submits a plain GET otherwise.
 */
export function ListControls({ path, params, search, facets = [], currencies, summary }: { path: string; params: SearchParams; search: string; facets?: Facet[]; currencies?: string[]; summary: ReactNode }) {
  const filterKeys = ['q', 'currency', ...facets.map((facet) => facet.name)];
  const filtered = filterKeys.some((key) => param(params, key));
  const kept = [...facets.map((facet) => facet.name), 'sort', 'dir'].filter((key) => param(params, key));
  const currency = param(params, 'currency');
  const currencyOptions = currency && currencies && !currencies.includes(currency) ? [...currencies, currency] : currencies;
  return <div className="list-controls">
    <Form action={path} className="filter-form" role="search">
      {kept.map((key) => <input key={key} type="hidden" name={key} value={param(params, key)} />)}
      <input type="search" name="q" defaultValue={param(params, 'q')} placeholder={search} aria-label={search} />
      {currencyOptions && <select name="currency" defaultValue={currency ?? ''} aria-label="Currency"><option value="">Any currency</option>{currencyOptions.map((code) => <option key={code} value={code}>{code}</option>)}</select>}
      <button type="submit">Apply</button>
      {filtered && <Link className="clear-link" href={path}>Clear filters</Link>}
    </Form>
    {facets.map((facet) => {
      const selected = param(params, facet.name);
      const options = selected && !facet.options.some((option) => option.value === selected) ? [...facet.options, { value: selected, count: 0 }] : facet.options;
      const total = facet.options.reduce((sum, option) => sum + option.count, 0);
      return <nav key={facet.name} className="facet" aria-label={facet.label}>
        <Link href={hrefWith(path, params, { [facet.name]: undefined, page: undefined })} aria-current={selected ? undefined : 'true'}>All <span className="count">{total}</span></Link>
        {options.map((option) => <Link key={option.value} href={hrefWith(path, params, { [facet.name]: option.value, page: undefined })} aria-current={selected === option.value ? 'true' : undefined}>
          {facet.render ? facet.render(option.value) : option.value.replaceAll('_', ' ').toLowerCase()} <span className="count">{option.count}</span>
        </Link>)}
      </nav>;
    })}
    <p className="list-summary" role="status">{summary}</p>
  </div>;
}

/** Empty message for a filtered list, with a way back. */
export function NoMatches({ noun, path }: { noun: string; path: string }) {
  return <>No {noun} match these filters. <Link className="mono-link" href={path}>Clear filters</Link></>;
}
