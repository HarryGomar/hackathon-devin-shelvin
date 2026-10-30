ALTER TABLE "products" ADD COLUMN "line_key" text;--> statement-breakpoint
CREATE INDEX "products_line_key_idx" ON "products" USING btree ("line_key");--> statement-breakpoint
-- Data: clear name_key so server/db.py dedupe() saves every product again, filling line_key and folding
-- products that only differ in the brand field (Barcel vs Takis) together.
UPDATE "products" SET "name_key" = NULL;
