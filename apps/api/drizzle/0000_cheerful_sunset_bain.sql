CREATE TYPE "public"."capture_method" AS ENUM('MANUAL', 'AUTOMATIC');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'RETRY', 'IGNORED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_type" AS ENUM('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."ledger_status" AS ENUM('DRAFT', 'POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('CREATED', 'REQUIRES_AUTHORIZATION', 'AUTHORIZED', 'CAPTURE_PENDING', 'CAPTURED', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('PLATFORM_ADMIN', 'MERCHANT_ADMIN', 'MERCHANT_OPERATOR');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'MERCHANT_ADMIN' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"correlation_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"external_reference" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_dispute_id" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"source_account_code" text,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'IN_PROGRESS' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"resource_type" text,
	"resource_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid,
	"code" text NOT NULL,
	"account_type" "ledger_account_type" NOT NULL,
	"currency" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entry_one_side_check" CHECK (("ledger_entries"."debit" > 0 and "ledger_entries"."credit" = 0) or ("ledger_entries"."credit" > 0 and "ledger_entries"."debit" = 0))
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid,
	"business_type" text NOT NULL,
	"business_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"description" text NOT NULL,
	"status" "ledger_status" DEFAULT 'DRAFT' NOT NULL,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"fee_bps" integer DEFAULT 300 NOT NULL,
	"fixed_fee_minor" bigint DEFAULT 0 NOT NULL,
	"settlement_delay_days" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_fee_bps_check" CHECK ("merchants"."fee_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "mock_psp_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid,
	"scenario" text NOT NULL,
	"remaining_failures" integer DEFAULT 0 NOT NULL,
	"webhook_delay_ms" integer DEFAULT 0 NOT NULL,
	"duplicate_webhooks" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "operation_status" DEFAULT 'PENDING' NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"provider_transaction_id" text,
	"failure_code" text,
	"scenario" text DEFAULT 'SUCCESS' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_id" uuid,
	"status" "payment_status" DEFAULT 'CREATED' NOT NULL,
	"capture_method" "capture_method" DEFAULT 'MANUAL' NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"authorized_amount" bigint DEFAULT 0 NOT NULL,
	"captured_amount" bigint DEFAULT 0 NOT NULL,
	"refunded_amount" bigint DEFAULT 0 NOT NULL,
	"platform_fee_amount" bigint DEFAULT 0 NOT NULL,
	"payment_method_token" text NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"authorized_at" timestamp with time zone,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_amounts_range_check" CHECK ("payments"."authorized_amount" >= 0 and "payments"."authorized_amount" <= "payments"."amount" and "payments"."captured_amount" >= 0 and "payments"."captured_amount" <= "payments"."amount" and "payments"."refunded_amount" >= 0 and "payments"."refunded_amount" <= "payments"."captured_amount")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"status" "operation_status" DEFAULT 'PENDING' NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"destination_token" text NOT NULL,
	"provider_reference" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payout_amount_check" CHECK ("payouts"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"payment_id" uuid,
	"refund_id" uuid,
	"provider" text DEFAULT 'MOCK_PSP' NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"raw_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"merchant_id" uuid,
	"payment_id" uuid,
	"provider_transaction_id" text,
	"issue_type" text NOT NULL,
	"severity" text NOT NULL,
	"internal_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolution_note" text,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "operation_status" DEFAULT 'PENDING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"status" "operation_status" DEFAULT 'PENDING' NOT NULL,
	"amount" bigint NOT NULL,
	"platform_fee_amount" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"reason" text,
	"provider_transaction_id" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_amount_check" CHECK ("refunds"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "settlement_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"capture_attempt_id" uuid NOT NULL,
	"gross_amount" bigint NOT NULL,
	"fee_amount" bigint NOT NULL,
	"net_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"status" "operation_status" DEFAULT 'PENDING' NOT NULL,
	"gross_amount" bigint DEFAULT 0 NOT NULL,
	"fee_amount" bigint DEFAULT 0 NOT NULL,
	"net_amount" bigint DEFAULT 0 NOT NULL,
	"available_on" timestamp with time zone NOT NULL,
	"provider_reference" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"signature" text NOT NULL,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "inbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_psp_profiles" ADD CONSTRAINT "mock_psp_profiles_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_capture_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("capture_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_logs" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_merchant_external_unique" ON "customers" USING btree ("merchant_id","external_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_provider_unique" ON "disputes" USING btree ("provider_dispute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_unique" ON "idempotency_keys" USING btree ("merchant_id","operation","key");--> statement-breakpoint
CREATE INDEX "ledger_accounts_lookup_idx" ON "ledger_accounts" USING btree ("merchant_id","currency","code");--> statement-breakpoint
CREATE INDEX "ledger_entries_tx_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_business_unique" ON "ledger_transactions" USING btree ("business_type","business_id","currency");--> statement-breakpoint
CREATE INDEX "ledger_tx_merchant_idx" ON "ledger_transactions" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mock_profile_merchant_unique" ON "mock_psp_profiles" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "attempts_payment_idx" ON "payment_attempts" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_merchant_created_idx" ON "payments" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payouts_merchant_idx" ON "payouts" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_tx_id_unique" ON "provider_transactions" USING btree ("provider","provider_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_tx_idempotency_unique" ON "provider_transactions" USING btree ("provider","provider_idempotency_key");--> statement-breakpoint
CREATE INDEX "provider_tx_payment_idx" ON "provider_transactions" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "reconciliation_open_idx" ON "reconciliation_issues" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_capture_unique" ON "settlement_items" USING btree ("capture_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_provider_event_unique" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_pending_idx" ON "webhook_events" USING btree ("status","available_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_scope_unique" ON "ledger_accounts" (coalesce("merchant_id", '00000000-0000-0000-0000-000000000000'::uuid), "code", "currency");
--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_refund_fk" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced() RETURNS trigger AS $$
DECLARE
  target_id uuid;
  tx_status ledger_status;
  tx_currency text;
  debit_total numeric;
  credit_total numeric;
  entry_count integer;
  currency_count integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END;
  ELSE
    target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  END IF;

  SELECT status, currency INTO tx_status, tx_currency FROM ledger_transactions WHERE id = target_id;
  IF tx_status = 'POSTED' THEN
    SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*), count(distinct currency)
      INTO debit_total, credit_total, entry_count, currency_count
      FROM ledger_entries WHERE transaction_id = target_id;
    IF entry_count < 2 OR debit_total <= 0 OR debit_total <> credit_total OR currency_count <> 1
      OR EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = target_id AND currency <> tx_currency) THEN
      RAISE EXCEPTION 'Ledger transaction % is not balanced in one currency (debit %, credit %, entries %)', target_id, debit_total, credit_total, entry_count;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "ledger_entries_balance_check" AFTER INSERT OR UPDATE OR DELETE ON "ledger_entries" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "ledger_transactions_balance_check" AFTER INSERT OR UPDATE ON "ledger_transactions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_immutable_financial_rows() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    RAISE EXCEPTION 'Ledger entries are immutable; post a compensating journal';
  END IF;
  IF TG_TABLE_NAME = 'ledger_transactions' AND OLD.status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'Posted ledger transactions are immutable; post a compensating journal';
  END IF;
  IF TG_TABLE_NAME = 'audit_logs' THEN
    RAISE EXCEPTION 'Audit logs are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_immutable" BEFORE UPDATE OR DELETE ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION protect_immutable_financial_rows();
--> statement-breakpoint
CREATE TRIGGER "ledger_transactions_immutable" BEFORE UPDATE OR DELETE ON "ledger_transactions" FOR EACH ROW EXECUTE FUNCTION protect_immutable_financial_rows();
--> statement-breakpoint
CREATE TRIGGER "audit_logs_immutable" BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION protect_immutable_financial_rows();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_webhook_evidence() RETURNS trigger AS $$
BEGIN
  IF NEW.provider <> OLD.provider OR NEW.provider_event_id <> OLD.provider_event_id OR NEW.event_type <> OLD.event_type OR NEW.signature <> OLD.signature OR NEW.payload <> OLD.payload THEN
    RAISE EXCEPTION 'Webhook evidence fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "webhook_evidence_immutable" BEFORE UPDATE ON "webhook_events" FOR EACH ROW EXECUTE FUNCTION protect_webhook_evidence();
