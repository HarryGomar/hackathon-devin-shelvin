CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"product_id" text NOT NULL,
	"scrape_run_id" text,
	"url" text,
	"title" text,
	"price_amount" numeric(12, 2),
	"price_currency" text,
	"availability" text,
	"image_url" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"retailer_domain" text NOT NULL,
	"search_id" text,
	"url" text NOT NULL,
	"title" text,
	"match_type" text DEFAULT 'exact' NOT NULL,
	"verification_status" text,
	"verification_confidence" double precision,
	"verification_reason" text,
	"access_status" text,
	"access_code" text,
	"access_reason" text,
	"scraper_status" text DEFAULT 'missing' NOT NULL,
	"scraper_id" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"variant" text,
	"size" text,
	"barcode" text,
	"manufacturer" text,
	"category" text,
	"image_url" text,
	"image_source" text,
	"source" text,
	"confidence" double precision,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retailers" (
	"domain" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'third_party' NOT NULL,
	CONSTRAINT "retailers_kind_check" CHECK ("retailers"."kind" IN ('first_party', 'third_party'))
);
--> statement-breakpoint
CREATE TABLE "scrape_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "scrape_runs_status_check" CHECK ("scrape_runs"."status" IN ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "searches" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_scrape_run_id_fkey" FOREIGN KEY ("scrape_run_id") REFERENCES "public"."scrape_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_retailer_domain_fkey" FOREIGN KEY ("retailer_domain") REFERENCES "public"."retailers"("domain") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_search_id_fkey" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_runs" ADD CONSTRAINT "scrape_runs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_product_page_idx" ON "listings" USING btree ("product_id","page_id","scraped_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "listings_run_idx" ON "listings" USING btree ("scrape_run_id");--> statement-breakpoint
CREATE INDEX "pages_product_idx" ON "pages" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pages_url_idx" ON "pages" USING btree ("url");--> statement-breakpoint
CREATE INDEX "pages_retailer_idx" ON "pages" USING btree ("retailer_domain");--> statement-breakpoint
CREATE INDEX "products_barcode_idx" ON "products" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "products_updated_idx" ON "products" USING btree ("updated_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "scrape_runs_product_idx" ON "scrape_runs" USING btree ("product_id","started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "searches_product_idx" ON "searches" USING btree ("product_id","created_at" DESC NULLS FIRST);