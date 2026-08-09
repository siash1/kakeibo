-- Operator switches (spec §9.4).
--
-- A table rather than an environment variable because an env change is a
-- redeploy, and the point of a kill switch is that it works during an
-- incident, from a phone, in seconds. Not owner-scoped and deliberately
-- without a row-level security policy: it is a property of the site, not of a
-- visitor.

CREATE TABLE "operator_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
