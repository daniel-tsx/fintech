import Link from 'next/link';
import { api, offline } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { Amount, type Balance, BalanceStrip, ConnectionState, DataTable, EvidencePane, PageHeading, PaymentLink, Status } from '@/components/console';

interface Payment { id: string; status: string; amount: string; currency: string; createdAt: string }
interface Attention { label: string; count: number; href: string; status: string }

export const dynamic = 'force-dynamic';

/** Count records in the given states; null when the source could not be loaded. */
function attention<T>(rows: T[] | null, pick: (row: T) => string, states: string[], label: (state: string) => string, href: (state: string) => string): Attention[] | null {
  if (!rows) return null;
  return states.map((state) => ({ label: label(state), count: rows.filter((row) => pick(row) === state).length, href: href(state), status: state })).filter((item) => item.count);
}

export default async function OverviewPage() {
  const [balances, payments, webhooks, issues, disputes] = await Promise.all([
    api<{ data: Balance[] }>('/balances').catch(offline),
    api<{ data: Payment[] }>('/payments?pageSize=8').catch(offline),
    api<Array<{ status: string }>>('/webhooks').catch(() => null),
    api<Array<{ status: string }>>('/reconciliation/issues').catch(() => null),
    api<Array<{ status: string; outcome?: string }>>('/disputes').catch(() => null),
  ]);
  if (!balances || !payments) return <ConnectionState />;

  const sources = [
    { name: 'webhook events (latest 200)', items: attention(webhooks, (w) => w.status, ['DEAD', 'ACCOUNTING_EXCEPTION', 'RETRY'], (s) => `Webhook events ${s.replaceAll('_', ' ').toLowerCase()}`, (s) => `/webhooks?status=${s}`) },
    { name: 'reconciliation issues (latest 200)', items: attention(issues, (i) => i.status, ['OPEN'], () => 'Open reconciliation issues', (s) => `/reconciliation?status=${s}`) },
    { name: 'disputes', items: attention(disputes, (d) => d.outcome ?? d.status, ['OPEN'], () => 'Open disputes', (s) => `/disputes?status=${s}`) },
  ];
  const items = sources.flatMap((source) => source.items ?? []);
  const unavailable = sources.filter((source) => !source.items).map((source) => source.name);

  return <>
    <PageHeading eyebrow="merchant clearing desk" title="Overview">Balances by currency, records that need a person, and the latest payments. Each boundary is reported separately: provider, workflow, ledger, settlement, payout.</PageHeading>
    <BalanceStrip balances={balances.data} />
    <div className="overview-grid">
      <EvidencePane label="recent intents" title="Latest payments" action={<Link href="/payments">All payments →</Link>}>
        <DataTable caption="Latest payments" empty="No payment intents yet. Create one through the API to populate the register."
          columns={[{ key: 'id', label: 'payment' }, { key: 'created', label: 'created (UTC)', mono: true }, { key: 'status', label: 'state' }, { key: 'currency', label: 'ccy', mono: true }, { key: 'amount', label: 'amount', align: 'right' }]}
          rows={payments.data.map((p) => ({ key: p.id, id: <PaymentLink id={p.id} />, created: formatTime(p.createdAt), status: <Status value={p.status} />, currency: p.currency, amount: <Amount value={p.amount} currency={p.currency} /> }))} />
      </EvidencePane>
      <EvidencePane label="needs a person" title="Attention">
        {items.length
          ? <ul className="attention-list">{items.map((item) => <li key={item.href}><Link href={item.href}><Status value={item.status} /><span>{item.label}</span><strong className="numeric">{item.count}</strong></Link></li>)}</ul>
          : <p className="inline-empty">Nothing needs attention in the records checked.</p>}
        <p className="pane-note">Checks {sources.filter((source) => source.items).map((source) => source.name).join(', ') || 'nothing'}.{unavailable.length ? ` Could not load ${unavailable.join(', ')}.` : ''}</p>
      </EvidencePane>
    </div>
  </>;
}
