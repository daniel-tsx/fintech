import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
export const inboxStatus = pgEnum('inbox_status', ['PENDING', 'PROCESSING', 'PROCESSED', 'RETRY', 'IGNORED', 'DEAD', 'ACCOUNTING_EXCEPTION']);
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
  uniqueIndex('payments_accounting_scope').on(t.id, t.merchantId, t.currency),
]);

export const paymentAttempts = pgTable('payment_attempts', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  paymentId: uuid('payment_id').notNull().references(() => payments.id), kind: text('kind').notNull(),
  status: operationStatus('status').notNull().default('PENDING'), amount: money('amount').notNull(), currency: text('currency').notNull(),
  providerTransactionId: text('provider_transaction_id'), failureCode: text('failure_code'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('attempts_payment_idx').on(t.paymentId, t.createdAt), uniqueIndex('attempts_accounting_scope').on(t.id,t.paymentId,t.merchantId,t.currency)]);

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
}, (t) => [check('refund_amount_check', sql`${t.amount} > 0`), index('refunds_payment_idx').on(t.paymentId, t.createdAt), uniqueIndex('refunds_accounting_scope').on(t.id,t.paymentId,t.merchantId,t.currency)]);

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
}, (t) => [uniqueIndex('ledger_business_unique').on(t.businessType, t.businessId, t.currency), index('ledger_tx_merchant_idx').on(t.merchantId, t.createdAt), uniqueIndex('journals_accounting_scope').on(t.id,t.merchantId,t.currency)]);

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
  // B1 additive foundation fields remain null for the current runtime.
  accountingPolicyVersion: text('accounting_policy_version'),
  estimatedAssetTransfer: bigint('estimated_asset_transfer', { mode:'bigint' }), estimatedMerchantRelease: bigint('estimated_merchant_release', { mode:'bigint' }),
  finalizedAssetTransfer: bigint('finalized_asset_transfer', { mode:'bigint' }), finalizedMerchantRelease: bigint('finalized_merchant_release', { mode:'bigint' }),
  finalizationResult: text('finalization_result'), accountingJournalId: uuid('accounting_journal_id').references(() => ledgerTransactions.id),
  accountingFinalizedAt: timestamp('accounting_finalized_at', { withTimezone:true }),
}, (t) => [uniqueIndex('settlements_accounting_scope').on(t.id,t.merchantId,t.currency)]);

export const settlementItems = pgTable('settlement_items', {
  id: uuid('id').primaryKey().defaultRandom(), settlementId: uuid('settlement_id').notNull().references(() => settlements.id),
  paymentId: uuid('payment_id').notNull().references(() => payments.id), captureAttemptId: uuid('capture_attempt_id').notNull().references(() => paymentAttempts.id),
  grossAmount: money('gross_amount').notNull(), feeAmount: money('fee_amount').notNull(), netAmount: money('net_amount').notNull(), currency: text('currency').notNull(), createdAt: createdAt(),
  // SQL owns the circular lot/item finalization relationship and scope checks.
  captureLotId: uuid('capture_lot_id'), accountingPolicyVersion: text('accounting_policy_version'),
  estimatedAssetTransfer: bigint('estimated_asset_transfer', { mode:'bigint' }), estimatedMerchantRelease: bigint('estimated_merchant_release', { mode:'bigint' }),
  selectedRevision: bigint('selected_revision', { mode:'bigint' }),
  finalizedAssetTransfer: bigint('finalized_asset_transfer', { mode:'bigint' }), finalizedMerchantRelease: bigint('finalized_merchant_release', { mode:'bigint' }),
  restrictedHold: bigint('restricted_hold', { mode:'bigint' }), appliedRevision: bigint('applied_revision', { mode:'bigint' }), finalizationResult: text('finalization_result'),
  accountingJournalId: uuid('accounting_journal_id').references(() => ledgerTransactions.id), accountingFinalizedAt: timestamp('accounting_finalized_at', { withTimezone:true }),
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
}, (t) => [uniqueIndex('disputes_provider_unique').on(t.providerDisputeId),uniqueIndex('disputes_accounting_scope').on(t.id,t.paymentId,t.merchantId,t.currency)]);

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

