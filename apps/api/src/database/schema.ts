import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
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
  type AnyPgColumn,
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
  evidenceRevision: allocationMoney('evidence_revision').notNull().default(0n),
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
  evidenceContractVersion: integer('evidence_contract_version').notNull().default(0), proofRevision: integer('proof_revision'),
  policyVersion: text('policy_version').notNull().default('CAPTURE_FIFO_V1'), createdAt: createdAt(),
}, (t) => [
  uniqueIndex('refund_capture_allocations_refund_id_capture_lot_id_key').on(t.refundId,t.captureLotId), index('refund_allocations_lot').on(t.captureLotId),
  check('refund_evidence_floor_closed',sql`${t.evidenceContractVersion}=0 and ${t.proofRevision} is null`),
  index('refund_proof_reference').on(t.providerEventId,t.proofRevision),
  foreignKey({ columns: [t.providerEventId,t.proofRevision,t.paymentId,t.merchantId,t.currency], foreignColumns: [webhookFinancialEvidence.inboxId,webhookFinancialEvidence.proofRevision,webhookFinancialEvidence.paymentId,webhookFinancialEvidence.merchantId,webhookFinancialEvidence.currency] }),
  foreignKey({ columns: [t.refundId,t.paymentId,t.merchantId,t.currency], foreignColumns: [refunds.id,refunds.paymentId,refunds.merchantId,refunds.currency] }),
  foreignKey({ columns: [t.captureLotId,t.paymentId,t.merchantId,t.currency], foreignColumns: [captureAccountingLots.id,captureAccountingLots.paymentId,captureAccountingLots.merchantId,captureAccountingLots.currency] }),
  foreignKey({ columns: [t.journalId,t.merchantId,t.currency], foreignColumns: [ledgerTransactions.id,ledgerTransactions.merchantId,ledgerTransactions.currency] }),
]);

export const disputeCaptureAllocations = pgTable('dispute_capture_allocations', {
  id: uuid('id').primaryKey().defaultRandom(), ...allocationScope(), disputeId: uuid('dispute_id').notNull(), captureLotId: uuid('capture_lot_id').notNull(),
  grossPrincipal: allocationMoney('gross_principal').notNull(), fundedHold: allocationMoney('funded_hold').notNull(), unfundedExposure: allocationMoney('unfunded_exposure').notNull(),
  status: text('status').notNull().default('PLANNED'), outcome: text('outcome'), openJournalId: uuid('open_journal_id'), closeJournalId: uuid('close_journal_id'),
  evidenceContractVersion: integer('evidence_contract_version').notNull().default(0),
  openInboxId: uuid('open_inbox_id'), openProofRevision: integer('open_proof_revision'), closeInboxId: uuid('close_inbox_id'), closeProofRevision: integer('close_proof_revision'),
  policyVersion: text('policy_version').notNull().default('CAPTURE_FIFO_V1'), createdAt: createdAt(),
}, (t) => [
  uniqueIndex('dispute_capture_allocations_dispute_id_capture_lot_id_key').on(t.disputeId,t.captureLotId),
  check('dispute_evidence_floor_closed',sql`${t.evidenceContractVersion}=0 and ${t.openInboxId} is null and ${t.openProofRevision} is null and ${t.closeInboxId} is null and ${t.closeProofRevision} is null`),
  index('dispute_open_proof_reference').on(t.openInboxId,t.openProofRevision),index('dispute_close_proof_reference').on(t.closeInboxId,t.closeProofRevision),
  foreignKey({ columns: [t.openInboxId,t.openProofRevision,t.paymentId,t.merchantId,t.currency], foreignColumns: [webhookFinancialEvidence.inboxId,webhookFinancialEvidence.proofRevision,webhookFinancialEvidence.paymentId,webhookFinancialEvidence.merchantId,webhookFinancialEvidence.currency] }),
  foreignKey({ columns: [t.closeInboxId,t.closeProofRevision,t.paymentId,t.merchantId,t.currency], foreignColumns: [webhookFinancialEvidence.inboxId,webhookFinancialEvidence.proofRevision,webhookFinancialEvidence.paymentId,webhookFinancialEvidence.merchantId,webhookFinancialEvidence.currency] }),
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
  evidenceContractVersion: integer('evidence_contract_version').notNull().default(0), proofRevision: integer('proof_revision'),
}, (t) => [
  uniqueIndex('dispute_hold_effects_allocation_id_effect_key_key').on(t.allocationId,t.effectKey), uniqueIndex('dispute_hold_effects_journal_id_key').on(t.journalId),
  check('hold_evidence_floor_closed',sql`${t.evidenceContractVersion}=0 and ${t.proofRevision} is null`), index('hold_proof_reference').on(t.providerEventId,t.proofRevision),
  foreignKey({ columns: [t.providerEventId,t.proofRevision,t.paymentId,t.merchantId,t.currency], foreignColumns: [webhookFinancialEvidence.inboxId,webhookFinancialEvidence.proofRevision,webhookFinancialEvidence.paymentId,webhookFinancialEvidence.merchantId,webhookFinancialEvidence.currency] }),
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

// B3.2 B.1: immutable evidence, never runtime financial admission.
// Migration 0006 owns checked routines, immutable triggers and restricted grants.
export const financialEvidenceAccounts = pgTable('financial_evidence_accounts', {
  provider: text('provider').notNull(), providerAccount: text('provider_account').notNull(),
  providerMode: text('provider_mode'),
  runtimeEnforcement: text('runtime_enforcement').notNull().default('UNINSTALLED'), createdAt: createdAt(),
}, (t) => [primaryKey({columns:[t.provider,t.providerAccount]}),check('financial_evidence_uninstalled',sql`${t.runtimeEnforcement}='UNINSTALLED'`),
  check('financial_evidence_provider',sql`${t.provider}='STRIPE' and length(${t.providerAccount})>0`)]);

const bytea = customType<{data:Buffer;driverData:Buffer}>({dataType:()=>'bytea'});
export const providerFinancialReceipts = pgTable('provider_financial_receipts', {
  inboxId: uuid('inbox_id').primaryKey().references(()=>webhookEvents.id), provider:text('provider').notNull(), providerAccount:text('provider_account').notNull(),
  rawBody:bytea('raw_body').notNull(),signature:text('signature').notNull(),headers:jsonb('headers').notNull(),normalizedPayload:jsonb('normalized_payload').notNull(),
  normalizationVersion:integer('normalization_version').notNull(),verificationMethod:text('verification_method').notNull(),verificationVersion:text('verification_version').notNull(),
  receivedAt:timestamp('received_at',{withTimezone:true}).notNull(),verifiedAt:timestamp('verified_at',{withTimezone:true}).notNull(),
},(t)=>[index('financial_receipts_account').on(t.provider,t.providerAccount),
  check('financial_receipt_shape',sql`octet_length(${t.rawBody})>0 and length(${t.signature})>0 and jsonb_typeof(${t.headers})='object' and jsonb_typeof(${t.normalizedPayload})='object'`),
  check('financial_receipt_contract',sql`${t.normalizationVersion}=1 and ${t.verificationMethod}='STRIPE_SDK' and length(${t.verificationVersion})>0`),
  foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[financialEvidenceAccounts.provider,financialEvidenceAccounts.providerAccount]})]);

