import { api, offline } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { byMoney, byTime, countBy, matches, param, sortRows, type SearchParams } from '@/lib/list';
import { Amount, ConnectionState, DataTable, EvidencePane, IdCell, PageHeading, Status } from '@/components/console';
import { ListControls, NoMatches } from '@/components/list-controls';

interface Row { id: string; status: string; currency: string; grossAmount: string; feeAmount: string; netAmount: string; availableOn: string; completedAt?: string; createdAt: string }
export const dynamic = 'force-dynamic';

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const all = await api<Row[]>('/settlements').catch(offline);
  if (!all) return <ConnectionState />;
  const q = param(params, 'q'), currency = param(params, 'currency'), status = param(params, 'status');
  const base = all.filter((r) => matches(q, [r.id]) && (!currency || r.currency === currency));
  const rows = sortRows(base.filter((r) => !status || r.status === status), params, 'created', {
    created: byTime((r) => r.createdAt),
    available: byTime((r) => r.availableOn),
    net: byMoney((r) => ({ amount: r.netAmount, currency: r.currency })),
  });
  return <>
    <PageHeading eyebrow="T+N availability boundary" title="Settlements">Capture creates pending money. Settlement converts the provider receivable and releases merchant availability.</PageHeading>
    <ListControls path="/settlements" params={params} search="Search batch ID" currencies={[...new Set(all.map((r) => r.currency))].sort()}
      facets={[{ name: 'status', label: 'Filter by state', options: countBy(base, (r) => r.status), render: (value) => <Status value={value} of="settlement" /> }]}
      summary={`${rows.length} of ${all.length} batches`} />
    <EvidencePane label="settlement batches" title="Availability register">
      <DataTable caption="Settlement batches" sort={{ path: '/settlements', params, defaultKey: 'created' }}
        empty={all.length ? <NoMatches noun="batches" path="/settlements" /> : 'No settlement batch yet. Eligible captured payments will be grouped after their delay.'}
        columns={[
          { key: 'id', label: 'batch' },
          { key: 'created', label: 'created (UTC)', mono: true, sortable: true },
          { key: 'status', label: 'state' },
          { key: 'currency', label: 'ccy', mono: true },
          { key: 'gross', label: 'gross', align: 'right' },
          { key: 'fee', label: 'fee', align: 'right' },
          { key: 'net', label: 'merchant net', align: 'right', sortable: true },
          { key: 'available', label: 'available on (UTC)', mono: true, sortable: true },
          { key: 'completed', label: 'completed (UTC)', mono: true },
        ]}
        rows={rows.map((r) => ({
          key: r.id,
          id: <IdCell id={r.id} label="Settlement" />,
          created: formatTime(r.createdAt),
          status: <Status value={r.status} of="settlement" />,
          currency: r.currency,
          gross: <Amount value={r.grossAmount} currency={r.currency} />,
          fee: <Amount value={r.feeAmount} currency={r.currency} />,
          net: <Amount value={r.netAmount} currency={r.currency} />,
          available: formatTime(r.availableOn),
          completed: formatTime(r.completedAt),
        }))} />
    </EvidencePane>
  </>;
}
