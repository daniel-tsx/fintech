import { api, offline } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { byTime, countBy, matches, param, sortRows, type SearchParams } from '@/lib/list';
import { ConnectionState, DataTable, EvidencePane, IdCell, PageHeading, Status } from '@/components/console';
import { ListControls, NoMatches } from '@/components/list-controls';

interface Row { id: string; providerEventId: string; eventType: string; status: string; attempts: number; lastError?: string; createdAt: string; processedAt?: string }
export const dynamic = 'force-dynamic';

export default async function WebhooksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const all = await api<Row[]>('/webhooks').catch(offline);
  if (!all) return <ConnectionState />;
  const q = param(params, 'q'), status = param(params, 'status');
  const base = all.filter((r) => matches(q, [r.providerEventId, r.eventType, r.lastError]));
  const rows = sortRows(base.filter((r) => !status || r.status === status), params, 'received', {
    received: byTime((r) => r.createdAt),
    tries: (a, b) => a.attempts - b.attempts,
  });
  return <>
    <PageHeading eyebrow="at-least-once ingress" title="Webhook inbox">Stripe-signed events are stored before processing. Duplicate IDs replay the original receipt without repeating business effects.</PageHeading>
    <ListControls path="/webhooks" params={params} search="Search event ID, type or error"
      facets={[{ name: 'status', label: 'Filter by processing state', options: countBy(base, (r) => r.status), render: (value) => <Status value={value} /> }]}
      summary={`${rows.length} of ${all.length} events · the API returns the latest 200`} />
    <EvidencePane label="provider inbox" title="Delivery evidence">
      <DataTable caption="Webhook events" sort={{ path: '/webhooks', params, defaultKey: 'received' }}
        empty={all.length ? <NoMatches noun="events" path="/webhooks" /> : 'No Stripe event has been received by the local webhook endpoint.'}
        columns={[
          { key: 'event', label: 'provider event' },
          { key: 'received', label: 'received (UTC)', mono: true, sortable: true },
          { key: 'type', label: 'type', mono: true },
          { key: 'status', label: 'processing' },
          { key: 'tries', label: 'tries', align: 'right', sortable: true },
          { key: 'processed', label: 'processed (UTC)', mono: true },
          { key: 'error', label: 'last error' },
        ]}
        rows={rows.map((r) => ({
          key: r.id,
          event: <IdCell id={r.providerEventId} label="Provider event" />,
          received: formatTime(r.createdAt),
          type: r.eventType,
          status: <Status value={r.status} />,
          tries: r.attempts,
          processed: formatTime(r.processedAt),
          error: r.lastError ? <span className="cell-note" title={r.lastError}>{r.lastError}</span> : '—',
        }))} />
    </EvidencePane>
  </>;
}
