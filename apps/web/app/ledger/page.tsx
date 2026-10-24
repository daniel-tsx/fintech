import { api, offline } from '@/lib/api';
import { countBy, matches, param, type SearchParams } from '@/lib/list';
import { ConnectionState, EvidencePane, PageHeading } from '@/components/console';
import { groupJournals, JournalTable } from '@/components/journal-table';
import { ListControls, NoMatches } from '@/components/list-controls';

interface Entry { transactionId: string; businessType: string; businessId: string; description: string; currency: string; postedAt: string; accountCode: string; accountType: string; debit: string; credit: string }

const API_LIMIT = 500; // ledger/entries returns at most this many lines
export const dynamic = 'force-dynamic';

export default async function LedgerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const currency = param(params, 'currency');
  const entries = await api<Entry[]>(`/ledger/entries${currency ? `?currency=${encodeURIComponent(currency)}` : ''}`).catch(offline);
  if (!entries) return <ConnectionState />;

  const all = groupJournals(entries, (e) => e.transactionId,
    (e) => ({ id: e.transactionId, type: e.businessType, description: e.description, currency: e.currency, at: e.postedAt, reference: e.businessId }),
    (e) => ({ account: e.accountCode, accountType: e.accountType, debit: e.debit, credit: e.credit }));
  const q = param(params, 'q'), type = param(params, 'type');
  const base = all.filter((j) => matches(q, [j.id, j.reference, j.description, ...j.lines.map((l) => l.account)]));
  const shown = base.filter((j) => !type || j.type === type);
  // The API limit counts lines, so the oldest journal returned can be cut short.
  const incompleteId = entries.length >= API_LIMIT ? all.at(-1)?.id : undefined;

  return <>
    <PageHeading eyebrow="double-entry source of truth" title="Ledger">Posted journals are immutable. Every transaction must balance within one currency.</PageHeading>
    <ListControls path="/ledger" params={params} search="Search journal, business reference, description or account"
      currencies={[...new Set(entries.map((e) => e.currency))].sort()}
      facets={[{ name: 'type', label: 'Filter by business event', options: countBy(base, (j) => j.type) }]}
      summary={`${shown.length} of ${all.length} journals (${entries.length} lines${entries.length >= API_LIMIT ? `, the API limit of ${API_LIMIT}` : ''}) · newest first${currency ? ` · ${currency} only` : ''}`} />
    <EvidencePane label="journal register" title="Journals">
      {shown.length
        ? <JournalTable journals={shown} caption="Journals with their entries and totals" incompleteId={incompleteId} />
        : <p className="inline-empty">{all.length ? <NoMatches noun="journals" path="/ledger" /> : 'No ledger entries yet. A confirmed capture will post the first balanced journal.'}</p>}
    </EvidencePane>
  </>;
}
