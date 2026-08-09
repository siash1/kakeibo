-- Row-level security: the backstop under the repository layer's explicit
-- scoping. A forgotten `where owner_id = ...` returns zero rows instead of
-- another tenant's ledger.
--
-- The application connects as app_user, which does NOT own these tables and is
-- therefore subject to the policies. Migrations, seeding and the eval harness
-- connect as the table owner, which bypasses RLS by default - that is what lets
-- `pnpm db:seed` write rows for any owner.
--
-- The role itself is created by scripts/db-up.sh: roles are cluster-level and
-- its password must not live in git.

GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

--> statement-breakpoint

ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "accounts_owner" ON "accounts"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "transactions_owner" ON "transactions"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "postings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "postings_owner" ON "postings"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rules_owner" ON "rules"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "budgets_owner" ON "budgets"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "memories_owner" ON "memories"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_batches_owner" ON "import_batches"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "trace_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trace_runs_owner" ON "trace_runs"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "trace_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trace_events_owner" ON "trace_events"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
