import { api, offline } from '@/lib/api';
import { formatAmount, formatTime } from '@/lib/format';
import { countBy, matches, param, type SearchParams } from '@/lib/list';
import { Amount, ConnectionState, EvidencePane, IdCell, PageHeading } from '@/components/console';
import { ListControls, NoMatches } from '@/components/list-controls';

interface Entry { transactionId: string; businessType: string; businessId: string; description: string; currency: string; postedAt: string; accountCode: string; accountType: string; debit: string; credit: string }
interface Journal { id: string; head: Entry; lines: Entry[] }

const API_LIMIT = 500; // ledger/entries returns at most this many lines
export const dynamic = 'force-dynamic';

function sum(values: string[]): string {
  return values.reduce((total, value) => total + BigInt(value), BigInt(0)).toString();
}

export default async function LedgerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const currency = param(params, 'currency');
  const entries = await api<Entry[]>(`/ledger/entries${currency ? `?currency=${encodeURIComponent(currency)}` : ''}`).catch(offline);
  if (!entries) return <ConnectionState />;

  const journals = new Map<string, Journal>();
  for (const entry of entries) {
    const journal = journals.get(entry.transactionId) ?? { id: entry.transactionId, head: entry, lines: [] };
    journal.lines.push(entry);
    journals.set(entry.transactionId, journal);
  }
  const all = [...journals.values()];
  const q = param(params, 'q'), type = param(params, 'type');
  const base = all.filter((j) => matches(q, [j.id, j.head.businessId, j.head.description, ...j.lines.map((l) => l.accountCode)]));
  const shown = base.filter((j) => !type || j.head.businessType === type);
  // The API limit counts lines, so the oldest journal returned can be cut short.
  const truncated = entries.length >= API_LIMIT ? all.at(-1)?.id : undefined;

  return <>
    <PageHeading eyebrow="double-entry source of truth" title="Ledger">Posted journals are immutable. Every transaction must balance within one currency.</PageHeading>
    <ListControls path="/ledger" params={params} search="Search journal, business reference, description or account"
      currencies={[...new Set(entries.map((e) => e.currency))].sort()}
      facets={[{ name: 'type', label: 'Filter by business event', options: countBy(base, (j) => j.head.businessType) }]}
      summary={`${shown.length} of ${all.length} journals (${entries.length} lines${entries.length >= API_LIMIT ? `, the API limit of ${API_LIMIT}` : ''}) · newest first${currency ? ` · ${currency} only` : ''}`} />
    <EvidencePane label="journal register" title="Journals">
      {!shown.length ? <p className="inline-empty">{all.length ? <NoMatches noun="journals" path="/ledger" /> : 'No ledger entries yet. A confirmed capture will post the first balanced journal.'}</p> :
        <div className="table-scroll"><table className="journal-table">
          <caption className="sr-only">Journals with their entries and totals</caption>
          <thead><tr><th scope="col">Account</th><th scope="col">Type</th><th scope="col" className="align-right">Debit</th><th scope="col" className="align-right">Credit</th></tr></thead>
          {shown.map(({ id, head, lines }) => {
            const debit = sum(lines.map((l) => l.debit)), credit = sum(lines.map((l) => l.credit));
            return <tbody key={id}>
              <tr className="journal-head"><th scope="rowgroup" colSpan={4}>
                <span className="journal-type">{head.businessType.replaceAll('_', ' ').toLowerCase()}</span>
                <span>{head.description}</span>
                <span className="journal-meta">ref <IdCell id={head.businessId} label="Business reference" /> · journal <IdCell id={id} label="Journal" /> · <span className="mono">{head.currency}</span> · <span className="mono">{formatTime(head.postedAt)}</span></span>
              </th></tr>
              {lines.map((line, index) => <tr key={index}>
                <td>{line.accountCode.replaceAll('_', ' ').toLowerCase()}</td>
                <td>{line.accountType.toLowerCase()}</td>
                <td className="align-right numeric">{BigInt(line.debit) ? <Amount value={line.debit} currency={line.currency} /> : '—'}</td>
                <td className="align-right numeric">{BigInt(line.credit) ? <Amount value={line.credit} currency={line.currency} /> : '—'}</td>
              </tr>)}
              <tr className="journal-total">
                <td colSpan={2}>{id === truncated ? 'Total of the lines shown · this journal may continue past the API limit' : 'Total'}</td>
                <td className="align-right numeric">{formatAmount(debit, head.currency)}</td>
                <td className="align-right numeric">{formatAmount(credit, head.currency)}</td>
              </tr>
            </tbody>;
          })}
        </table></div>}
    </EvidencePane>
  </>;
}
