import Link from 'next/link';
import { ApiUnavailableError, api, formatMoney, formatTime } from '@/lib/api';
import { Balance, BalanceStrip, ConnectionState, DataTable, EvidencePane, PageHeading, PaymentLink, Status, TraceRail } from '@/components/console';

interface Payment { id: string; status: string; amount: string; currency: string; capturedAmount: string; createdAt: string }
interface PaymentList { data: Payment[] }

export const dynamic = 'force-dynamic';
export default async function OverviewPage() {
  let balances: Balance[]; let payments: Payment[];
  try { const [balanceResult, paymentResult] = await Promise.all([api<{ data: Balance[] }>('/balances'), api<PaymentList>('/payments?pageSize=8')]); balances = balanceResult.data; payments = paymentResult.data; }
  catch (error) { if (error instanceof ApiUnavailableError) return <ConnectionState />; throw error; }
  const latest = payments[0];
  const trace = latest ? [
    { label: 'Payment created', detail: 'Merchant intent persisted', at: latest.createdAt, state: 'done' as const },
    { label: 'Authorization', detail: latest.status === 'CREATED' ? 'Waiting for merchant command' : 'Provider reservation path', state: latest.status === 'CREATED' ? 'active' as const : 'done' as const },
    { label: 'Capture', detail: 'Provider confirmation posts the journal', state: ['CAPTURED','PARTIALLY_REFUNDED','REFUNDED','DISPUTED'].includes(latest.status) ? 'done' as const : 'waiting' as const },
    { label: 'Settlement', detail: 'Pending liability moves to available', state: 'waiting' as const },
    { label: 'Payout', detail: 'Available balance is atomically reserved', state: 'waiting' as const },
  ] : [];
  return <><PageHeading eyebrow="merchant clearing desk" title="Money and state, in one trace">Follow each boundary independently: provider state, internal workflow, ledger, settlement, then payout.</PageHeading><BalanceStrip balances={balances} /><div className="overview-grid"><EvidencePane label="latest trace" title={latest ? `Payment ${latest.id.slice(0, 8)}` : 'No payment selected'} action={latest ? <Link href={`/payments/${latest.id}`}>Open evidence →</Link> : undefined}>{latest ? <TraceRail items={trace} /> : <p className="inline-empty">No payments yet. Create a local payment intent to establish the first trace.</p>}</EvidencePane><EvidencePane label="recent intents" title="Payment register"><DataTable empty="No payment intents yet. Create one through the API to populate the register." columns={[{key:'id',label:'payment'},{key:'status',label:'state'},{key:'amount',label:'gross',align:'right'},{key:'created',label:'received'}]} rows={payments.map((payment) => ({ id: <PaymentLink id={payment.id} />, status: <Status value={payment.status} />, amount: formatMoney(payment.amount,payment.currency), created: formatTime(payment.createdAt) }))} /></EvidencePane></div></>;
}
