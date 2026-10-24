import { api, offline } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { byTime, countBy, matches, param, sortRows, type SearchParams } from '@/lib/list';
import { ConnectionState, DataTable, EvidencePane, IdCell, PageHeading, PaymentLink, Status } from '@/components/console';
import { ListControls, NoMatches } from '@/components/list-controls';

interface Row { id: string; paymentId?: string; providerTransactionId?: string; issueType: string; severity: string; status: string; createdAt: string; resolvedAt?: string }
export const dynamic = 'force-dynamic';

export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const all = await api<Row[]>('/reconciliation/issues').catch(offline);
  if (!all) return <ConnectionState />;
  const q = param(params, 'q'), status = param(params, 'status'), severity = param(params, 'severity');
  const base = all.filter((r) => matches(q, [r.id, r.paymentId, r.providerTransactionId, r.issueType]));
  const rows = sortRows(base.filter((r) => (!status || r.status === status) && (!severity || r.severity === severity)), params, 'detected', {
    detected: byTime((r) => r.createdAt),
  });
  return <>
    <PageHeading eyebrow="internal ↔ provider comparison" title="Reconciliation">Differences become reviewable issues. The engine never silently repairs operational state or financial history.</PageHeading>
    <ListControls path="/reconciliation" params={params} search="Search payment, provider transaction or issue type"
      facets={[
        { name: 'status', label: 'Filter by resolution', options: countBy(base, (r) => r.status), render: (value) => <Status value={value} /> },
        { name: 'severity', label: 'Filter by severity', options: countBy(base, (r) => r.severity), render: (value) => <Status value={value} of="severity" /> },
      ]}
      summary={`${rows.length} of ${all.length} issues · the API returns the latest 200`} />
    <EvidencePane label="exception queue" title="Open and resolved mismatches">
      <DataTable caption="Reconciliation issues" sort={{ path: '/reconciliation', params, defaultKey: 'detected' }}
        empty={all.length ? <NoMatches noun="issues" path="/reconciliation" /> : 'No mismatches detected. Reconciliation runs will record disagreements here.'}
        columns={[
          { key: 'detected', label: 'detected (UTC)', mono: true, sortable: true },
          { key: 'severity', label: 'severity' },
          { key: 'issue', label: 'issue type' },
          { key: 'payment', label: 'payment' },
          { key: 'provider', label: 'provider transaction' },
          { key: 'status', label: 'resolution' },
          { key: 'resolved', label: 'resolved (UTC)', mono: true },
        ]}
        rows={rows.map((r) => ({
          key: r.id,
          detected: formatTime(r.createdAt),
          severity: <Status value={r.severity} of="severity" />,
          issue: r.issueType.replaceAll('_', ' ').toLowerCase(),
          payment: r.paymentId ? <PaymentLink id={r.paymentId} /> : '—',
          provider: r.providerTransactionId ? <IdCell id={r.providerTransactionId} label="Provider transaction" /> : '—',
          status: <Status value={r.status} />,
          resolved: formatTime(r.resolvedAt),
        }))} />
    </EvidencePane>
  </>;
}
