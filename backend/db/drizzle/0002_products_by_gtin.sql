-- One product per barcode (server/products.py). The data step (fill gtin and name_key, fold duplicates into their
-- canonical id, keep old ids as aliases) runs in Python right after this file: Database.dedupe in server/db.py.
CREATE TABLE "product_aliases" (
	"old_id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gtin" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "name_key" text;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_aliases_product_idx" ON "product_aliases" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_gtin_key" ON "products" USING btree ("gtin");--> statement-breakpoint
CREATE INDEX "products_name_key_idx" ON "products" USING btree ("name_key");