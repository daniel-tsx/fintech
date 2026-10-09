import type { DbTransaction } from '../../src/database/database.service';
import type { DisputesService } from '../../src/disputes/disputes.service';
import type { LedgerService } from '../../src/ledger/ledger.service';
import type { OutboxService } from '../../src/outbox/outbox.service';
import type { RefundsService } from '../../src/refunds/refunds.service';
import { WebhookBusinessService } from '../../src/webhooks/webhook-business.service';
import type { ProviderEvent } from '../../src/webhooks/webhook.types';

describe('WebhookBusinessService capture completion', () => {
  it('validates references and posts the internal capture journal before updating state', async () => {
    const queries: string[] = [];
    const tx = jest.fn((strings: TemplateStringsArray) => {
      const query = strings.join('?'); queries.push(query);
      if (query.includes('from public.payments')) return Promise.resolve([{ merchant_id: 'merchant-1', currency: 'USD' }]);
      if (query.includes('insert into public.capture_accounting_lots')) return Promise.resolve([{ id: 'lot-1' }]);
      if (query.includes('from payment_attempts where id=')) return Promise.resolve([{
        status: 'PROCESSING', amount: '2500', merchant_id: 'merchant-1', payment_id: 'payment-1', currency: 'USD', provider_transaction_id: 'pi_123',
      }]);
      if (query.includes('from payments where id=')) return Promise.resolve([{
        id: 'payment-1', merchant_id: 'merchant-1', status: 'CAPTURE_PENDING', capture_method: 'MANUAL', amount: '2500', authorized_amount: '2500',
        captured_amount: '0', refunded_amount: '0', platform_fee_amount: '0', currency: 'USD',
      }]);
      if (query.includes('select fee_bps')) return Promise.resolve([{ fee_bps: 300, fixed_fee_minor: '0', settlement_delay_days: 2 }]);
      return Promise.resolve([]);
    }) as unknown as DbTransaction;
    const post = jest.fn().mockResolvedValue('journal-1');
    const append = jest.fn().mockResolvedValue(undefined);
    const service = new WebhookBusinessService(
      { post } as unknown as LedgerService,
      {} as OutboxService,
      { append },
      {} as RefundsService,
      {} as DisputesService,
    );
    const event: ProviderEvent = {
      id: 'evt_123', type: 'payment.capture_succeeded', externalType: 'payment_intent.succeeded', createdAt: new Date(0).toISOString(),
      data: { merchantId: 'merchant-1', paymentId: 'payment-1', attemptId: 'attempt-1', providerTransactionId: 'pi_123', paymentIntentId: 'pi_123', chargeId: 'ch_123', amount: 2500, currency: 'USD', providerStatus: 'succeeded' },
    };

    await service.handle(tx, event);

    expect(post).toHaveBeenCalledWith(tx, expect.objectContaining({ merchantId: 'merchant-1', businessType: 'CAPTURE', businessId: 'attempt-1', currency: 'USD' }));
    expect(queries.some((query) => query.includes("update payment_attempts set status='SUCCEEDED'"))).toBe(true);
    expect(queries.some((query) => query.includes('update payments set status='))).toBe(true);
    expect(append).toHaveBeenCalled();
  });
});