export const providerFinancialObservations = pgTable('provider_financial_observations', {
  id:uuid('id').primaryKey().defaultRandom(),provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),
  sourceKind:text('source_kind').notNull(),sourceKey:text('source_key').notNull(),objectKind:text('object_kind').notNull(),providerObjectId:text('provider_object_id').notNull(),
  paymentId:uuid('payment_id'),merchantId:uuid('merchant_id'),currency:text('currency'),amount:allocationMoney('amount'),
  outboxId:uuid('outbox_id').references(()=>outboxEvents.id),commandKey:text('command_key'),commandPayload:jsonb('command_payload'),
  refundId:uuid('refund_id').references(()=>refunds.id),captureAttemptId:uuid('capture_attempt_id').references(()=>paymentAttempts.id),
  paymentIntentId:text('payment_intent_id'),chargeId:text('charge_id'),providerStatus:text('provider_status').notNull(),snapshot:jsonb('snapshot').notNull(),
  observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),publisherVersion:text('publisher_version').notNull(),createdAt:createdAt(),
},(t)=>[uniqueIndex('financial_observation_source').on(t.provider,t.providerAccount,t.sourceKind,t.sourceKey),
  check('financial_observation_shape',sql`${t.sourceKind} in ('COMMAND_RESULT','PROVIDER_LOOKUP') and ${t.objectKind} in ('REFUND','CAPTURE','DISPUTE') and length(${t.sourceKey})>0 and length(${t.providerObjectId})>0 and jsonb_typeof(${t.snapshot})='object'`),
  check('financial_observation_command',sql`${t.sourceKind}<>'COMMAND_RESULT' or (${t.paymentId} is not null and ${t.merchantId} is not null and ${t.currency} is not null and ${t.amount} is not null and ${t.outboxId} is not null and ${t.commandKey} is not null and ${t.commandPayload} is not null and ((${t.objectKind}='REFUND' and ${t.refundId} is not null and ${t.captureAttemptId} is null) or (${t.objectKind}='CAPTURE' and ${t.captureAttemptId} is not null and ${t.refundId} is null)))`),
  index('financial_observations_object').on(t.provider,t.providerAccount,t.objectKind,t.providerObjectId),index('financial_observations_outbox').on(t.outboxId),
  index('financial_observations_refund').on(t.refundId),index('financial_observations_capture').on(t.captureAttemptId),index('financial_observations_payment').on(t.paymentId,t.merchantId,t.currency),
  foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[financialEvidenceAccounts.provider,financialEvidenceAccounts.providerAccount]}),
  foreignKey({columns:[t.paymentId,t.merchantId,t.currency],foreignColumns:[payments.id,payments.merchantId,payments.currency]})]);

export const providerFinancialObjectOwners = pgTable('provider_financial_object_owners', {
  id:uuid('id').primaryKey().defaultRandom(),provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),
  objectKind:text('object_kind').notNull(),providerObjectId:text('provider_object_id').notNull(),...allocationScope(),amount:allocationMoney('amount').notNull(),
  refundId:uuid('refund_id'),providerDisputeId:text('provider_dispute_id'),createdAt:createdAt(),
},(t)=>[uniqueIndex('financial_object_owner_identity').on(t.provider,t.providerAccount,t.objectKind,t.providerObjectId),
  check('financial_object_owner_shape',sql`((${t.objectKind}='REFUND' and starts_with(${t.providerObjectId},'re_') and ${t.refundId} is not null and ${t.providerDisputeId} is null) or (${t.objectKind}='DISPUTE' and starts_with(${t.providerObjectId},'dp_') and ${t.providerDisputeId}=${t.providerObjectId} and ${t.refundId} is null)) is true`),
  uniqueIndex('financial_object_owner_scope').on(t.id,t.paymentId,t.merchantId,t.currency),index('financial_object_owner_payment').on(t.paymentId,t.merchantId,t.currency),index('financial_object_owner_refund').on(t.refundId),
  foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[financialEvidenceAccounts.provider,financialEvidenceAccounts.providerAccount]}),
  foreignKey({columns:[t.paymentId,t.merchantId,t.currency],foreignColumns:[payments.id,payments.merchantId,payments.currency]}),
  foreignKey({columns:[t.refundId,t.paymentId,t.merchantId,t.currency],foreignColumns:[refunds.id,refunds.paymentId,refunds.merchantId,refunds.currency]})]);

