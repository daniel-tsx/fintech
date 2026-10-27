import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import Stripe from 'stripe';
import { AuditService } from '../../src/audit/audit.service';
import { IdempotencyService } from '../../src/common/idempotency.service';
import { DisputesService } from '../../src/disputes/disputes.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import type { PaymentProvider, ProviderStatus } from '../../src/payment-provider/payment-provider.types';
import { PaymentsService } from '../../src/payments/payments.service';
import { PayoutsService } from '../../src/payouts/payouts.service';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { RefundsService } from '../../src/refunds/refunds.service';
import { SettlementsService } from '../../src/settlements/settlements.service';
import { WebhookBusinessService } from '../../src/webhooks/webhook-business.service';
import { WebhookProcessorService } from '../../src/webhooks/webhook-processor.service';
import { WebhookReceiverService } from '../../src/webhooks/webhook-receiver.service';
import { accountContributions } from '../support/accounting-fixtures';
import { providerObservationHarness } from '../support/provider-observation-harness';

const describeDb = process.env.RUN_DB_TESTS === '1' && process.env.RUN_MIGRATION_TESTS === '1' ? describe : describe.skip;
describeDb('R2-A.1 same legacy writers before and after the additive0009 upgrade', () => {
  let h: Awaited<ReturnType<typeof providerObservationHarness>>, ledger: LedgerService, payments: PaymentsService, refunds: RefundsService;
  let settlements: SettlementsService, payouts: PayoutsService, receiver: WebhookReceiverService, processor: WebhookProcessorService, reconciliation: ReconciliationService;
  const folder = resolve(__dirname, '../../drizzle'), baseline = new Map<string, unknown>(), states = new Map<string, ProviderStatus>();
  const stripe = new Stripe('sk_test_r2a1_legacy_fixture'), secret = 'whsec_r2a1_legacy_fixture';
  beforeAll(async () => {
    const staged = resolve(__dirname, `../../../../.tmp/r2a1-legacy-before10-${randomUUID()}`);
    mkdirSync(resolve(staged, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(resolve(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter(e => e.idx < 10); writeFileSync(resolve(staged, 'meta/_journal.json'), JSON.stringify(journal));
    for (const e of journal.entries) copyFileSync(resolve(folder, e.tag + '.sql'), resolve(staged, e.tag + '.sql'));
    h = await providerObservationHarness(staged);
    ledger = new LedgerService(h.db); const audit = new AuditService(), idem = new IdempotencyService(h.db), outbox = new OutboxService();
    payments = new PaymentsService(h.db, idem, outbox, audit); refunds = new RefundsService(h.db, idem, outbox, audit, ledger);
    settlements = new SettlementsService(h.db, ledger, audit); payouts = new PayoutsService(h.db, idem, ledger, outbox, audit);
    receiver = new WebhookReceiverService(new ConfigService({ STRIPE_WEBHOOK_SECRET: secret }), h.db, stripe);
    processor = new WebhookProcessorService(h.db, new WebhookBusinessService(ledger, outbox, audit, refunds, new DisputesService(ledger, audit)));
    const forbidden = (): Promise<never> => Promise.reject(new Error('Provider execution is prohibited in compatibility tests'));
    const provider: PaymentProvider = { authorize: forbidden, capture: forbidden, cancel: forbidden, refund: forbidden,
      fetchStatus: query => Promise.resolve(states.get(query.providerObjectId) ?? null) };
    reconciliation = new ReconciliationService(h.db, provider, audit);
  }, 30000);
  afterAll(async () => { if (h) await h.close(); });
  async function fingerprint() {
    const result: Record<string, unknown> = {};
    for (const table of ['payments','payment_attempts','provider_transactions','refunds','disputes','settlements','settlement_items','payouts','ledger_transactions','ledger_entries',
      'capture_accounting_lots','webhook_events','outbox_events','idempotency_keys','audit_logs','reconciliation_runs','reconciliation_issues'])
      result[table] = (await h.db.sql.unsafe(`select md5(coalesce(string_agg(j,'|' order by j),'')) hash from (select to_jsonb(t)::text j from public.${table} t) s`))[0].hash;
    return result;
  }
  async function deliver(type: string, object: Record<string, unknown>) {
    const raw = Buffer.from(JSON.stringify({ id: `evt_${randomUUID()}`, object: 'event', created: Math.floor(Date.now() / 1000), type, data: { object } }));
    const signature = stripe.webhooks.generateTestHeaderString({ payload: raw.toString('utf8'), secret });
    const result = await receiver.receive(raw, signature); expect(await processor.drain()).toBe(1);
    expect((await h.db.sql`select status from webhook_events where id=${result.id}`)[0].status).toBe('PROCESSED');
    return { raw, signature, id: result.id };
  }
  async function capture() {
    const merchantId = randomUUID(), pi = `pi_${randomUUID().replaceAll('-', '')}`;
    await h.db.sql`insert into merchants(id,name,fee_bps,settlement_delay_days) values(${merchantId},'R2-A.1 legacy compatibility',300,0)`;
    const actor = { id: randomUUID(), type: 'API_KEY' as const, role: 'MERCHANT_ADMIN' as const, merchantId };
    const created = await payments.create(actor, randomUUID(), { amount: 10000, currency: 'USD', paymentMethodToken: 'pm_legacy_fixture', captureMethod: 'MANUAL', confirm: false });
    const paymentId = String(created.value.id), authKey = randomUUID();
    const accepted = await payments.authorize(actor, paymentId, authKey);
    expect(await payments.authorize(actor, paymentId, authKey)).toEqual({ ...accepted, replayed: true });
    const authorizeId = String((await h.db.sql`select id from payment_attempts where payment_id=${paymentId} and kind='AUTHORIZE'`)[0].id);
    await h.db.sql`insert into provider_transactions(merchant_id,payment_id,payment_attempt_id,provider,provider_transaction_id,payment_intent_id,provider_idempotency_key,operation,status,amount,currency)
      values(${merchantId},${paymentId},${authorizeId},'STRIPE',${pi},${pi},${`authorize:${authorizeId}`},'AUTHORIZE','fixture',10000,'USD')`;
    await deliver('payment_intent.amount_capturable_updated', { id: pi, object: 'payment_intent', amount: 10000, amount_capturable: 10000, amount_received: 0,
      currency: 'usd', status: 'requires_capture', metadata: { merchantId, paymentId, authorizeAttemptId: authorizeId } });
    expect((await h.db.sql`select status,authorized_amount::text from payments where id=${paymentId}`)[0]).toEqual({ status: 'AUTHORIZED', authorized_amount: '10000' });
    const captureKey = randomUUID(), request = await payments.capture(actor, paymentId, captureKey, { amount: 10000 });
    expect(await payments.capture(actor, paymentId, captureKey, { amount: 10000 })).toEqual({ ...request, replayed: true });
    const attemptId = String(request.value.captureAttemptId);
    await h.db.sql`insert into provider_transactions(merchant_id,payment_id,payment_attempt_id,provider,provider_transaction_id,payment_intent_id,provider_idempotency_key,operation,status,amount,currency)
      values(${merchantId},${paymentId},${attemptId},'STRIPE',${pi},${pi},${`capture:${attemptId}`},'CAPTURE','fixture',10000,'USD')`;
    const signed = await deliver('payment_intent.succeeded', { id: pi, object: 'payment_intent', amount: 10000, amount_received: 10000, currency: 'usd', status: 'succeeded',
      latest_charge: `ch_${attemptId}`, metadata: { merchantId, paymentId, captureAttemptId: attemptId, captureAmount: '10000' } });
    expect(await receiver.receive(signed.raw, signed.signature)).toEqual({ id: signed.id, duplicate: true });
    expect(await processor.drain()).toBe(0);
    states.set(pi, { providerObjectId: pi, paymentIntentId: pi, amount: 10000, capturedAmount: 10000, currency: 'USD', status: 'succeeded', metadata: {} });
    return { merchantId, paymentId, attemptId, actor, pi };
  }
  type Fixture = Awaited<ReturnType<typeof capture>>;
  const balances = (f: Fixture) => h.db.transaction(tx => accountContributions(tx, f.merchantId));
  async function settle(f: Fixture) {
    const ids = await settlements.generate(f.merchantId); expect(ids).toHaveLength(1);
    await h.db.transaction(tx => settlements.complete(tx, ids[0])); await h.db.transaction(tx => settlements.complete(tx, ids[0]));
    return ids[0];
  }
  function compare(phase: string, name: string, result: unknown) {
    if (phase === '0009') baseline.set(name, result);
    else { expect(baseline.has(name)).toBe(true); expect(result).toEqual(baseline.get(name)); }
  }
  describe.each(['0009', '0010', '0011', '0012', '0013', '0014', '0015'])('schema %s', phase => {
    beforeAll(async () => {
      if (phase !== '0009') {
        let source = folder;
        if (phase !== '0015') {
          source = resolve(__dirname, `../../../../.tmp/r2b1-legacy-through10-${randomUUID()}`);
          mkdirSync(resolve(source, 'meta'), { recursive: true });
          const journal = JSON.parse(readFileSync(resolve(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
          journal.entries = journal.entries.filter(e => e.idx < Number(phase) + 1);
          writeFileSync(resolve(source, 'meta/_journal.json'), JSON.stringify(journal));
          for (const e of journal.entries) copyFileSync(resolve(folder, e.tag + '.sql'), resolve(source, e.tag + '.sql'));
        }
        const before = await fingerprint(), url = new URL(process.env.MIGRATION_ADMIN_URL!);
        url.pathname = '/' + String((await h.db.sql`select current_database() n`)[0].n); const sql = postgres(url.toString(), { max: 1 });
        try { await migrate(drizzle(sql), { migrationsFolder: source }); } finally { await sql.end(); }
        expect(await fingerprint()).toEqual(before);
      }
      expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(Number(phase) + 1);
    }, 30000);
    afterAll(async () => {
      expect((await h.db.sql`select count(*)::int n from capture_accounting_scopes where status='ACTIVE'`)[0].n).toBe(0);
      if (phase !== '0009') for (const table of ['financial_application_scope_authority','financial_application_contracts','financial_application_roots','financial_application_permits','financial_applications','financial_application_dispositions'])
        expect(await h.db.sql.unsafe(`select 1 from public.${table}`)).toHaveLength(0);
    });
    it('authorization/capture, signed inbox, mirrors, idempotency and original lots retain their behavior', async () => {
      const f = await capture();
      const payment = (await h.db.sql`select status,authorized_amount::text,captured_amount::text,platform_fee_amount::text from payments where id=${f.paymentId}`)[0];
      expect(payment).toEqual({ status: 'CAPTURED', authorized_amount: '10000', captured_amount: '10000', platform_fee_amount: '300' });
      const lot = (await h.db.sql`select original_gross::text,original_fee::text,original_net::text from capture_accounting_lots where capture_attempt_id=${f.attemptId}`)[0];
      expect(lot).toEqual({ original_gross: '10000', original_fee: '300', original_net: '9700' });
      const mirrors = await h.db.sql`select operation,status from provider_transactions where payment_id=${f.paymentId} order by operation`;
      // Existing mirror updates match the shared PI as well as the attempt.
      // Preserve this legacy behavior; D02 immutable sources are a different path.
      expect(mirrors).toEqual([{ operation: 'AUTHORIZE', status: 'succeeded' }, { operation: 'CAPTURE', status: 'succeeded' }]);
      const money = await balances(f); expect(money).toEqual({ PSP_CLEARING: '10000', MERCHANT_PENDING: '9700', PLATFORM_FEE_REVENUE: '300' });
      compare(phase, 'capture', { payment, lot, mirrors, money });
    });
    it('refund acceptance/completion uses the same2000 principal and60 fee reversal', async () => {
      const f = await capture(), key = randomUUID(), accepted = await refunds.create(f.actor, f.paymentId, key, { amount: 2000 });
      expect(await refunds.create(f.actor, f.paymentId, key, { amount: 2000 })).toEqual({ ...accepted, replayed: true });
      const refundId = String(accepted.value.id);
      await deliver('refund.updated', { id: `re_${refundId}`, object: 'refund', amount: 2000, currency: 'usd', status: 'succeeded', payment_intent: f.pi,
        metadata: { merchantId: f.merchantId, paymentId: f.paymentId, refundId } });
      const refund = (await h.db.sql`select status,amount::text,platform_fee_amount::text from refunds where id=${refundId}`)[0];
      expect(refund).toEqual({ status: 'SUCCEEDED', amount: '2000', platform_fee_amount: '60' });
      const money = await balances(f); expect(money).toEqual({ PSP_CLEARING: '8000', MERCHANT_PENDING: '7760', PLATFORM_FEE_REVENUE: '300', PLATFORM_FEE_REFUNDS: '60' });
      compare(phase, 'refund', { refund, money });
    });
    it('dispute open/win restores the original pending entitlement without new application authority', async () => {
      const f = await capture(), disputeId = `dp_${randomUUID()}`, object = { id: disputeId, object: 'dispute', amount: 2000, currency: 'usd', payment_intent: f.pi,
        metadata: { merchantId: f.merchantId, paymentId: f.paymentId } };
      await deliver('charge.dispute.created', { ...object, status: 'needs_response' });
      expect(await balances(f)).toEqual({ PSP_CLEARING: '10000', MERCHANT_PENDING: '7700', PLATFORM_FEE_REVENUE: '300', DISPUTE_CLEARING: '2000' });
      await deliver('charge.dispute.closed', { ...object, status: 'won' });
      const dispute = (await h.db.sql`select status,outcome from disputes where provider_dispute_id=${disputeId}`)[0];
      expect(dispute).toEqual({ status: 'CLOSED', outcome: 'MERCHANT_WON' });
      const money = await balances(f); expect(money).toEqual({ PSP_CLEARING: '10000', MERCHANT_PENDING: '9700', PLATFORM_FEE_REVENUE: '300', DISPUTE_CLEARING: '0' });
      compare(phase, 'dispute', { dispute, money });
    });
    it('settlement generation/completion preserves legacy policy and original POSTED history', async () => {
      const f = await capture(), id = await settle(f);
      const row = (await h.db.sql`select status,gross_amount::text,net_amount::text,accounting_policy_version from settlements where id=${id}`)[0];
      expect(row).toEqual({ status: 'SUCCEEDED', gross_amount: '10000', net_amount: '9700', accounting_policy_version: null });
      const money = await balances(f); expect(money).toEqual({ PSP_CLEARING: '0', PLATFORM_CASH: '10000', MERCHANT_PENDING: '0', MERCHANT_AVAILABLE: '9700', PLATFORM_FEE_REVENUE: '300' });
      const journal = String((await h.db.sql`select id from ledger_transactions where business_type='CAPTURE' and business_id=${f.attemptId}`)[0].id);
      await expect(h.db.sql`update ledger_entries set debit=debit where transaction_id=${journal}`).rejects.toThrow(/immutable/);
      compare(phase, 'settlement', { row, money });
    });
    it('payout reservation/completion leaves1700 available and no duplicate completion journal', async () => {
      const f = await capture(); await settle(f);
      const accepted = await payouts.request(f.actor, randomUUID(), { amount: 8000, currency: 'USD', destinationToken: 'bank_local_fixture' }), id = String(accepted.value.id);
      expect(await balances(f)).toEqual({ PSP_CLEARING: '0', PLATFORM_CASH: '10000', MERCHANT_PENDING: '0', MERCHANT_AVAILABLE: '1700', PAYOUT_CLEARING: '8000', PLATFORM_FEE_REVENUE: '300' });
      await h.db.transaction(tx => payouts.complete(tx, id)); await h.db.transaction(tx => payouts.complete(tx, id));
      const money = await balances(f); expect(money).toEqual({ PSP_CLEARING: '0', PLATFORM_CASH: '2000', MERCHANT_PENDING: '0', MERCHANT_AVAILABLE: '1700', PAYOUT_CLEARING: '0', PLATFORM_FEE_REVENUE: '300' });
      const journals = await h.db.sql`select business_type,count(*)::int n from ledger_transactions where business_id=${id} group by business_type order by business_type`;
      expect(journals).toEqual([{ business_type: 'PAYOUT_COMPLETION', n: 1 }, { business_type: 'PAYOUT_RESERVATION', n: 1 }]);
      compare(phase, 'payout', { money, journals });
    });
    it('matched reconciliation and existing note-only issue resolution preserve financial history', async () => {
      const f = await capture(), before = await balances(f), result = await reconciliation.run(); expect(result.issues).toBe(0);
      // Existing review fixture, not a claimed provider discrepancy. This tests
      // the actual resolve path separately from the pre-existing issue INSERT bug.
      const issue = (await h.db.sql`insert into reconciliation_issues(run_id,merchant_id,payment_id,provider_transaction_id,issue_type,severity,internal_snapshot,provider_snapshot)
        values(${result.runId},${f.merchantId},${f.paymentId},${f.pi},'LOCAL_COMPATIBILITY_REVIEW_FIXTURE','HIGH','{}','{}') returning id`)[0];
      await reconciliation.resolve(f.actor, String(issue.id), 'Local review fixture; no financial repair');
      const row = (await h.db.sql`select issue_type,status from reconciliation_issues where id=${String(issue.id)}`)[0];
      expect(row).toEqual({ issue_type: 'LOCAL_COMPATIBILITY_REVIEW_FIXTURE', status: 'RESOLVED' }); expect(await balances(f)).toEqual(before);
      compare(phase, 'reconciliation', { row, money: before });
    });
    it('preserves the independently reproduced baseline42601 issue-publication failure', async () => {
      const f = await capture(), before = await balances(f), state = states.get(f.pi)!;
      const failures = Number((await h.db.sql`select count(*)::int n from reconciliation_runs where status='FAILED'`)[0].n);
      states.set(f.pi, { ...state, capturedAmount: 9999 });
      try {
        // Do not silently fix or suppress this existing runtime SQL defect as
        // part of the migration correction. It occurs before AND after0010.
        await expect(reconciliation.run()).rejects.toMatchObject({ code: '42601', message: 'syntax error at end of input' });
        expect(Number((await h.db.sql`select count(*)::int n from reconciliation_runs where status='FAILED'`)[0].n)).toBe(failures + 1);
        expect(await h.db.sql`select 1 from reconciliation_issues where payment_id=${f.paymentId}`).toHaveLength(0);
        expect(await balances(f)).toEqual(before);
        compare(phase, 'baseline reconciliation defect', { sqlState: '42601', failedRunDelta: 1, money: before });
      } finally { states.set(f.pi, state); }
    });
  });
});
