import { api, offline } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { byMoney, byTime, countBy, matches, param, sortRows, type SearchParams } from '@/lib/list';
import { Amount, ConnectionState, DataTable, EvidencePane, IdCell, PageHeading, Status } from '@/components/console';
import { ListControls, NoMatches } from '@/components/list-controls';

interface Row { id: string; status: string; amount: string; currency: string; providerReference?: string; failureCode?: string; createdAt: string; completedAt?: string }
export const dynamic = 'force-dynamic';

export default async function PayoutsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const all = await api<Row[]>('/payouts').catch(offline);
  if (!all) return <ConnectionState />;
  const q = param(params, 'q'), currency = param(params, 'currency'), status = param(params, 'status');
  const base = all.filter((r) => matches(q, [r.id, r.providerReference, r.failureCode]) && (!currency || r.currency === currency));
  const rows = sortRows(base.filter((r) => !status || r.status === status), params, 'created', {
    created: byTime((r) => r.createdAt),
    amount: byMoney((r) => ({ amount: r.amount, currency: r.currency })),
  });
  return <>
    <PageHeading eyebrow="available balance consumption" title="Payouts">Requests reserve merchant available funds under a PostgreSQL advisory lock before provider processing begins.</PageHeading>
    <ListControls path="/payouts" params={params} search="Search payout ID, reference or failure code" currencies={[...new Set(all.map((r) => r.currency))].sort()}
      facets={[{ name: 'status', label: 'Filter by state', options: countBy(base, (r) => r.status), render: (value) => <Status value={value} of="payout" /> }]}
      summary={`${rows.length} of ${all.length} payouts`} />
    <EvidencePane label="payout register" title="Merchant disbursements">
      <DataTable caption="Payouts" sort={{ path: '/payouts', params, defaultKey: 'created' }}
        empty={all.length ? <NoMatches noun="payouts" path="/payouts" /> : 'No payout requested. Settled available funds can be reserved here.'}
        columns={[
          { key: 'id', label: 'payout' },
          { key: 'created', label: 'requested (UTC)', mono: true, sortable: true },
          { key: 'status', label: 'state' },
          { key: 'currency', label: 'ccy', mono: true },
          { key: 'amount', label: 'amount', align: 'right', sortable: true },
          { key: 'provider', label: 'provider reference' },
          { key: 'completed', label: 'completed (UTC)', mono: true },
        ]}
        rows={rows.map((r) => ({
          key: r.id,
          id: <IdCell id={r.id} label="Payout" />,
          created: formatTime(r.createdAt),
          status: <Status value={r.status} of="payout" />,
          currency: r.currency,
          amount: <Amount value={r.amount} currency={r.currency} />,
          provider: r.providerReference ? <IdCell id={r.providerReference} label="Provider reference" /> : r.failureCode ? <span className="mono">failure: {r.failureCode}</span> : '—',
          completed: formatTime(r.completedAt),
        }))} />
    </EvidencePane>
  </>;
}