export const webhookFinancialEvidence = pgTable('webhook_financial_evidence', {
  inboxId:uuid('inbox_id').primaryKey().references(()=>providerFinancialReceipts.inboxId),proofRevision:integer('proof_revision').notNull(),contractVersion:integer('contract_version').notNull(),
  ownerBindingId:uuid('owner_binding_id').notNull(),provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),providerEventId:text('provider_event_id').notNull(),
  externalType:text('external_type').notNull(),operation:text('operation').notNull(),providerObjectId:text('provider_object_id').notNull(),...allocationScope(),amount:allocationMoney('amount').notNull(),
  refundId:uuid('refund_id'),providerDisputeId:text('provider_dispute_id'),disputeId:uuid('dispute_id').references(()=>disputes.id),paymentIntentId:text('payment_intent_id').notNull(),
  chargeId:text('charge_id'),outcome:text('outcome'),refundObservationId:uuid('refund_observation_id').references(()=>providerFinancialObservations.id),captureSources:jsonb('capture_sources').notNull(),
  attemptRevision:integer('attempt_revision').notNull(),sealedAt:timestamp('sealed_at',{withTimezone:true}).notNull().defaultNow(),validatorVersion:text('validator_version').notNull(),
},(t)=>[uniqueIndex('financial_proof_owned_tuple').on(t.inboxId,t.proofRevision,t.paymentId,t.merchantId,t.currency),
  check('financial_proof_contract',sql`${t.proofRevision}=1 and ${t.contractVersion}=1 and ${t.validatorVersion}='B3_2_EVIDENCE_V1' and ${t.attemptRevision}>=0`),
  check('financial_proof_shape',sql`${t.operation} in ('refund.succeeded','refund.failed','dispute.opened','dispute.closed') and ${t.amount}>0 and ${t.amount}<=9007199254740991 and starts_with(${t.paymentIntentId},'pi_') and jsonb_typeof(${t.captureSources})='array' and jsonb_array_length(${t.captureSources})>0`),
  index('financial_evidence_binding').on(t.ownerBindingId),index('financial_evidence_refund').on(t.refundId),index('financial_evidence_dispute').on(t.disputeId),index('financial_evidence_observation').on(t.refundObservationId),
  foreignKey({columns:[t.ownerBindingId,t.paymentId,t.merchantId,t.currency],foreignColumns:[providerFinancialObjectOwners.id,providerFinancialObjectOwners.paymentId,providerFinancialObjectOwners.merchantId,providerFinancialObjectOwners.currency]}),
  foreignKey({columns:[t.refundId,t.paymentId,t.merchantId,t.currency],foreignColumns:[refunds.id,refunds.paymentId,refunds.merchantId,refunds.currency]})]);

export const financialEvidenceReviews = pgTable('financial_evidence_reviews', {
  id:uuid('id').primaryKey().defaultRandom(),inboxId:uuid('inbox_id').notNull().references(()=>webhookEvents.id),reviewKey:text('review_key').notNull(),
  reason:text('reason').notNull(),observations:jsonb('observations').notNull(),createdAt:createdAt(),
},(t)=>[uniqueIndex('financial_evidence_review_identity').on(t.inboxId,t.reviewKey),
  check('financial_evidence_review_shape',sql`length(${t.reviewKey})>0 and ${t.reason} in ('UNRESOLVED','CONTRADICTORY','UNSUPPORTED') and jsonb_typeof(${t.observations})='object'`)]);

// R0 storage declarations. Migration 0007 additionally owns guarded transitions,
// revisions, deferred obligation checks, capabilities and immutable evidence.
export const receiptIntakeAuthority = pgTable('receipt_intake_authority', {
  provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),evidenceRevision:allocationMoney('evidence_revision').notNull().default(0n),
},t=>[primaryKey({columns:[t.provider,t.providerAccount]}),check('receipt_intake_revision',sql`${t.evidenceRevision}>=0`),
  foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[financialEvidenceAccounts.provider,financialEvidenceAccounts.providerAccount]})]);
export const receiptAdmissions = pgTable('receipt_admissions', {
  inboxId:uuid('inbox_id').primaryKey().references(()=>providerFinancialReceipts.inboxId),provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),
  contractVersion:integer('contract_version').notNull(),operation:text('operation').notNull(),financiallyRelevant:boolean('financially_relevant').notNull(),createdAt:createdAt(),
},t=>[uniqueIndex('receipt_admission_tuple').on(t.inboxId,t.provider,t.providerAccount,t.operation),check('receipt_admission_contract',sql`${t.contractVersion} in (1,2)`),
  foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[receiptIntakeAuthority.provider,receiptIntakeAuthority.providerAccount]})]);
