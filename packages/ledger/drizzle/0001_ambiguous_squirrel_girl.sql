-- owner_id backfill.
--
-- ADD COLUMN ... NOT NULL fails outright on a table that already has rows, so
-- each column arrives with a temporary default that backfills existing local
-- data to the fixed development owner, and the default is then dropped. Future
-- inserts must therefore supply an owner explicitly rather than silently
-- landing in the dev tenant.
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_name_unique";--> statement-breakpoint
DROP INDEX "postings_transaction_idx";--> statement-breakpoint
DROP INDEX "postings_account_idx";--> statement-breakpoint
DROP INDEX "trace_events_run_idx";--> statement-breakpoint
DROP INDEX "trace_runs_started_idx";--> statement-breakpoint
DROP INDEX "transactions_date_idx";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "postings" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "postings" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "trace_events" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_events" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "trace_runs" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_runs" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "postings_owner_transaction_idx" ON "postings" USING btree ("owner_id","transaction_id");--> statement-breakpoint
CREATE INDEX "postings_owner_account_idx" ON "postings" USING btree ("owner_id","account_id");--> statement-breakpoint
CREATE INDEX "trace_events_owner_run_idx" ON "trace_events" USING btree ("owner_id","run_id","seq");--> statement-breakpoint
CREATE INDEX "trace_runs_owner_started_idx" ON "trace_runs" USING btree ("owner_id","started_at");--> statement-breakpoint
CREATE INDEX "transactions_owner_date_idx" ON "transactions" USING btree ("owner_id","date");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_name_key" UNIQUE("owner_id","name");