// B1 evidence foundation only. Migration 0004 owns lifecycle, aggregate bounds,
// source-journal validation and the circular settlement relationship. No live
// financial service reads these tables until the reviewed B2 cutover.
const allocationMoney = (name: string) => bigint(name, { mode: 'bigint' });
const allocationScope = () => ({
  paymentId: uuid('payment_id').notNull(), merchantId: uuid('merchant_id').notNull(), currency: text('currency').notNull(),
});
export const captureAccountingScopes = pgTable('capture_accounting_scopes', {
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id), currency: text('currency').notNull(),
  status: text('status').notNull().default('FOUNDATION_ONLY'), createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.merchantId, t.currency] })]);

export const captureAccountingLots = pgTable('capture_accounting_lots', {
  id: uuid('id').primaryKey().defaultRandom(), ...allocationScope(),
  captureAttemptId: uuid('capture_attempt_id').notNull(), captureJournalId: uuid('capture_journal_id').notNull(),
  originalGross: allocationMoney('original_gross').notNull(), originalFee: allocationMoney('original_fee').notNull(), originalNet: allocationMoney('original_net').notNull(),
  financialCapturedAt: timestamp('financial_captured_at', { withTimezone: true }).notNull(), eligibleAt: timestamp('eligible_at', { withTimezone: true }),
  origin: text('origin').notNull().default('NEW_CAPTURE'), policyVersion: text('policy_version').notNull().default('CAPTURE_FIFO_V1'),
  allocationRevision: allocationMoney('allocation_revision').notNull().default(0n), settlementState: text('settlement_state').notNull().default('UNSETTLED'),
  finalizedSettlementItemId: uuid('finalized_settlement_item_id').references(() => settlementItems.id), createdAt: createdAt(),
}, (t) => [
  uniqueIndex('capture_accounting_lots_capture_attempt_id_key').on(t.captureAttemptId),
  uniqueIndex('capture_accounting_lots_capture_journal_id_key').on(t.captureJournalId),
  uniqueIndex('capture_accounting_lots_finalized_settlement_item_id_key').on(t.finalizedSettlementItemId),
  uniqueIndex('capture_lot_scope').on(t.id, t.paymentId, t.merchantId, t.currency),
  uniqueIndex('capture_lot_item_scope').on(t.id, t.captureAttemptId, t.paymentId, t.currency),
  index('capture_lots_payment_fifo').on(t.paymentId, t.financialCapturedAt, t.captureAttemptId),
  foreignKey({ columns: [t.merchantId,t.currency], foreignColumns: [captureAccountingScopes.merchantId,captureAccountingScopes.currency] }),
  foreignKey({ columns: [t.paymentId,t.merchantId,t.currency], foreignColumns: [payments.id,payments.merchantId,payments.currency] }),
  foreignKey({ columns: [t.captureAttemptId,t.paymentId,t.merchantId,t.currency], foreignColumns: [paymentAttempts.id,paymentAttempts.paymentId,paymentAttempts.merchantId,paymentAttempts.currency] }),
  foreignKey({ columns: [t.captureJournalId,t.merchantId,t.currency], foreignColumns: [ledgerTransactions.id,ledgerTransactions.merchantId,ledgerTransactions.currency] }),
]);