export const receiptAdmissionObligations = pgTable('receipt_admission_obligations', {
  inboxId:uuid('inbox_id').primaryKey(),provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),operation:text('operation').notNull(),
  merchantId:uuid('merchant_id'),currency:text('currency'),paymentId:uuid('payment_id'),proofRevision:integer('proof_revision'),disposition:text('disposition').notNull(),
  paymentOperationProofId:uuid('payment_operation_proof_id'),
  obligationRevision:allocationMoney('obligation_revision').notNull().default(0n),scopeEvidenceRevision:allocationMoney('scope_evidence_revision'),
  intakeEvidenceRevision:allocationMoney('intake_evidence_revision').notNull(),reviewId:uuid('review_id').references(()=>financialEvidenceReviews.id),resolutionId:uuid('resolution_id'),
  createdAt:createdAt(),resolvedAt:timestamp('resolved_at',{withTimezone:true}),
},t=>[check('receipt_obligation_revisions',sql`${t.obligationRevision}>=0 and ${t.intakeEvidenceRevision}>=0`),
  check('receipt_obligation_disposition',sql`${t.disposition} in ('AWAITING_CONFIRMATION','AWAITING_CORRELATION','AWAITING_APPLICATION','BLOCKING_REVIEW','CLEARED_APPLICATION','CLEARED_NO_EFFECT')`),
  check('receipt_obligation_owner',sql`((${t.merchantId} is null and ${t.currency} is null and ${t.paymentId} is null and ${t.proofRevision} is null and ${t.paymentOperationProofId} is null and ${t.scopeEvidenceRevision} is null) or (${t.merchantId} is not null and ${t.currency} is not null and ${t.paymentId} is not null and ${t.scopeEvidenceRevision}>=1 and ((${t.proofRevision}=1 and ${t.paymentOperationProofId} is null) or (${t.proofRevision} is null and ${t.paymentOperationProofId} is not null)))) is true`),
  check('receipt_obligation_scope_state',sql`(${t.disposition} in ('AWAITING_CONFIRMATION','AWAITING_CORRELATION') and ${t.merchantId} is null) or ${t.disposition}='BLOCKING_REVIEW' or (${t.disposition} in ('AWAITING_APPLICATION','CLEARED_APPLICATION','CLEARED_NO_EFFECT') and ${t.merchantId} is not null)`),
  check('receipt_pending_confirmation',sql`(${t.operation}='refund.pending' and ${t.disposition} in ('AWAITING_CONFIRMATION','BLOCKING_REVIEW')) or (${t.operation}<>'refund.pending' and ${t.disposition}<>'AWAITING_CONFIRMATION')`),
  check('receipt_obligation_resolution',sql`(${t.disposition} in ('CLEARED_APPLICATION','CLEARED_NO_EFFECT') and ${t.resolvedAt} is not null and ${t.resolutionId} is not null) or (${t.disposition} not in ('CLEARED_APPLICATION','CLEARED_NO_EFFECT') and ${t.resolvedAt} is null and ${t.resolutionId} is null)`),
  check('receipt_obligation_review',sql`(${t.disposition}='BLOCKING_REVIEW')=(${t.reviewId} is not null)`),
  index('receipt_unknown_blockers').on(t.provider,t.providerAccount).where(sql`${t.merchantId} is null and ${t.disposition} in ('AWAITING_CORRELATION','BLOCKING_REVIEW')`),
  index('receipt_scope_blockers').on(t.merchantId,t.currency).where(sql`${t.disposition} in ('AWAITING_APPLICATION','BLOCKING_REVIEW')`),
  foreignKey({columns:[t.inboxId,t.provider,t.providerAccount,t.operation],foreignColumns:[receiptAdmissions.inboxId,receiptAdmissions.provider,receiptAdmissions.providerAccount,receiptAdmissions.operation]}),
  foreignKey({columns:[t.merchantId,t.currency],foreignColumns:[captureAccountingScopes.merchantId,captureAccountingScopes.currency]}),
  foreignKey({columns:[t.inboxId,t.proofRevision,t.paymentId,t.merchantId,t.currency],foreignColumns:[webhookFinancialEvidence.inboxId,webhookFinancialEvidence.proofRevision,webhookFinancialEvidence.paymentId,webhookFinancialEvidence.merchantId,webhookFinancialEvidence.currency]}),
  foreignKey({columns:[t.inboxId,t.paymentOperationProofId,t.paymentId,t.merchantId,t.currency],foreignColumns:[paymentOperationEvidence.inboxId,paymentOperationEvidence.id,paymentOperationEvidence.paymentId,paymentOperationEvidence.merchantId,paymentOperationEvidence.currency]}),
  foreignKey({columns:[t.resolutionId,t.inboxId],foreignColumns:[receiptObligationResolutions.id,receiptObligationResolutions.inboxId]})]);
