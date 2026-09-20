import 'dotenv/config';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const IDS = {
  merchant: '11111111-1111-4111-8111-111111111111', merchantUser: '22222222-2222-4222-8222-222222222222',
  platformUser: '33333333-3333-4333-8333-333333333333', payment: '44444444-4444-4444-8444-444444444444',
  authorization: '55555555-5555-4555-8555-555555555551', capture: '55555555-5555-4555-8555-555555555552',
  ledgerTransaction: '66666666-6666-4666-8666-666666666666', pspAccount: '77777777-7777-4777-8777-777777777771',
  pendingAccount: '77777777-7777-4777-8777-777777777772', feeAccount: '77777777-7777-4777-8777-777777777773',
};

async function main(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL ?? 'postgres://fintech:fintech@localhost:5432/fintech_lab', { max: 1 });
  const apiKey = process.env.DEMO_API_KEY ?? 'fl_test_demo_6f414a845fe04eb4';
  try {
    await sql.begin(async (tx) => {
      await tx`insert into merchants (id,name,fee_bps,settlement_delay_days) values (${IDS.merchant},'Northstar Demo Merchant',300,0) on conflict (id) do update set name=excluded.name`;
      await tx`insert into users (id,merchant_id,email,display_name,role) values (${IDS.merchantUser},${IDS.merchant},'operator@northstar.test','Demo Merchant Admin','MERCHANT_ADMIN'),(${IDS.platformUser},null,'admin@fintech-lab.test','Platform Admin','PLATFORM_ADMIN') on conflict (id) do nothing`;
      const hash = createHash('sha256').update(apiKey).digest('hex');
      await tx`insert into api_keys (merchant_id,name,prefix,key_hash,role) values (${IDS.merchant},'Local demo key','fl_test_demo',${hash},'MERCHANT_ADMIN') on conflict (key_hash) do nothing`;
      await tx`insert into payments (id,merchant_id,status,capture_method,currency,amount,authorized_amount,captured_amount,platform_fee_amount,payment_method_token,description,authorized_at,captured_at) values (${IDS.payment},${IDS.merchant},'CAPTURED','MANUAL','USD',10000,10000,10000,300,'pm_mock_visa','Seeded notebook purchase',now()-interval '3 days',now()-interval '2 days') on conflict (id) do nothing`;
      await tx`insert into payment_attempts (id,merchant_id,payment_id,kind,status,amount,currency,provider_transaction_id,scenario,created_at,updated_at) values (${IDS.authorization},${IDS.merchant},${IDS.payment},'AUTHORIZE','SUCCEEDED',10000,'USD','mpsp_seed_authorization','SUCCESS',now()-interval '3 days',now()-interval '3 days'),(${IDS.capture},${IDS.merchant},${IDS.payment},'CAPTURE','SUCCEEDED',10000,'USD','mpsp_seed_capture','SUCCESS',now()-interval '2 days',now()-interval '2 days') on conflict (id) do nothing`;
      await tx`insert into provider_transactions (merchant_id,payment_id,provider_transaction_id,provider_idempotency_key,operation,status,amount,currency) values (${IDS.merchant},${IDS.payment},'mpsp_seed_authorization','seed:authorize','AUTHORIZE','AUTHORIZED',10000,'USD'),(${IDS.merchant},${IDS.payment},'mpsp_seed_capture','seed:capture','CAPTURE','CAPTURED',10000,'USD') on conflict do nothing`;
      await tx`insert into ledger_accounts (id,merchant_id,code,account_type,currency,name) values (${IDS.pspAccount},null,'PSP_CLEARING','ASSET','USD','PSP clearing'),(${IDS.pendingAccount},${IDS.merchant},'MERCHANT_PENDING','LIABILITY','USD','Merchant pending'),(${IDS.feeAccount},null,'PLATFORM_FEE_REVENUE','REVENUE','USD','Platform fee revenue') on conflict do nothing`;
      await tx`insert into ledger_transactions (id,merchant_id,business_type,business_id,currency,description,status,posted_at,created_at) values (${IDS.ledgerTransaction},${IDS.merchant},'CAPTURE',${IDS.capture},'USD','Seed capture','POSTED',now()-interval '2 days',now()-interval '2 days') on conflict do nothing`;
      await tx`insert into ledger_entries (id,transaction_id,account_id,currency,debit,credit,created_at) values ('88888888-8888-4888-8888-888888888881',${IDS.ledgerTransaction},${IDS.pspAccount},'USD',10000,0,now()-interval '2 days'),('88888888-8888-4888-8888-888888888882',${IDS.ledgerTransaction},${IDS.pendingAccount},'USD',0,9700,now()-interval '2 days'),('88888888-8888-4888-8888-888888888883',${IDS.ledgerTransaction},${IDS.feeAccount},'USD',0,300,now()-interval '2 days') on conflict (id) do nothing`;
      await tx`insert into audit_logs (id,merchant_id,actor_type,actor_id,action,target_type,target_id,metadata,created_at) values ('99999999-9999-4999-8999-999999999991',${IDS.merchant},'SYSTEM','seed','payment.created','payment',${IDS.payment},'{"seeded":true}',now()-interval '3 days'),('99999999-9999-4999-8999-999999999992',${IDS.merchant},'PROVIDER','mpsp_seed_authorization','payment.authorized','payment',${IDS.payment},'{"amount":10000}',now()-interval '3 days'),('99999999-9999-4999-8999-999999999993',${IDS.merchant},'PROVIDER','mpsp_seed_capture','payment.capture_succeeded','payment',${IDS.payment},'{"gross":10000,"fee":300,"net":9700}',now()-interval '2 days') on conflict (id) do nothing`;
    });
    process.stdout.write(`Seeded merchant ${IDS.merchant}\nDemo merchant user: ${IDS.merchantUser}\nPlatform user: ${IDS.platformUser}\nDemo API key: ${apiKey}\n`);
  } finally { await sql.end(); }
}

void main();