export const refundCaptureAllocations = pgTable('refund_capture_allocations', {
  id: uuid('id').primaryKey().defaultRandom(), ...allocationScope(), refundId: uuid('refund_id').notNull(), captureLotId: uuid('capture_lot_id').notNull(),
  reservedGross: allocationMoney('reserved_gross').notNull(), status: text('status').notNull().default('RESERVED'),
  confirmedGross: allocationMoney('confirmed_gross'), confirmedFee: allocationMoney('confirmed_fee'), journalId: uuid('journal_id'),
  providerEventId: uuid('provider_event_id').references(() => webhookEvents.id), releaseReason: text('release_reason'),
  policyVersion: text('policy_version').notNull().default('CAPTURE_FIFO_V1'), createdAt: createdAt(),
}, (t) => [
  uniqueIndex('refund_capture_allocations_refund_id_capture_lot_id_key').on(t.refundId,t.captureLotId), index('refund_allocations_lot').on(t.captureLotId),
  foreignKey({ columns: [t.refundId,t.paymentId,t.merchantId,t.currency], foreignColumns: [refunds.id,refunds.paymentId,refunds.merchantId,refunds.currency] }),
  foreignKey({ columns: [t.captureLotId,t.paymentId,t.merchantId,t.currency], foreignColumns: [captureAccountingLots.id,captureAccountingLots.paymentId,captureAccountingLots.merchantId,captureAccountingLots.currency] }),
  foreignKey({ columns: [t.journalId,t.merchantId,t.currency], foreignColumns: [ledgerTransactions.id,ledgerTransactions.merchantId,ledgerTransactions.currency] }),
]);

export const disputeCaptureAllocations = pgTable('dispute_capture_allocations', {
  id: uuid('id').primaryKey().defaultRandom(), ...allocationScope(), disputeId: uuid('dispute_id').notNull(), captureLotId: uuid('capture_lot_id').notNull(),
  grossPrincipal: allocationMoney('gross_principal').notNull(), fundedHold: allocationMoney('funded_hold').notNull(), unfundedExposure: allocationMoney('unfunded_exposure').notNull(),
  status: text('status').notNull().default('PLANNED'), outcome: text('outcome'), openJournalId: uuid('open_journal_id'), closeJournalId: uuid('close_journal_id'),
  policyVersion: text('policy_version').notNull().default('CAPTURE_FIFO_V1'), createdAt: createdAt(),
}, (t) => [
  uniqueIndex('dispute_capture_allocations_dispute_id_capture_lot_id_key').on(t.disputeId,t.captureLotId),
  uniqueIndex('dispute_allocation_effect_scope').on(t.id,t.captureLotId,t.paymentId,t.merchantId,t.currency), index('dispute_allocations_lot').on(t.captureLotId),
  foreignKey({ columns: [t.disputeId,t.paymentId,t.merchantId,t.currency], foreignColumns: [disputes.id,disputes.paymentId,disputes.merchantId,disputes.currency] }),
  foreignKey({ columns: [t.captureLotId,t.paymentId,t.merchantId,t.currency], foreignColumns: [captureAccountingLots.id,captureAccountingLots.paymentId,captureAccountingLots.merchantId,captureAccountingLots.currency] }),
  foreignKey({ columns: [t.openJournalId,t.merchantId,t.currency], foreignColumns: [ledgerTransactions.id,ledgerTransactions.merchantId,ledgerTransactions.currency] }),
  foreignKey({ columns: [t.closeJournalId,t.merchantId,t.currency], foreignColumns: [ledgerTransactions.id,ledgerTransactions.merchantId,ledgerTransactions.currency] }),
]);