export const receiptObligationResolutions = pgTable('receipt_obligation_resolutions', {
  id:uuid('id').primaryKey().defaultRandom(),inboxId:uuid('inbox_id').notNull().references(():AnyPgColumn=>receiptAdmissionObligations.inboxId),kind:text('kind').notNull(),
  proofRevision:integer('proof_revision').notNull(),paymentId:uuid('payment_id').notNull(),merchantId:uuid('merchant_id').notNull(),currency:text('currency').notNull(),operation:text('operation').notNull(),
  journalId:uuid('journal_id').references(()=>ledgerTransactions.id),auditId:uuid('audit_id').notNull().references(()=>auditLogs.id),financialReference:jsonb('financial_reference').notNull(),
  databasePrincipal:customType<{data:string}>({dataType:()=>'name'})('database_principal').notNull().default(sql`session_user`),createdAt:createdAt(),
},t=>[uniqueIndex('receipt_resolution_inbox').on(t.inboxId),uniqueIndex('receipt_resolution_tuple').on(t.id,t.inboxId),
  check('receipt_resolution_kind',sql`${t.kind} in ('APPLICATION','NO_EFFECT')`),check('receipt_resolution_reference',sql`jsonb_typeof(${t.financialReference})='object'`),
  foreignKey({columns:[t.inboxId,t.proofRevision,t.paymentId,t.merchantId,t.currency],foreignColumns:[webhookFinancialEvidence.inboxId,webhookFinancialEvidence.proofRevision,webhookFinancialEvidence.paymentId,webhookFinancialEvidence.merchantId,webhookFinancialEvidence.currency]})]);

// R0.2 later witnesses are independent of the immutable original enrollment.
// SQL owns source validation, the exact deferred barrier set and closed recovery.
export const receiptDeliveryAttempts = pgTable('receipt_delivery_attempts', {
  id:uuid('id').primaryKey().defaultRandom(),originalInboxId:uuid('original_inbox_id').notNull().references(()=>receiptAdmissions.inboxId),
  provider:text('provider').notNull(),providerEventId:text('provider_event_id').notNull(),originalAccount:text('original_account').notNull(),providerAccount:text('provider_account').notNull(),
  deliveryKey:bytea('delivery_key').notNull(),rawBody:bytea('raw_body').notNull(),signature:text('signature').notNull(),headers:jsonb('headers').notNull(),normalizedPayload:jsonb('normalized_payload').notNull(),
  normalizationVersion:integer('normalization_version').notNull(),verificationMethod:text('verification_method').notNull(),verificationVersion:text('verification_version').notNull(),
  originalProofRevision:integer('original_proof_revision'),classification:text('classification').notNull(),reason:text('reason').notNull(),operation:text('operation').notNull(),financiallyRelevant:boolean('financially_relevant').notNull(),
  reviewId:uuid('review_id').references(()=>financialEvidenceReviews.id),receivedAt:timestamp('received_at',{withTimezone:true}).notNull().defaultNow(),
  databasePrincipal:customType<{data:string}>({dataType:()=>'name'})('database_principal').notNull().default(sql`session_user`),
},t=>[uniqueIndex('receipt_delivery_identity').on(t.originalInboxId,t.deliveryKey),
  foreignKey({columns:[t.provider,t.originalAccount],foreignColumns:[financialEvidenceAccounts.provider,financialEvidenceAccounts.providerAccount]}),
  foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[financialEvidenceAccounts.provider,financialEvidenceAccounts.providerAccount]})]);
export const receiptDeliveryBarriers = pgTable('receipt_delivery_barriers', {
  deliveryId:uuid('delivery_id').notNull().references(()=>receiptDeliveryAttempts.id),barrierKey:text('barrier_key').notNull(),provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),
  merchantId:uuid('merchant_id'),currency:text('currency'),disposition:text('disposition').notNull().default('BLOCKING_REVIEW'),reviewId:uuid('review_id').notNull().references(()=>financialEvidenceReviews.id),
  scopeEvidenceRevision:allocationMoney('scope_evidence_revision'),intakeEvidenceRevision:allocationMoney('intake_evidence_revision').notNull(),createdAt:createdAt(),
},t=>[primaryKey({columns:[t.deliveryId,t.barrierKey]}),check('delivery_barrier_closed',sql`${t.disposition}='BLOCKING_REVIEW'`),
  foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[receiptIntakeAuthority.provider,receiptIntakeAuthority.providerAccount]}),
  foreignKey({columns:[t.merchantId,t.currency],foreignColumns:[captureAccountingScopes.merchantId,captureAccountingScopes.currency]}),
  index('receipt_delivery_account_barriers').on(t.provider,t.providerAccount).where(sql`${t.merchantId} is null`),
  index('receipt_delivery_scope_barriers').on(t.merchantId,t.currency).where(sql`${t.merchantId} is not null`)]);

// D02-A is prospective and dormant. SQL0009 additionally owns publication,
// identity guards, immutable triggers, exact deferred projections and privileges.
export const providerCommandAuthorities = pgTable('provider_command_authorities', {
  outboxId:uuid('outbox_id').primaryKey().references(()=>outboxEvents.id),provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),
  providerMode:text('provider_mode').notNull(),operation:text('operation').notNull(),operationId:uuid('operation_id').notNull(),...allocationScope(),
  amount:allocationMoney('amount').notNull(),commandKey:text('command_key').notNull(),commandPayload:jsonb('command_payload').notNull(),
  accountingPolicy:text('accounting_policy').notNull(),acceptanceEpoch:allocationMoney('acceptance_epoch').notNull(),acceptedAt:timestamp('accepted_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('provider_authority_key').on(t.provider,t.providerAccount,t.commandKey),uniqueIndex('provider_authority_operation_unique').on(t.operation,t.operationId),index('provider_authority_operation').on(t.operationId),index('provider_authority_payment').on(t.paymentId),
  foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[financialEvidenceAccounts.provider,financialEvidenceAccounts.providerAccount]}),
  foreignKey({columns:[t.paymentId,t.merchantId,t.currency],foreignColumns:[payments.id,payments.merchantId,payments.currency]})]);
