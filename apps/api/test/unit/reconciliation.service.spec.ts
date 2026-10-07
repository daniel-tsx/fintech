import type { AuditService } from '../../src/audit/audit.service';
import type { DatabaseService } from '../../src/database/database.service';
import type { PaymentProvider, ProviderStatus } from '../../src/payment-provider/payment-provider.types';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';

describe('ReconciliationService with external provider state', () => {
  it('detects webhook gaps, missing provider objects, and amount/currency mismatches without repairing state', async () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const internalRows = [
      internal({ payment_id: 'payment-pending', payment_status: 'CAPTURE_PENDING', attempt_status: 'PROCESSING', provider_transaction_id: 'pi_succeeded' }),
      internal({ payment_id: 'payment-missing', payment_status: 'CAPTURED', attempt_status: 'SUCCEEDED', provider_transaction_id: 'pi_missing' }),
      internal({ payment_id: 'payment-mismatch', payment_status: 'CAPTURED', attempt_status: 'SUCCEEDED', provider_transaction_id: 'pi_mismatch' }),
    ];
    const sql = Object.assign(jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?'); calls.push({ query, values });
      if (query.includes('insert into reconciliation_runs')) return Promise.resolve([{ id: 'run-1' }]);
      if (query.includes('select a.payment_id')) return Promise.resolve(internalRows);
      if (query.includes('count(*)::text')) return Promise.resolve([{ total: '4' }]);
      return Promise.resolve([]);
    }), { json: (value: unknown) => value });
    const database = { sql } as unknown as DatabaseService;
    const fetchStatus = jest.fn(({ providerObjectId }: { providerObjectId: string }): Promise<ProviderStatus | null> => {
      if (providerObjectId === 'pi_missing') return Promise.resolve(null);
      if (providerObjectId === 'pi_mismatch') return Promise.resolve(providerState({ providerObjectId, amount: 999, capturedAmount: 999, currency: 'EUR' }));
      return Promise.resolve(providerState({ providerObjectId, status: 'succeeded' }));
    });
    const provider = { fetchStatus } as unknown as PaymentProvider;
    const service = new ReconciliationService(database, provider, {} as AuditService);

    await expect(service.run()).resolves.toEqual({ runId: 'run-1', issues: 4 });
    const issueTypes = calls.filter((call) => call.query.includes('insert into reconciliation_issues')).flatMap((call) => call.values);
    expect(issueTypes).toEqual(expect.arrayContaining([
      'PROVIDER_CAPTURED_INTERNAL_PENDING',
      'INTERNAL_CAPTURE_MISSING_PROVIDER',
      'AMOUNT_OR_CURRENCY_MISMATCH',
      'CAPTURED_AMOUNT_MISMATCH',
    ]));
  });
});

function internal(overrides: Record<string, unknown>) {
  return {
    payment_id: 'payment-1', merchant_id: 'merchant-1', payment_status: 'CAPTURED', attempt_status: 'SUCCEEDED',
    provider_transaction_id: 'pi_123', amount: '1000', currency: 'USD', payment_amount: '1000', captured_amount: '1000', ...overrides,
  };
}

function providerState(overrides: Partial<ProviderStatus>): ProviderStatus {
  return {
    providerObjectId: 'pi_123', paymentIntentId: 'pi_123', status: 'succeeded', metadata: {},
    amount: 1000, capturedAmount: 1000, currency: 'USD', ...overrides,
  };
}
