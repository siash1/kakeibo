CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_conversation_seq_key" UNIQUE("conversation_id","seq")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suspended_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"history" jsonb NOT NULL,
	"completed_results" jsonb NOT NULL,
	"pending" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"cost_usd_est" numeric(10, 6) DEFAULT '0' NOT NULL,
	"iterations" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspended_turns" ADD CONSTRAINT "suspended_turns_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspended_turns" ADD CONSTRAINT "suspended_turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_messages_owner_conversation_idx" ON "conversation_messages" USING btree ("owner_id","conversation_id","seq");--> statement-breakpoint
CREATE INDEX "conversations_owner_updated_idx" ON "conversations" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "suspended_turns_owner_conversation_idx" ON "suspended_turns" USING btree ("owner_id","conversation_id");--> statement-breakpoint

-- Row-level security for the three new tables, mirroring 0002_rls.sql. Hand
-- written into a generated migration: policies are not schema drizzle-kit
-- tracks, so regenerating this file would drop them.
--
-- Grants are already in place via the ALTER DEFAULT PRIVILEGES in 0002, which
-- covers every table created after it. These three want them; the auth tables
-- in 0003 explicitly do not, and revoke.

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "conversations_owner" ON "conversations"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "conversation_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "conversation_messages_owner" ON "conversation_messages"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

ALTER TABLE "suspended_turns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "suspended_turns_owner" ON "suspended_turns"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