export const providerCommandExecutions = pgTable('provider_command_executions', {
  id:uuid('id').primaryKey(),outboxId:uuid('outbox_id').notNull().references(()=>providerCommandAuthorities.outboxId),
  preparedAt:timestamp('prepared_at',{withTimezone:true}).notNull().defaultNow(),databasePrincipal:customType<{data:string}>({dataType:()=>'name'})('database_principal').notNull().default(sql`session_user`),
},t=>[uniqueIndex('provider_execution_tuple').on(t.id,t.outboxId),index('provider_execution_command').on(t.outboxId,t.preparedAt)]);
export const providerObservationSources = pgTable('provider_observation_sources', {
  id:uuid('id').primaryKey().defaultRandom(),sourceOrder:bigint('source_order',{mode:'bigint'}).generatedAlwaysAsIdentity().unique(),
  outboxId:uuid('outbox_id').notNull().references(()=>providerCommandAuthorities.outboxId),sourceKind:text('source_kind').notNull(),sourceKey:text('source_key').notNull(),
  executionId:uuid('execution_id'),priorSourceId:uuid('prior_source_id'),lookupObjectId:text('lookup_object_id'),reconciliationRunId:uuid('reconciliation_run_id').references(()=>reconciliationRuns.id),lookupActor:text('lookup_actor'),
  observationKind:text('observation_kind').notNull(),requestMethod:text('request_method').notNull(),requestPath:text('request_path').notNull(),requestHost:text('request_host').notNull(),requestProtocol:text('request_protocol').notNull(),
  requestHeaders:jsonb('request_headers').notNull(),requestBody:bytea('request_body').notNull(),requestParameters:jsonb('request_parameters').notNull(),responseBody:bytea('response_body'),bodyCompleteness:text('body_completeness').notNull(),
  httpStatus:integer('http_status'),responseHeaders:jsonb('response_headers').notNull(),transportError:text('transport_error'),sdkVersion:text('sdk_version').notNull(),normalizationVersion:text('normalization_version').notNull(),normalizedOutcome:jsonb('normalized_outcome').notNull(),
  observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),fingerprint:bytea('fingerprint').notNull(),createdAt:createdAt(),databasePrincipal:customType<{data:string}>({dataType:()=>'name'})('database_principal').notNull().default(sql`session_user`),
},t=>[uniqueIndex('provider_source_fingerprint').on(t.sourceKind,t.sourceKey,t.fingerprint),uniqueIndex('provider_source_tuple').on(t.id,t.outboxId),
  index('provider_source_command').on(t.outboxId,t.sourceOrder),index('provider_source_prior').on(t.priorSourceId),
  foreignKey({columns:[t.executionId,t.outboxId],foreignColumns:[providerCommandExecutions.id,providerCommandExecutions.outboxId]}),
  foreignKey({columns:[t.priorSourceId,t.outboxId],foreignColumns:[t.id,t.outboxId]})]);
export const providerObservationObligations = pgTable('provider_observation_obligations', {
  sourceId:uuid('source_id').primaryKey().references(()=>providerObservationSources.id),provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),merchantId:uuid('merchant_id'),currency:text('currency'),
  disposition:text('disposition').notNull(),reason:text('reason').notNull(),scopeEvidenceRevision:allocationMoney('scope_evidence_revision'),intakeEvidenceRevision:allocationMoney('intake_evidence_revision').notNull(),
},t=>[foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[receiptIntakeAuthority.provider,receiptIntakeAuthority.providerAccount]}),
  foreignKey({columns:[t.merchantId,t.currency],foreignColumns:[captureAccountingScopes.merchantId,captureAccountingScopes.currency]}),
  index('provider_unknown_obligations').on(t.provider,t.providerAccount).where(sql`${t.merchantId} is null and ${t.disposition}='BLOCKING_REVIEW'`),
  index('provider_scoped_obligations').on(t.merchantId,t.currency).where(sql`${t.disposition} in ('AWAITING_APPLICATION','BLOCKING_REVIEW')`)]);
export const providerObservationProjections = pgTable('provider_observation_projections', {
  sourceId:uuid('source_id').primaryKey().references(()=>providerObservationSources.id),observationId:uuid('observation_id').notNull().unique().references(()=>providerFinancialObservations.id),
});

// R2-A is dormant. Forward SQL owns the typed alternatives, protected registry,
// immutable manifests, transaction authority, grants and deferred finality.
const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' });
const regprocedure = customType<{ data: string }>({ dataType: () => 'regprocedure' });
export const financialApplicationContracts = pgTable('financial_application_contracts', {
  family: text('family').notNull(), phase: text('phase').notNull(), policy: text('policy').notNull(), version: integer('version').notNull(),
  prepareFunction: regprocedure('prepare_function').notNull(), validateFunction: regprocedure('validate_function').notNull(),
}, t => [primaryKey({ columns: [t.family,t.phase,t.policy] })]);
export const financialApplicationScopeAuthority = pgTable('financial_application_scope_authority', {
  merchantId: uuid('merchant_id').notNull(), currency: text('currency').notNull(), provider: text('provider').notNull(), providerAccount: text('provider_account').notNull(),
  policy: text('policy').notNull(), epoch: allocationMoney('epoch').notNull(), admissionMode: text('admission_mode').notNull(),
}, t => [primaryKey({ columns: [t.merchantId,t.currency] }),
  foreignKey({ columns: [t.merchantId,t.currency], foreignColumns: [captureAccountingScopes.merchantId,captureAccountingScopes.currency] }),
  foreignKey({ columns: [t.provider,t.providerAccount], foreignColumns: [financialEvidenceAccounts.provider,financialEvidenceAccounts.providerAccount] })]);
