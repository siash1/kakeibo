ALTER TABLE "trace_runs" ADD COLUMN "geo_country" char(2);--> statement-breakpoint
ALTER TABLE "trace_runs" ADD COLUMN "geo_region" text;--> statement-breakpoint
ALTER TABLE "trace_runs" ADD COLUMN "geo_city" text;--> statement-breakpoint
ALTER TABLE "trace_runs" ADD COLUMN "geo_lat" double precision;--> statement-breakpoint
ALTER TABLE "trace_runs" ADD COLUMN "geo_lon" double precision;