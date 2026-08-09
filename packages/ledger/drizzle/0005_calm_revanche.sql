-- The per-address message counter (spec §5, layer 2).
--
-- Deliberately NOT owner-scoped, and therefore deliberately without a
-- row-level security policy: its whole job is to survive a visitor clearing
-- their cookies and minting a fresh anonymous user, which is precisely a change
-- of owner. A policy keyed on owner_id would defeat the layer it belongs to.
--
-- The key is sha256(ip + RATE_LIMIT_SALT + date), so no raw address is stored
-- and yesterday's keys cannot be correlated with today's.

CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
