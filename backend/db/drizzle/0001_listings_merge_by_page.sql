-- Merge by pageId (spec 9): keep only the newest listing per (product_id, page_id) before the unique index.
-- Hand-added to drizzle-kit's output: a data step, so the schema snapshot is unchanged.
DELETE FROM "listings" l USING (
  SELECT id, row_number() OVER (PARTITION BY product_id, page_id ORDER BY scraped_at DESC, id DESC) AS n FROM "listings"
) ranked WHERE l.id = ranked.id AND ranked.n > 1;--> statement-breakpoint
DROP INDEX "listings_product_page_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "listings_product_page_key" ON "listings" USING btree ("product_id","page_id");
