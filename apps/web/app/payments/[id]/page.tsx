import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiUnavailableError, api, offline } from '@/lib/api';
import { formatMoney, formatTime } from '@/lib/format';
import { Amount, Chip, ConnectionState, DataTable, EmptyTrace, EvidencePane, IdCell, PageHeading, Status, type TraceItem, TraceRail } from '@/components/console';
import { CopyButton } from '@/components/copy-button';
import { groupJournals, JournalTable } from '@/components/journal-table';

interface Detail {
  payment: { id: string; status: string; captureMethod: string; amount: string; authorizedAmount: string; capturedAmount: string; refundedAmount: string; platformFeeAmount: string; currency: string; description: string | null; createdAt: string };
  attempts: Array<{ id: string; kind: string; status: string; amount: string; currency: string; providerTransactionId: string | null; failureCode: string | null; createdAt: string }>;
  refunds: Array<{ id: string; status: string; amount: string; currency: string; reason: string | null; providerTransactionId: string | null; createdAt: string }>;
  ledger: Array<{ id: string; businessType: string; description: string; status: string; createdAt: string; accountCode: string; debit: string; credit: string }>;
  timeline: Array<{ action: string; actorType: string; metadata: Record<string, unknown>; createdAt: string }>;
}
interface Dispute { id: string; paymentId: string; providerDisputeId: string; status: string; outcome?: string; amount: string; currency: string; openedAt: string }
interface Issue { id: string; paymentId?: string; issueType: string; severity: string; status: string; createdAt: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Audit metadata keys that hold minor units; everything else is shown as recorded.
const moneyKeys = new Set(['amount', 'gross', 'fee', 'net']);

/** What the payment is waiting for, only while its workflow is still open. */
const nextStep: Record<string, Omit<TraceItem, 'at'>> = {
  CREATED: { label: 'Waiting for a merchant command', detail: 'No authorization has been requested yet.', state: 'active' },
  REQUIRES_AUTHORIZATION: { label: 'Authorization outcome unknown', detail: 'Requested from the provider; waiting for its event. Not a failure.', state: 'active' },
  AUTHORIZED: { label: 'Waiting for a capture command', detail: 'Funds are reserved at the provider; nothing is posted to the ledger yet.', state: 'active' },
  CAPTURE_PENDING: { label: 'Capture outcome unknown', detail: 'Requested from the provider; waiting for its event. Not a failure.', state: 'active' },
};

function describeMetadata(metadata: Record<string, unknown>, currency: string): string {
  const own = typeof metadata.currency === 'string' ? metadata.currency : currency;
  return Object.entries(metadata).map(([key, value]) =>
    moneyKeys.has(key) && /^-?\d+$/.test(String(value)) ? `${key} ${formatMoney(String(value), own)}` : `${key} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · ');
}

function sentence(action: string): string {
  const text = action.replace(/^payment\./, '').replaceAll(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const dynamic = 'force-dynamic';

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.test(id)) notFound();
  const [detail, disputes, issues] = await Promise.all([
    api<Detail>(`/payments/${id}`).catch((error) => { if (error instanceof ApiUnavailableError && error.status === 404) notFound(); return offline(error); }),
    api<Dispute[]>('/disputes').catch(() => null),
    api<Issue[]>('/reconciliation/issues').catch(() => null),
  ]);
  if (!detail) return <ConnectionState />;
  const { payment } = detail;
  const money = (value: string) => formatMoney(value, payment.currency);
  const positive = (value: string) => BigInt(value) > BigInt(0);

  const trace: TraceItem[] = detail.timeline.map((entry) => ({
    label: sentence(entry.action),
    detail: <>{entry.actorType.toLowerCase()}{Object.keys(entry.metadata).length ? <> · <span className="mono">{describeMetadata(entry.metadata, payment.currency)}</span></> : null}</>,
    at: entry.createdAt,
    state: /failed/.test(entry.action) ? 'failed' : 'done',
  }));
  if (nextStep[payment.status]) trace.push(nextStep[payment.status]);

  const journals = groupJournals(detail.ledger, (line) => line.id,
    (line) => ({ id: line.id, type: line.businessType, description: line.description, currency: payment.currency, at: line.createdAt, status: line.status }),
    (line) => ({ account: line.accountCode, debit: line.debit, credit: line.credit }));
  const relatedDisputes = disputes?.filter((d) => d.paymentId === payment.id);
  const relatedIssues = issues?.filter((i) => i.paymentId === payment.id);
  const amounts = [['amount', payment.amount], ['authorized', payment.authorizedAmount], ['captured', payment.capturedAmount], ['refunded', payment.refundedAmount], ['platform fee', payment.platformFeeAmount]];

  return <>
    <PageHeading eyebrow={<>payment / <span className="verbatim">{payment.id}</span></>} title={payment.description || 'Payment'}
      action={<div className="heading-actions"><CopyButton value={payment.id} label="payment ID" /><Link href={`/audit?q=${payment.id}`}>Audit entries</Link></div>}>
      <Status value={payment.status} /> · {money(payment.amount)} · {payment.captureMethod.toLowerCase()} capture · created <span className="mono">{formatTime(payment.createdAt)}</span>
    </PageHeading>

    <div className="fact-strip" aria-label="Amounts">
      {amounts.map(([label, value]) => <div key={label}><span>{label}</span><strong title={`${value} minor units`}>{money(value)}</strong></div>)}
    </div>

    <div className="detail-grid">
      <EvidencePane label="causal trace" title="Lifecycle">
        {trace.length ? <TraceRail items={trace} /> : <EmptyTrace noun="lifecycle events" promise="Audit events will appear here when recorded." />}
      </EvidencePane>
      <EvidencePane label="money state" title="Where the money is">
        <dl className="money-state">
          <div><dt><Chip tone={positive(payment.authorizedAmount) ? 'authorized' : 'neutral'} label="authorized" /></dt><dd className="numeric">{money(payment.authorizedAmount)}</dd></div>
          <div><dt><Chip tone={positive(payment.capturedAmount) ? 'captured' : 'neutral'} label="captured" /></dt><dd className="numeric">{money(payment.capturedAmount)}</dd></div>
          <div><dt><Chip tone={positive(payment.refundedAmount) ? 'refunded' : 'neutral'} label="refunded" /></dt><dd className="numeric">{money(payment.refundedAmount)}</dd></div>
          <div><dt><Chip tone="pending" label="settled · not reported" /></dt><dd>The payment API does not say which settlement batch holds this capture. <Link href={`/settlements?currency=${payment.currency}`}>Settlements</Link></dd></div>
          <div><dt><Chip tone="pending" label="paid out · not reported" /></dt><dd>Payouts draw on the merchant&apos;s available balance, not on single payments. <Link href={`/payouts?currency=${payment.currency}`}>Payouts</Link></dd></div>
        </dl>
      </EvidencePane>
    </div>

    <EvidencePane label="provider operations" title="Attempts">
      <DataTable caption="Provider attempts" empty="No provider operation has been requested yet."
        columns={[
          { key: 'created', label: 'requested (UTC)', mono: true },
          { key: 'kind', label: 'operation' },
          { key: 'status', label: 'state' },
          { key: 'currency', label: 'ccy', mono: true },
          { key: 'amount', label: 'amount', align: 'right' },
          { key: 'provider', label: 'provider reference' },
          { key: 'failure', label: 'failure code', mono: true },
        ]}
        rows={detail.attempts.map((a) => ({
          key: a.id,
          created: formatTime(a.createdAt),
          kind: a.kind.toLowerCase(),
          status: <Status value={a.status} of="attempt" />,
          currency: a.currency,
          amount: <Amount value={a.amount} currency={a.currency} />,
          provider: a.providerTransactionId ? <IdCell id={a.providerTransactionId} label="Provider reference" /> : '—',
          failure: a.failureCode ?? '—',
        }))} />
    </EvidencePane>

    <EvidencePane label="money returned" title="Refunds">
      <DataTable caption="Refunds" empty="No refund requested for this payment."
        columns={[
          { key: 'created', label: 'requested (UTC)', mono: true },
          { key: 'id', label: 'refund' },
          { key: 'status', label: 'state' },
          { key: 'currency', label: 'ccy', mono: true },
          { key: 'amount', label: 'amount', align: 'right' },
          { key: 'reason', label: 'reason' },
          { key: 'provider', label: 'provider reference' },
        ]}
        rows={detail.refunds.map((r) => ({
          key: r.id,
          created: formatTime(r.createdAt),
          id: <IdCell id={r.id} label="Refund" />,
          status: <Status value={r.status} of="refund" />,
          currency: r.currency,
          amount: <Amount value={r.amount} currency={r.currency} />,
          reason: r.reason ?? '—',
          provider: r.providerTransactionId ? <IdCell id={r.providerTransactionId} label="Provider reference" /> : '—',
        }))} />
    </EvidencePane>

    <EvidencePane label="immutable evidence" title="Journals">
      {journals.length ? <JournalTable journals={journals} caption="Journals posted for this payment, its attempts and refunds" /> : <p className="inline-empty">No journal exists yet. Authorization alone does not move ledger money.</p>}
    </EvidencePane>

    <div className="detail-grid">
      <EvidencePane label="related" title="Disputes" action={<Link href={`/disputes?q=${payment.id}`}>Open register</Link>}>
        {!relatedDisputes ? <p className="inline-empty">Disputes could not be loaded.</p> :
          <DataTable caption="Disputes for this payment" empty="No dispute opened for this payment."
            columns={[{ key: 'opened', label: 'opened (UTC)', mono: true }, { key: 'case', label: 'provider case' }, { key: 'status', label: 'state' }, { key: 'amount', label: 'amount', align: 'right' }]}
            rows={relatedDisputes.map((d) => ({ key: d.id, opened: formatTime(d.openedAt), case: <IdCell id={d.providerDisputeId} label="Provider case" />, status: <Status value={d.outcome ?? d.status} />, amount: formatMoney(d.amount, d.currency) }))} />}
      </EvidencePane>
      <EvidencePane label="related" title="Reconciliation issues" action={<Link href={`/reconciliation?q=${payment.id}`}>Open register</Link>}>
        {!relatedIssues ? <p className="inline-empty">Reconciliation issues could not be loaded.</p> :
          <DataTable caption="Reconciliation issues for this payment" empty="No mismatch recorded among the latest 200 issues."
            columns={[{ key: 'detected', label: 'detected (UTC)', mono: true }, { key: 'issue', label: 'issue type' }, { key: 'severity', label: 'severity' }, { key: 'status', label: 'resolution' }]}
            rows={relatedIssues.map((i) => ({ key: i.id, detected: formatTime(i.createdAt), issue: i.issueType.replaceAll('_', ' ').toLowerCase(), severity: <Status value={i.severity} of="severity" />, status: <Status value={i.status} /> }))} />}
      </EvidencePane>
    </div>
  </>;
}
