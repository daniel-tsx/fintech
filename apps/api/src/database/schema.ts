import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['PLATFORM_ADMIN', 'MERCHANT_ADMIN', 'MERCHANT_OPERATOR']);
export const paymentStatus = pgEnum('payment_status', [
  'CREATED', 'REQUIRES_AUTHORIZATION', 'AUTHORIZED', 'CAPTURE_PENDING', 'CAPTURED',
  'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED',
]);
export const captureMethod = pgEnum('capture_method', ['MANUAL', 'AUTOMATIC']);
export const operationStatus = pgEnum('operation_status', ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED']);
export const inboxStatus = pgEnum('inbox_status', ['PENDING', 'PROCESSING', 'PROCESSED', 'RETRY', 'IGNORED', 'DEAD']);
export const outboxStatus = pgEnum('outbox_status', ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD']);
export const ledgerAccountType = pgEnum('ledger_account_type', ['ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE']);
export const ledgerStatus = pgEnum('ledger_status', ['DRAFT', 'POSTED', 'REVERSED']);

const money = (name: string) => bigint(name, { mode: 'number' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const merchants = pgTable('merchants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  feeBps: integer('fee_bps').notNull().default(300),
  fixedFeeMinor: money('fixed_fee_minor').notNull().default(0),
  settlementDelayDays: integer('settlement_delay_days').notNull().default(2),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [check('merchants_fee_bps_check', sql`${t.feeBps} between 0 and 10000`)]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').references(() => merchants.id),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: userRole('role').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('users_email_unique').on(t.email)]);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  name: text('name').notNull(), prefix: text('prefix').notNull(), keyHash: text('key_hash').notNull(),
  role: userRole('role').notNull().default('MERCHANT_ADMIN'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }), createdAt: createdAt(),
}, (t) => [uniqueIndex('api_keys_hash_unique').on(t.keyHash), index('api_keys_prefix_idx').on(t.prefix)]);

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  externalReference: text('external_reference'), email: text('email'), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('customers_merchant_external_unique').on(t.merchantId, t.externalReference)]);

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  customerId: uuid('customer_id').references(() => customers.id), status: paymentStatus('status').notNull().default('CREATED'),
  captureMethod: captureMethod('capture_method').notNull().default('MANUAL'), currency: text('currency').notNull(),
  amount: money('amount').notNull(), authorizedAmount: money('authorized_amount').notNull().default(0),
  capturedAmount: money('captured_amount').notNull().default(0), refundedAmount: money('refunded_amount').notNull().default(0),
  platformFeeAmount: money('platform_fee_amount').notNull().default(0),
  paymentMethodToken: text('payment_method_token').notNull(), description: text('description'),
  metadata: jsonb('metadata').notNull().default({}), version: integer('version').notNull().default(0),
  authorizedAt: timestamp('authorized_at', { withTimezone: true }), capturedAt: timestamp('captured_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  check('payments_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`), check('payments_amount_check', sql`${t.amount} > 0`),
  check('payments_amounts_range_check', sql`${t.authorizedAmount} >= 0 and ${t.authorizedAmount} <= ${t.amount} and ${t.capturedAmount} >= 0 and ${t.capturedAmount} <= ${t.amount} and ${t.refundedAmount} >= 0 and ${t.refundedAmount} <= ${t.capturedAmount}`),
  index('payments_merchant_created_idx').on(t.merchantId, t.createdAt), index('payments_status_idx').on(t.status),
]);

export const paymentAttempts = pgTable('payment_attempts', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  paymentId: uuid('payment_id').notNull().references(() => payments.id), kind: text('kind').notNull(),
  status: operationStatus('status').notNull().default('PENDING'), amount: money('amount').notNull(), currency: text('currency').notNull(),
  providerTransactionId: text('provider_transaction_id'), failureCode: text('failure_code'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('attempts_payment_idx').on(t.paymentId, t.createdAt)]);

export const providerTransactions = pgTable('provider_transactions', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  paymentId: uuid('payment_id').references(() => payments.id), paymentAttemptId: uuid('payment_attempt_id').references(() => paymentAttempts.id), refundId: uuid('refund_id'),
  provider: text('provider').notNull().default('STRIPE'), providerTransactionId: text('provider_transaction_id').notNull(),
  paymentIntentId: text('payment_intent_id'), chargeId: text('charge_id'),
  providerIdempotencyKey: text('provider_idempotency_key').notNull(), operation: text('operation').notNull(),
  status: text('status').notNull(), amount: money('amount').notNull(), currency: text('currency').notNull(),
  rawResponse: jsonb('raw_response').notNull().default({}), lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('provider_tx_idempotency_unique').on(t.provider, t.providerIdempotencyKey),
  index('provider_tx_object_idx').on(t.provider, t.providerTransactionId),
  index('provider_tx_payment_idx').on(t.paymentId),
  index('provider_tx_attempt_idx').on(t.paymentAttemptId),
]);

export const refunds = pgTable('refunds', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  paymentId: uuid('payment_id').notNull().references(() => payments.id), status: operationStatus('status').notNull().default('PENDING'),
  amount: money('amount').notNull(), platformFeeAmount: money('platform_fee_amount').notNull().default(0), currency: text('currency').notNull(),
  reason: text('reason'), providerTransactionId: text('provider_transaction_id'), failureCode: text('failure_code'), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [check('refund_amount_check', sql`${t.amount} > 0`), index('refunds_payment_idx').on(t.paymentId, t.createdAt)]);

export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(), provider: text('provider').notNull(), providerEventId: text('provider_event_id').notNull(),
  eventType: text('event_type').notNull(), signature: text('signature').notNull(), payload: jsonb('payload').notNull(), headers: jsonb('headers').notNull().default({}),
  status: inboxStatus('status').notNull().default('PENDING'), attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(), lockedAt: timestamp('locked_at', { withTimezone: true }),
  processedAt: timestamp('processed_at', { withTimezone: true }), lastError: text('last_error'), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('webhook_provider_event_unique').on(t.provider, t.providerEventId), index('webhook_pending_idx').on(t.status, t.availableAt)]);

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  operation: text('operation').notNull(), key: text('key').notNull(), requestHash: text('request_hash').notNull(),
  status: text('status').notNull().default('IN_PROGRESS'), responseStatus: integer('response_status'), responseBody: jsonb('response_body'),
  resourceType: text('resource_type'), resourceId: uuid('resource_id'), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('idempotency_scope_unique').on(t.merchantId, t.operation, t.key)]);

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').references(() => merchants.id),
  code: text('code').notNull(), accountType: ledgerAccountType('account_type').notNull(), currency: text('currency').notNull(), name: text('name').notNull(), createdAt: createdAt(),
}, (t) => [index('ledger_accounts_lookup_idx').on(t.merchantId, t.currency, t.code)]);

// Forward SQL migrations own journal sealing and deferred balance/immutability
// triggers; Drizzle's table definitions do not represent those guarantees.
export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').references(() => merchants.id),
  businessType: text('business_type').notNull(), businessId: uuid('business_id').notNull(), currency: text('currency').notNull(),
  description: text('description').notNull(), status: ledgerStatus('status').notNull().default('DRAFT'),
  reversalOfId: uuid('reversal_of_id'), createdAt: createdAt(), postedAt: timestamp('posted_at', { withTimezone: true }),
}, (t) => [uniqueIndex('ledger_business_unique').on(t.businessType, t.businessId, t.currency), index('ledger_tx_merchant_idx').on(t.merchantId, t.createdAt)]);

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(), transactionId: uuid('transaction_id').notNull().references(() => ledgerTransactions.id),
  accountId: uuid('account_id').notNull().references(() => ledgerAccounts.id), currency: text('currency').notNull(),
  debit: money('debit').notNull().default(0), credit: money('credit').notNull().default(0), createdAt: createdAt(),
}, (t) => [check('ledger_entry_one_side_check', sql`(${t.debit} > 0 and ${t.credit} = 0) or (${t.credit} > 0 and ${t.debit} = 0)`), index('ledger_entries_tx_idx').on(t.transactionId), index('ledger_entries_account_idx').on(t.accountId)]);

export const settlements = pgTable('settlements', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  currency: text('currency').notNull(), status: operationStatus('status').notNull().default('PENDING'),
  grossAmount: money('gross_amount').notNull().default(0), feeAmount: money('fee_amount').notNull().default(0), netAmount: money('net_amount').notNull().default(0),
  availableOn: timestamp('available_on', { withTimezone: true }).notNull(), providerReference: text('provider_reference'), completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const settlementItems = pgTable('settlement_items', {
  id: uuid('id').primaryKey().defaultRandom(), settlementId: uuid('settlement_id').notNull().references(() => settlements.id),
  paymentId: uuid('payment_id').notNull().references(() => payments.id), captureAttemptId: uuid('capture_attempt_id').notNull().references(() => paymentAttempts.id),
  grossAmount: money('gross_amount').notNull(), feeAmount: money('fee_amount').notNull(), netAmount: money('net_amount').notNull(), currency: text('currency').notNull(), createdAt: createdAt(),
}, (t) => [uniqueIndex('settlement_capture_unique').on(t.captureAttemptId)]);

export const payouts = pgTable('payouts', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  status: operationStatus('status').notNull().default('PENDING'), amount: money('amount').notNull(), currency: text('currency').notNull(),
  destinationToken: text('destination_token').notNull(), providerReference: text('provider_reference'), failureCode: text('failure_code'),
  createdAt: createdAt(), updatedAt: updatedAt(), completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [check('payout_amount_check', sql`${t.amount} > 0`), index('payouts_merchant_idx').on(t.merchantId, t.createdAt)]);

export const disputes = pgTable('disputes', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  paymentId: uuid('payment_id').notNull().references(() => payments.id), providerDisputeId: text('provider_dispute_id').notNull(),
  status: text('status').notNull(), outcome: text('outcome'), amount: money('amount').notNull(), currency: text('currency').notNull(),
  sourceAccountCode: text('source_account_code'), openedAt: timestamp('opened_at', { withTimezone: true }).notNull(), closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('disputes_provider_unique').on(t.providerDisputeId)]);

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().defaultRandom(), aggregateType: text('aggregate_type').notNull(), aggregateId: uuid('aggregate_id').notNull(),
  eventType: text('event_type').notNull(), payload: jsonb('payload').notNull(), status: outboxStatus('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0), availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }), publishedAt: timestamp('published_at', { withTimezone: true }),
  lastError: text('last_error'), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('outbox_pending_idx').on(t.status, t.availableAt)]);

export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: uuid('id').primaryKey().defaultRandom(), status: operationStatus('status').notNull().default('PENDING'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp('completed_at', { withTimezone: true }), summary: jsonb('summary').notNull().default({}),
});

export const reconciliationIssues = pgTable('reconciliation_issues', {
  id: uuid('id').primaryKey().defaultRandom(), runId: uuid('run_id').notNull().references(() => reconciliationRuns.id),
  merchantId: uuid('merchant_id').references(() => merchants.id), paymentId: uuid('payment_id').references(() => payments.id),
  providerTransactionId: text('provider_transaction_id'), issueType: text('issue_type').notNull(), severity: text('severity').notNull(),
  internalSnapshot: jsonb('internal_snapshot').notNull().default({}), providerSnapshot: jsonb('provider_snapshot').notNull().default({}),
  status: text('status').notNull().default('OPEN'), resolutionNote: text('resolution_note'), resolvedBy: uuid('resolved_by').references(() => users.id),
  createdAt: createdAt(), resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [index('reconciliation_open_idx').on(t.status, t.createdAt)]);

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').references(() => merchants.id), actorType: text('actor_type').notNull(),
  actorId: text('actor_id'), action: text('action').notNull(), targetType: text('target_type').notNull(), targetId: text('target_id').notNull(),
  correlationId: text('correlation_id'), metadata: jsonb('metadata').notNull().default({}), createdAt: createdAt(),
}, (t) => [index('audit_target_idx').on(t.targetType, t.targetId, t.createdAt)]);
