import { api, offline } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { byTime, countBy, matches, param, sortRows, type SearchParams } from '@/lib/list';
import { ConnectionState, DataTable, EvidencePane, IdCell, PageHeading } from '@/components/console';
import { ListControls, NoMatches } from '@/components/list-controls';

interface Row { id: string; actorType: string; actorId?: string; action: string; targetType: string; targetId: string; correlationId?: string; metadata: Record<string, unknown>; createdAt: string }
export const dynamic = 'force-dynamic';

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const all = await api<Row[]>('/audit-logs').catch(offline);
  if (!all) return <ConnectionState />;
  const q = param(params, 'q'), target = param(params, 'target');
  const base = all.filter((r) => matches(q, [r.action, r.targetId, r.correlationId, r.actorId, JSON.stringify(r.metadata)]));
  const rows = sortRows(base.filter((r) => !target || r.targetType === target), params, 'time', { time: byTime((r) => r.createdAt) });
  return <>
    <PageHeading eyebrow="immutable operator record" title="Audit trail">Sensitive commands and provider confirmations retain actor, target, correlation, and non-secret context.</PageHeading>
    <ListControls path="/audit" params={params} search="Search action, target, correlation or context"
      facets={[{ name: 'target', label: 'Filter by target type', options: countBy(base, (r) => r.targetType) }]}
      summary={`${rows.length} of ${all.length} entries · the API returns the latest 300`} />
    <EvidencePane label="chronological evidence" title="Financial actions">
      <DataTable caption="Audit entries" sort={{ path: '/audit', params, defaultKey: 'time' }}
        empty={all.length ? <NoMatches noun="entries" path="/audit" /> : 'No sensitive action recorded yet. Payment commands will append immutable audit evidence.'}
        columns={[
          { key: 'time', label: 'time (UTC)', mono: true, sortable: true },
          { key: 'action', label: 'action', mono: true },
          { key: 'actor', label: 'actor' },
          { key: 'target', label: 'target' },
          { key: 'correlation', label: 'correlation' },
          { key: 'context', label: 'context' },
        ]}
        rows={rows.map((r) => {
          const context = JSON.stringify(r.metadata);
          return {
            key: r.id,
            time: formatTime(r.createdAt),
            action: r.action,
            actor: r.actorType.toLowerCase(),
            target: <>{r.targetType} <IdCell id={r.targetId} href={r.targetType === 'payment' ? `/payments/${r.targetId}` : undefined} label={r.targetType} /></>,
            correlation: r.correlationId ? <IdCell id={r.correlationId} label="Correlation" /> : '—',
            context: <span className="cell-note mono" title={context}>{context}</span>,
          };
        })} />
    </EvidencePane>
  </>;
}
