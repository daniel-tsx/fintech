ALTER TABLE "mock_psp_profiles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "mock_psp_profiles" CASCADE;--> statement-breakpoint
DROP INDEX "provider_tx_id_unique";--> statement-breakpoint
ALTER TABLE "provider_transactions" ALTER COLUMN "provider" SET DEFAULT 'STRIPE';--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD COLUMN "payment_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD COLUMN "payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD COLUMN "charge_id" text;--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_tx_object_idx" ON "provider_transactions" USING btree ("provider","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "provider_tx_attempt_idx" ON "provider_transactions" USING btree ("payment_attempt_id");--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP COLUMN "scenario";