export const financialApplicationRoots = pgTable('financial_application_roots', {
  id: uuid('id').primaryKey().defaultRandom(), family: text('family').notNull(), operationId: uuid('operation_id').notNull(), phase: text('phase').notNull(),
  merchantId: uuid('merchant_id').notNull(), currency: text('currency').notNull(), provider: text('provider').notNull(), providerAccount: text('provider_account').notNull(),
  policy: text('policy').notNull(), acceptanceEpoch: allocationMoney('acceptance_epoch').notNull(),
  acceptedOutboxId: uuid('accepted_outbox_id').references(() => providerCommandAuthorities.outboxId),
  paymentId: uuid('payment_id'), attemptId: uuid('attempt_id'), refundId: uuid('refund_id'), disputeId: uuid('dispute_id'), settlementId: uuid('settlement_id'), payoutId: uuid('payout_id'),
  createdAt: createdAt(),
}, t => [uniqueIndex('application_canonical_identity').on(t.family,t.operationId,t.phase,t.currency),
  uniqueIndex('application_root_scope').on(t.id,t.merchantId,t.currency),
  foreignKey({ columns: [t.paymentId,t.merchantId,t.currency], foreignColumns: [payments.id,payments.merchantId,payments.currency] }),
  foreignKey({ columns: [t.attemptId,t.paymentId,t.merchantId,t.currency], foreignColumns: [paymentAttempts.id,paymentAttempts.paymentId,paymentAttempts.merchantId,paymentAttempts.currency] }),
  foreignKey({ columns: [t.refundId,t.paymentId,t.merchantId,t.currency], foreignColumns: [refunds.id,refunds.paymentId,refunds.merchantId,refunds.currency] }),
  foreignKey({ columns: [t.disputeId,t.paymentId,t.merchantId,t.currency], foreignColumns: [disputes.id,disputes.paymentId,disputes.merchantId,disputes.currency] })]);
export const financialApplicationManifests = pgTable('financial_application_manifests', {
  id: uuid('id').primaryKey().defaultRandom(), rootId: uuid('root_id').notNull().references(() => financialApplicationRoots.id),
  transactionId: xid8('transaction_id').notNull(), backendPid: integer('backend_pid').notNull(),
  inboxId: uuid('inbox_id').notNull(), proofRevision: integer('proof_revision').notNull(), proofOperation: text('proof_operation').notNull(), claimGeneration: integer('claim_generation').notNull(),
  merchantId: uuid('merchant_id').notNull(), currency: text('currency').notNull(), paymentId: uuid('payment_id').notNull(),
  policy: text('policy').notNull(), epoch: allocationMoney('epoch').notNull(), scopeRevision: allocationMoney('scope_revision').notNull(), intakeRevision: allocationMoney('intake_revision').notNull(),
  contractVersion: integer('contract_version').notNull(), result: text('result').notNull(), sourceManifest: jsonb('source_manifest').notNull(), effectManifest: jsonb('effect_manifest').notNull(), createdAt: createdAt(),
}, t => [uniqueIndex('application_manifest_transaction').on(t.transactionId,t.backendPid), uniqueIndex('application_manifest_root').on(t.id,t.rootId),
  foreignKey({ columns: [t.rootId,t.merchantId,t.currency], foreignColumns: [financialApplicationRoots.id,financialApplicationRoots.merchantId,financialApplicationRoots.currency] }),
  foreignKey({ columns: [t.inboxId,t.proofRevision,t.paymentId,t.merchantId,t.currency], foreignColumns: [webhookFinancialEvidence.inboxId,webhookFinancialEvidence.proofRevision,webhookFinancialEvidence.paymentId,webhookFinancialEvidence.merchantId,webhookFinancialEvidence.currency] })]);
export const financialApplicationPermits = pgTable('financial_application_permits', {
  transactionId: xid8('transaction_id').notNull(), backendPid: integer('backend_pid').notNull(), manifestId: uuid('manifest_id').notNull().unique().references(() => financialApplicationManifests.id),
  databasePrincipal: customType<{ data: string }>({ dataType: () => 'name' })('database_principal').notNull().default(sql`session_user`),
}, t => [primaryKey({ columns: [t.transactionId,t.backendPid] })]);
export const financialApplications = pgTable('financial_applications', {
  rootId: uuid('root_id').primaryKey().references(() => financialApplicationRoots.id), manifestId: uuid('manifest_id').notNull().unique(),
  result: text('result').notNull(), auditId: uuid('audit_id').notNull().unique().references(() => auditLogs.id), createdAt: createdAt(),
}, t => [foreignKey({ columns: [t.manifestId,t.rootId], foreignColumns: [financialApplicationManifests.id,financialApplicationManifests.rootId] })]);
export const financialApplicationDispositions = pgTable('financial_application_dispositions', {
  id: uuid('id').primaryKey().defaultRandom(), rootId: uuid('root_id').notNull().references(() => financialApplications.rootId),
  inboxId: uuid('inbox_id').references(() => receiptAdmissionObligations.inboxId), obligationRevision: allocationMoney('obligation_revision'),
  observationSourceId: uuid('observation_source_id').references(() => providerObservationObligations.sourceId), deliveryId: uuid('delivery_id'), barrierKey: text('barrier_key'),
  disposition: text('disposition').notNull(), createdAt: createdAt(),
}, t => [uniqueIndex('application_receipt_disposition').on(t.inboxId,t.obligationRevision), uniqueIndex('application_observation_disposition').on(t.observationSourceId),
  uniqueIndex('application_delivery_disposition').on(t.deliveryId,t.barrierKey),
  foreignKey({ columns: [t.deliveryId,t.barrierKey], foreignColumns: [receiptDeliveryBarriers.deliveryId,receiptDeliveryBarriers.barrierKey] })]);
