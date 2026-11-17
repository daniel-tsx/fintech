import Link from 'next/link';
import { api, offline } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { byMoney, byTime, countBy, hrefWith, matches, param, sortRows, type SearchParams } from '@/lib/list';
import { Amount, ConnectionState, DataTable, EvidencePane, IdCell, PageHeading, Status } from '@/components/console';
import { ListControls, NoMatches } from '@/components/list-controls';

interface Payment {
  id: string;
  status: string;
  amount: string;
  capturedAmount: string;
  refundedAmount: string;
  currency: string;
  captureMethod: string;
  description: string | null;
  createdAt: string;
}
interface PaymentPage { data: Payment[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } }

const PAGE_SIZE = 100;
export const dynamic = 'force-dynamic';

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(param(params, 'page') ?? '1', 10) || 1);
  const result = await api<PaymentPage>(`/payments?page=${page}&pageSize=${PAGE_SIZE}`).catch(offline);
  if (!result) return <ConnectionState />;
  const { totalItems, totalPages } = result.pagination;

  const q = param(params, 'q'), currency = param(params, 'currency'), status = param(params, 'status');
  const base = result.data.filter((p) => matches(q, [p.id, p.description]) && (!currency || p.currency === currency));
  const rows = sortRows(base.filter((p) => !status || p.status === status), params, 'created', {
    created: byTime((p) => p.createdAt),
    amount: byMoney((p) => ({ amount: p.amount, currency: p.currency })),
  });

  return <>
    <PageHeading eyebrow="operational aggregate" title="Payments">Mutable workflow state. Open a payment to compare it with its immutable financial evidence.</PageHeading>
    <ListControls
      path="/payments"
      params={params}
      search="Search ID or description"
      currencies={[...new Set(result.data.map((p) => p.currency))].sort()}
      facets={[{ name: 'status', label: 'Filter by state', options: countBy(base, (p) => p.status), render: (value) => <Status value={value} /> }]}
      summary={<>{rows.length} of {result.data.length} on page {page} of {Math.max(totalPages, 1)} · {totalItems} payments in total{totalPages > 1 && ' · filters and sorting apply to this page'}</>}
    />
    <EvidencePane label="payment register" title="Merchant intents">
      <DataTable
        caption="Payments"
        sort={{ path: '/payments', params, defaultKey: 'created' }}
        empty={result.data.length ? <NoMatches noun="payments" path="/payments" /> : totalItems ? <>No payments on this page. <Link className="mono-link" href="/payments">Back to the newest</Link></> : 'No payments yet. Demo payment intents will appear here.'}
        columns={[
          { key: 'id', label: 'payment' },
          { key: 'created', label: 'created (UTC)', mono: true, sortable: true },
          { key: 'description', label: 'description' },
          { key: 'status', label: 'state' },
          { key: 'flow', label: 'capture' },
          { key: 'currency', label: 'ccy', mono: true },
          { key: 'amount', label: 'amount', align: 'right', sortable: true },
          { key: 'captured', label: 'captured', align: 'right' },
          { key: 'refunded', label: 'refunded', align: 'right' },
        ]}
        rows={rows.map((p) => ({
          key: p.id,
          id: <IdCell id={p.id} href={`/payments/${p.id}`} label="Payment" />,
          created: formatTime(p.createdAt),
          description: <span className="cell-note">{p.description ?? '—'}</span>,
          status: <Status value={p.status} />,
          flow: p.captureMethod.toLowerCase(),
          currency: p.currency,
          amount: <Amount value={p.amount} currency={p.currency} />,
          captured: <Amount value={p.capturedAmount} currency={p.currency} />,
          refunded: <Amount value={p.refundedAmount} currency={p.currency} />,
        }))}
      />
    </EvidencePane>
    {totalPages > 1 && <nav className="pager" aria-label="Pages">
      {page > 1 ? <Link href={hrefWith('/payments', params, { page: String(page - 1) })}>← Newer</Link> : <span />}
      <span>Page {page} of {totalPages}</span>
      {page < totalPages ? <Link href={hrefWith('/payments', params, { page: String(page + 1) })}>Older →</Link> : <span />}
    </nav>}
  </>;
}