export const disputeHoldEffects = pgTable('dispute_hold_effects', {
  id: uuid('id').primaryKey().defaultRandom(), ...allocationScope(), allocationId: uuid('allocation_id').notNull(), captureLotId: uuid('capture_lot_id').notNull(),
  effectKey: text('effect_key').notNull(), holdDelta: allocationMoney('hold_delta').notNull(), journalId: uuid('journal_id').notNull(),
  providerEventId: uuid('provider_event_id').notNull().references(() => webhookEvents.id), causeRefundId: uuid('cause_refund_id'), causeDisputeId: uuid('cause_dispute_id'), createdAt: createdAt(),
}, (t) => [
  uniqueIndex('dispute_hold_effects_allocation_id_effect_key_key').on(t.allocationId,t.effectKey), uniqueIndex('dispute_hold_effects_journal_id_key').on(t.journalId),
  foreignKey({ columns: [t.allocationId,t.captureLotId,t.paymentId,t.merchantId,t.currency], foreignColumns: [disputeCaptureAllocations.id,disputeCaptureAllocations.captureLotId,disputeCaptureAllocations.paymentId,disputeCaptureAllocations.merchantId,disputeCaptureAllocations.currency] }),
  foreignKey({ columns: [t.causeRefundId,t.paymentId,t.merchantId,t.currency], foreignColumns: [refunds.id,refunds.paymentId,refunds.merchantId,refunds.currency] }),
  foreignKey({ columns: [t.causeDisputeId,t.paymentId,t.merchantId,t.currency], foreignColumns: [disputes.id,disputes.paymentId,disputes.merchantId,disputes.currency] }),
  foreignKey({ columns: [t.journalId,t.merchantId,t.currency], foreignColumns: [ledgerTransactions.id,ledgerTransactions.merchantId,ledgerTransactions.currency] }),
]);

export const accountingExceptions = pgTable('accounting_exceptions', {
  id: uuid('id').primaryKey().defaultRandom(), merchantId: uuid('merchant_id').notNull(), currency: text('currency').notNull(), paymentId: uuid('payment_id'),
  category: text('category').notNull(), sourceKind: text('source_kind').notNull(), evidenceKey: text('evidence_key').notNull(),
  providerEventId: uuid('provider_event_id').references(() => webhookEvents.id), refundId: uuid('refund_id'), disputeId: uuid('dispute_id'),
  observedConflict: jsonb('observed_conflict').notNull(), status: text('status').notNull().default('OPEN'), resolutionReference: text('resolution_reference'),
  resolvedBy: uuid('resolved_by').references(() => users.id), resolvedAt: timestamp('resolved_at', { withTimezone: true }), createdAt: createdAt(),
}, (t) => [
  uniqueIndex('accounting_exception_evidence').on(t.merchantId,t.currency,t.category,t.evidenceKey),
  uniqueIndex('accounting_exception_scope').on(t.id,t.paymentId,t.merchantId,t.currency), index('accounting_exceptions_open').on(t.merchantId,t.currency,t.status),
  foreignKey({ columns: [t.merchantId,t.currency], foreignColumns: [captureAccountingScopes.merchantId,captureAccountingScopes.currency] }),
  foreignKey({ columns: [t.paymentId,t.merchantId,t.currency], foreignColumns: [payments.id,payments.merchantId,payments.currency] }),
  foreignKey({ columns: [t.refundId,t.paymentId,t.merchantId,t.currency], foreignColumns: [refunds.id,refunds.paymentId,refunds.merchantId,refunds.currency] }),
  foreignKey({ columns: [t.disputeId,t.paymentId,t.merchantId,t.currency], foreignColumns: [disputes.id,disputes.paymentId,disputes.merchantId,disputes.currency] }),
]);

export const accountingExceptionLots = pgTable('accounting_exception_lots', {
  exceptionId: uuid('exception_id').notNull(), captureLotId: uuid('capture_lot_id').notNull(), ...allocationScope(),
}, (t) => [
  primaryKey({ columns: [t.exceptionId,t.captureLotId] }),
  foreignKey({ columns: [t.exceptionId,t.paymentId,t.merchantId,t.currency], foreignColumns: [accountingExceptions.id,accountingExceptions.paymentId,accountingExceptions.merchantId,accountingExceptions.currency] }),
  foreignKey({ columns: [t.captureLotId,t.paymentId,t.merchantId,t.currency], foreignColumns: [captureAccountingLots.id,captureAccountingLots.paymentId,captureAccountingLots.merchantId,captureAccountingLots.currency] }),
]);