export const financialApplicationRevisionEffects = pgTable('financial_application_revision_effects', {
  manifestId: uuid('manifest_id').primaryKey().references(() => financialApplicationManifests.id), rootId: uuid('root_id').notNull().references(() => financialApplications.rootId),
  priorRevision: allocationMoney('prior_revision').notNull(), finalRevision: allocationMoney('final_revision').notNull(),
});
export const financialApplicationEffectLinks = pgTable('financial_application_effect_links', {
  manifestId: uuid('manifest_id').notNull(), rootId: uuid('root_id').notNull(), relationName: text('relation_name').notNull(), effectId: uuid('effect_id').notNull(),
  merchantId: uuid('merchant_id').notNull(), currency: text('currency').notNull(), paymentId: uuid('payment_id').notNull(),
  journalId: uuid('journal_id').unique().references(() => ledgerTransactions.id), lotId: uuid('lot_id').references(() => captureAccountingLots.id),
  refundAllocationId: uuid('refund_allocation_id').references(() => refundCaptureAllocations.id), disputeAllocationId: uuid('dispute_allocation_id').references(() => disputeCaptureAllocations.id),
  holdEffectId: uuid('hold_effect_id').references(() => disputeHoldEffects.id), settlementItemId: uuid('settlement_item_id').references(() => settlementItems.id),
}, t => [primaryKey({ columns: [t.manifestId,t.relationName,t.effectId] }),
  foreignKey({ columns: [t.manifestId,t.rootId], foreignColumns: [financialApplicationManifests.id,financialApplicationManifests.rootId] }),
  foreignKey({ columns: [t.rootId,t.merchantId,t.currency], foreignColumns: [financialApplicationRoots.id,financialApplicationRoots.merchantId,financialApplicationRoots.currency] })]);

// B1 storage only. SQL0011 owns checked source interpretation and closed finality.
export const paymentOperationEvidence = pgTable('payment_operation_evidence', {
  id:uuid('id').primaryKey().defaultRandom(),inboxId:uuid('inbox_id').notNull().references(()=>receiptAdmissions.inboxId),proofVersion:integer('proof_version').notNull(),
  operation:text('operation').notNull(),outcome:text('outcome').notNull(),provider:text('provider').notNull(),providerAccount:text('provider_account').notNull(),providerMode:text('provider_mode').notNull(),
  attemptId:uuid('attempt_id').notNull(),...allocationScope(),outboxId:uuid('outbox_id').notNull().references(()=>providerCommandAuthorities.outboxId),
  sourceId:uuid('source_id').notNull(),executionId:uuid('execution_id').notNull(),authorizationSourceId:uuid('authorization_source_id').references(()=>providerObservationSources.id),
  paymentIntentId:text('payment_intent_id').notNull(),chargeId:text('charge_id').notNull(),capturePrincipal:allocationMoney('capture_principal'),authorizedPrincipal:allocationMoney('authorized_principal'),
  accountingPolicy:text('accounting_policy').notNull(),acceptanceEpoch:allocationMoney('acceptance_epoch').notNull(),receiptRevision:allocationMoney('receipt_revision').notNull(),
  attemptGeneration:integer('attempt_generation').notNull(),scopeRevision:allocationMoney('scope_revision').notNull(),intakeRevision:allocationMoney('intake_revision').notNull(),
  facts:jsonb('facts').notNull(),fingerprint:bytea('fingerprint').notNull(),validatorVersion:text('validator_version').notNull(),sealedAt:timestamp('sealed_at',{withTimezone:true}).notNull().defaultNow(),
  databasePrincipal:customType<{data:string}>({dataType:()=>'name'})('database_principal').notNull().default(sql`session_user`),
},t=>[uniqueIndex('payment_operation_receipt_version').on(t.inboxId,t.proofVersion),uniqueIndex('payment_operation_owned_proof').on(t.inboxId,t.id,t.paymentId,t.merchantId,t.currency),
  index('payment_operation_attempt').on(t.attemptId),index('payment_operation_provider_object').on(t.provider,t.providerAccount,t.paymentIntentId),
  foreignKey({columns:[t.attemptId,t.paymentId,t.merchantId,t.currency],foreignColumns:[paymentAttempts.id,paymentAttempts.paymentId,paymentAttempts.merchantId,paymentAttempts.currency]}),
  foreignKey({columns:[t.sourceId,t.outboxId],foreignColumns:[providerObservationSources.id,providerObservationSources.outboxId]}),
  foreignKey({columns:[t.executionId,t.outboxId],foreignColumns:[providerCommandExecutions.id,providerCommandExecutions.outboxId]}),
  foreignKey({columns:[t.provider,t.providerAccount],foreignColumns:[financialEvidenceAccounts.provider,financialEvidenceAccounts.providerAccount]}),
  check('payment_operation_version',sql`${t.proofVersion}=1 and ${t.validatorVersion}='PAYMENT_OPERATION_V1' and ${t.accountingPolicy}='LEGACY' and ${t.acceptanceEpoch}=0`)]);
