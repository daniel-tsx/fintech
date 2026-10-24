import { api, offline } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { byMoney, byTime, countBy, matches, param, sortRows, type SearchParams } from '@/lib/list';
import { Amount, ConnectionState, DataTable, EvidencePane, IdCell, PageHeading, PaymentLink, Status } from '@/components/console';
import { ListControls, NoMatches } from '@/components/list-controls';

interface Row { id: string; paymentId: string; providerDisputeId: string; status: string; outcome?: string; amount: string; currency: string; openedAt: string; closedAt?: string }
export const dynamic = 'force-dynamic';

export default async function DisputesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const all = await api<Row[]>('/disputes').catch(offline);
  if (!all) return <ConnectionState />;
  const state = (r: Row) => r.outcome ?? r.status;
  const q = param(params, 'q'), currency = param(params, 'currency'), status = param(params, 'status');
  const base = all.filter((r) => matches(q, [r.id, r.providerDisputeId, r.paymentId]) && (!currency || r.currency === currency));
  const rows = sortRows(base.filter((r) => !status || state(r) === status), params, 'opened', {
    opened: byTime((r) => r.openedAt),
    amount: byMoney((r) => ({ amount: r.amount, currency: r.currency })),
  });
  return <>
    <PageHeading eyebrow="chargeback hold" title="Disputes">Funds move into dispute clearing; winning or losing posts a new journal instead of rewriting capture history.</PageHeading>
    <ListControls path="/disputes" params={params} search="Search case, dispute or payment ID" currencies={[...new Set(all.map((r) => r.currency))].sort()}
      facets={[{ name: 'status', label: 'Filter by state', options: countBy(base, state), render: (value) => <Status value={value} /> }]}
      summary={`${rows.length} of ${all.length} disputes`} />
    <EvidencePane label="case register" title="Provider disputes">
      <DataTable caption="Disputes" sort={{ path: '/disputes', params, defaultKey: 'opened' }}
        empty={all.length ? <NoMatches noun="disputes" path="/disputes" /> : 'No disputes open. Provider dispute events and their financial holds will appear here.'}
        columns={[
          { key: 'case', label: 'provider case' },
          { key: 'payment', label: 'payment' },
          { key: 'opened', label: 'opened (UTC)', mono: true, sortable: true },
          { key: 'status', label: 'state' },
          { key: 'currency', label: 'ccy', mono: true },
          { key: 'amount', label: 'amount', align: 'right', sortable: true },
          { key: 'closed', label: 'closed (UTC)', mono: true },
        ]}
        rows={rows.map((r) => ({
          key: r.id,
          case: <IdCell id={r.providerDisputeId} label="Provider case" />,
          payment: <PaymentLink id={r.paymentId} />,
          opened: formatTime(r.openedAt),
          status: <Status value={state(r)} />,
          currency: r.currency,
          amount: <Amount value={r.amount} currency={r.currency} />,
          closed: formatTime(r.closedAt),
        }))} />
    </EvidencePane>
  </>;
}
