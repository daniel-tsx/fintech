import { randomUUID } from 'node:crypto';

const base = process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1';
const apiKey = process.env.DEMO_API_KEY ?? 'fl_test_demo_6f414a845fe04eb4';
const merchantId = '11111111-1111-4111-8111-111111111111';
const scenario = process.argv[2] ?? 'success';

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-api-key': apiKey, ...(init.headers ?? {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitForPayment(id, accepted, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await request(`/payments/${id}`);
    if (accepted.includes(detail.payment.status)) return detail;
    await pause(750);
  }
  throw new Error(`Timed out waiting for payment ${id} to reach ${accepted.join(' or ')}`);
}

async function createAutomatic(providerScenario = 'SUCCESS') {
  return request('/payments', { method: 'POST', headers: { 'idempotency-key': `demo:${randomUUID()}` }, body: JSON.stringify({ amount: 10_000, currency: 'USD', paymentMethodToken: 'pm_mock_visa', captureMethod: 'AUTOMATIC', confirm: true, scenario: providerScenario, description: `Demo ${providerScenario.toLowerCase()}` }) });
}

async function fullFlow() {
  const payment = await createAutomatic();
  await waitForPayment(payment.id, ['CAPTURED']);
  const generated = await request('/settlements/generate', { method: 'POST', body: '{}' });
  for (const settlementId of generated.settlementIds) await request(`/settlements/${settlementId}/complete`, { method: 'POST', body: '{}' });
  await request(`/payments/${payment.id}/refunds`, { method: 'POST', headers: { 'idempotency-key': `refund:${randomUUID()}` }, body: JSON.stringify({ amount: 2_000, reason: 'Educational partial refund' }) });
  await waitForPayment(payment.id, ['PARTIALLY_REFUNDED']);
  const balances = await request('/balances');
  const available = Number(balances.data.find((item) => item.currency === 'USD')?.available ?? 0);
  if (available > 0) await request('/payouts', { method: 'POST', headers: { 'idempotency-key': `payout:${randomUUID()}` }, body: JSON.stringify({ amount: Math.min(1_000, available), currency: 'USD', destinationToken: 'bank_mock_demo' }) });
  return request(`/payments/${payment.id}`);
}

async function outOfOrderDispute() {
  const providerDisputeId = `dp_${randomUUID().replaceAll('-', '')}`;
  const common = { merchantId, paymentId: '44444444-4444-4444-8444-444444444444', providerTransactionId: 'mpsp_seed_capture', providerDisputeId, amount: 1_500, currency: 'USD' };
  await request('/dev/mock-psp/events', { method: 'POST', body: JSON.stringify({ type: 'dispute.closed', data: { ...common, outcome: 'MERCHANT_WON' } }) });
  await pause(1_200);
  await request('/dev/mock-psp/events', { method: 'POST', body: JSON.stringify({ type: 'dispute.opened', data: common }) });
  return { providerDisputeId, note: 'The close event arrived first and will retry until the open event is processed.' };
}

const direct = new Set(['success','decline','timeout','response_lost','delayed_webhook','duplicate_webhook','temporary_500','amount_mismatch']);
let result;
if (scenario === 'full_flow') result = await fullFlow();
else if (scenario === 'out_of_order') result = await outOfOrderDispute();
else if (scenario === 'reconciliation_mismatch') result = await request('/dev/reconciliation/unknown-transaction', { method: 'POST', body: '{}' });
else if (direct.has(scenario)) result = await request(`/dev/scenarios/${scenario}`, { method: 'POST', body: '{}' });
else throw new Error(`Unknown scenario. Use: ${[...direct, 'full_flow', 'out_of_order', 'reconciliation_mismatch'].join(', ')}`);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
