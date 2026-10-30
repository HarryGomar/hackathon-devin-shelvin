CREATE TABLE "build_attempts" (
	"build_id" text NOT NULL,
	"n" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"verdict" text,
	"passed" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"failed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_back" boolean DEFAULT false NOT NULL,
	"notes" text,
	"gate" jsonb,
	CONSTRAINT "build_attempts_pkey" PRIMARY KEY("build_id","n")
);
--> statement-breakpoint
CREATE TABLE "build_events" (
	"build_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"stage" text,
	"message" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "build_events_pkey" PRIMARY KEY("build_id","seq")
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"url" text NOT NULL,
	"kind" text DEFAULT 'third_party' NOT NULL,
	"provider" text NOT NULL,
	"product_id" text,
	"page_id" text,
	"state" text NOT NULL,
	"stage" text,
	"note" text,
	"source" text,
	"session_url" text,
	"pr_url" text,
	"branch" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 0 NOT NULL,
	"access" jsonb,
	"cost" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_attempts" ADD CONSTRAINT "build_attempts_build_id_fkey" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_events" ADD CONSTRAINT "build_events_build_id_fkey" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "builds_started_idx" ON "builds" USING btree ("started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "builds_domain_idx" ON "builds" USING btree ("domain","started_at" DESC NULLS FIRST);