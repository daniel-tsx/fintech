import { randomUUID } from 'node:crypto';
import { DatabaseService, type DbTransaction } from '../../src/database/database.service';
import { LedgerService } from '../../src/ledger/ledger.service';

export async function captureFixture(database: DatabaseService, gross = 10000, fee = 300, scope?: { merchantId: string; paymentId: string }) {
  const merchantId = scope?.merchantId ?? randomUUID(); const paymentId = scope?.paymentId ?? randomUUID();
  const attemptId = randomUUID(); const ledger = new LedgerService(database);
  if (!scope) {
    await database.sql`insert into merchants (id,name,fee_bps,settlement_delay_days) values (${merchantId},'B1 isolated fixture',300,0)`;
    await database.sql`insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,captured_amount,platform_fee_amount,payment_method_token)
      values (${paymentId},${merchantId},'CAPTURED','MANUAL','USD',${gross},${gross},${gross},${fee},'pm_test')`;
  } else {
    await database.sql`update payments set amount=amount+${gross},authorized_amount=authorized_amount+${gross},captured_amount=captured_amount+${gross},platform_fee_amount=platform_fee_amount+${fee} where id=${paymentId}`;
  }
  await database.sql`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id,updated_at)
    values (${attemptId},${merchantId},${paymentId},'CAPTURE','SUCCEEDED',${gross},'USD',${`pi_${paymentId}`},now()-interval '1 day')`;
  const journalId = await database.transaction((tx) => ledger.post(tx, { merchantId, businessType: 'CAPTURE', businessId: attemptId,
    currency: 'USD', description: 'B1 capture fixture', lines: [
      { accountCode: 'PSP_CLEARING',merchantId:null,debit:gross },
      ...(gross-fee ? [{ accountCode:'MERCHANT_PENDING' as const,merchantId,credit:gross-fee }] : []),
      ...(fee ? [{ accountCode:'PLATFORM_FEE_REVENUE' as const,merchantId:null,credit:fee }] : []),
    ] }));
  return { merchantId,paymentId,attemptId,journalId,gross,fee };
}

export async function accountContributions(tx: DbTransaction, merchantId: string) {
  // Platform accounts are pooled. Attribute only journals belonging to this fixture merchant.
  const rows = await tx<{code:string;balance:string}[]>`select a.code,
    sum(case when a.account_type in ('ASSET','EXPENSE') then e.debit-e.credit else e.credit-e.debit end)::text as balance
    from ledger_transactions t join ledger_entries e on e.transaction_id=t.id join ledger_accounts a on a.id=e.account_id
    where t.merchant_id=${merchantId} and t.status='POSTED' group by a.code`;
  return Object.fromEntries(rows.map((row) => [row.code,row.balance]));
}
