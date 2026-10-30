// Shelvin: products, the pages that list them, scrape runs and the listings they saved.
// Core facts are columns; anything else the app or a site sends rides along in jsonb.
//
// This file is the schema's single source of truth. `npm run generate` writes the SQL migration into drizzle/,
// and the Python server (server/db.py) applies it on its next start. The server queries with psycopg, so table
// and column names here are the ones its SQL uses.
//
// Constraint names match the ones Postgres picks by default (products_pkey, pages_product_id_fkey,
// retailers_kind_check, ...), so a database created from the old hand-written 001_init.sql and one created from
// Drizzle's migration are identical.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const jsonObject = (name: string) => jsonb(name).notNull().default({});

export const products = pgTable(
  "products",
  {
    // ProductIdentity.id: `gtin-<GTIN-14>` for a product with a valid barcode, else the app's name slug
    // (server/products.py). Writes reuse a stored product with the same GTIN or name key instead of adding a row.
    id: text("id").primaryKey(),
    brand: text("brand").notNull().default(""),
    productName: text("product_name").notNull().default(""),
    variant: text("variant"),
    size: text("size"),
    barcode: text("barcode"), // as given
    gtin: text("gtin"), // the barcode as GTIN-14 when its check digit is valid: one product per GTIN
    nameKey: text("name_key"), // brand + name + size normalized, to match scans without a barcode
    lineKey: text("line_key"), // name + size without the brand field ("Barcel" vs "Takis"): a second match key
    manufacturer: text("manufacturer"),
    category: text("category"), // ProductIdentity.categoryGuess
    imageUrl: text("image_url"),
    imageSource: text("image_source"), // openfoodfacts | user_photo | retailer
    source: text("source"), // mock | claude | openfoodfacts | user_edited
    confidence: doublePrecision("confidence"),
    extra: jsonObject("extra"), // alternatives and any other identity fields
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("products_barcode_idx").on(t.barcode),
    uniqueIndex("products_gtin_key").on(t.gtin), // NULLs (no or invalid barcode) are allowed many times
    index("products_name_key_idx").on(t.nameKey),
    index("products_line_key_idx").on(t.lineKey),
    index("products_updated_idx").on(t.updatedAt.desc().nullsFirst()),
  ],
);

// Ids that products had before a merge or a canonical rename, so old links (GET /products/:old) still answer.
export const productAliases = pgTable(
  "product_aliases",
  {
    oldId: text("old_id").primaryKey(),
    productId: text("product_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "product_aliases_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] })
      .onDelete("cascade"),
    index("product_aliases_product_idx").on(t.productId),
  ],
);

export const retailers = pgTable(
  "retailers",
  {
    domain: text("domain").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("third_party"),
  },
  (t) => [check("retailers_kind_check", sql`${t.kind} IN ('first_party', 'third_party')`)],
);

export const searches = pgTable(
  "searches",
  {
    id: text("id").primaryKey(), // searchId
    productId: text("product_id").notNull(),
    createdAt: createdAt(),
    raw: jsonb("raw").notNull(), // the SearchResult as returned
  },
  (t) => [
    foreignKey({ name: "searches_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] })
      .onDelete("cascade"),
    index("searches_product_idx").on(t.productId, t.createdAt.desc().nullsFirst()),
  ],
);

export const pages = pgTable(
  "pages",
  {
    id: text("id").primaryKey(), // SourcePage.id
    productId: text("product_id").notNull(),
    retailerDomain: text("retailer_domain").notNull(),
    searchId: text("search_id"),
    url: text("url").notNull(),
    title: text("title"),
    matchType: text("match_type").notNull().default("exact"),
    verificationStatus: text("verification_status"),
    verificationConfidence: doublePrecision("verification_confidence"),
    verificationReason: text("verification_reason"),
    accessStatus: text("access_status"),
    accessCode: text("access_code"),
    accessReason: text("access_reason"),
    scraperStatus: text("scraper_status").notNull().default("missing"),
    scraperId: text("scraper_id"),
    extra: jsonObject("extra"), // access label/alternative, similarProductId, thumbnailUrl
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ name: "pages_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] })
      .onDelete("cascade"),
    foreignKey({ name: "pages_retailer_domain_fkey", columns: [t.retailerDomain], foreignColumns: [retailers.domain] }),
    foreignKey({ name: "pages_search_id_fkey", columns: [t.searchId], foreignColumns: [searches.id] })
      .onDelete("set null"),
    index("pages_product_idx").on(t.productId),
    index("pages_url_idx").on(t.url),
    index("pages_retailer_idx").on(t.retailerDomain),
  ],
);

export const scrapeRuns = pgTable(
  "scrape_runs",
  {
    id: text("id").primaryKey(), // runId
    productId: text("product_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull().default("running"),
    failures: jsonb("failures").notNull().default([]), // the pages that failed, as the scrape result lists them
  },
  (t) => [
    foreignKey({ name: "scrape_runs_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] })
      .onDelete("cascade"),
    check("scrape_runs_status_check", sql`${t.status} IN ('running', 'succeeded', 'failed')`),
    index("scrape_runs_product_idx").on(t.productId, t.startedAt.desc().nullsFirst()),
  ],
);

export const listings = pgTable(
  "listings",
  {
    id: text("id").primaryKey(), // Listing.id
    pageId: text("page_id").notNull(),
    productId: text("product_id").notNull(),
    scrapeRunId: text("scrape_run_id"),
    url: text("url"),
    title: text("title"),
    priceAmount: numeric("price_amount", { precision: 12, scale: 2 }),
    priceCurrency: text("price_currency"),
    availability: text("availability"),
    imageUrl: text("image_url"),
    fields: jsonObject("fields"), // everything else the site sent (Listing.fields)
    extra: jsonObject("extra"), // categoryPath, standardTaxonomy
    scrapedAt: timestamp("scraped_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "listings_page_id_fkey", columns: [t.pageId], foreignColumns: [pages.id] }).onDelete("cascade"),
    foreignKey({ name: "listings_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] })
      .onDelete("cascade"),
    foreignKey({ name: "listings_scrape_run_id_fkey", columns: [t.scrapeRunId], foreignColumns: [scrapeRuns.id] })
      .onDelete("set null"),
    // Merge by pageId (spec 9): one listing per (product, page); a re-scrape replaces it (an upsert on this key).
    uniqueIndex("listings_product_page_key").on(t.productId, t.pageId),
    index("listings_run_idx").on(t.scrapeRunId),
  ],
);

// Scraper builds (server/builds.py): one row per build, one per attempt, and every event the backend or the builder
// reported, written as they happen. The app's build history and each build's trace read these (GET /builds).
export const builds = pgTable(
  "builds",
  {
    id: text("id").primaryKey(), // buildId: the build job's id
    domain: text("domain").notNull(),
    url: text("url").notNull(),
    kind: text("kind").notNull().default("third_party"),
    provider: text("provider").notNull(), // devin | claude_code | scripted
    productId: text("product_id"), // no foreign key: a pasted URL's build may have no stored product
    pageId: text("page_id"),
    state: text("state").notNull(), // AgentRun.state: queued, building, fixing, passed, exists, failed, refused, ...
    stage: text("stage"),
    note: text("note"), // the latest progress line
    source: text("source"),
    sessionUrl: text("session_url"),
    prUrl: text("pr_url"),
    branch: text("branch"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(0),
    access: jsonb("access"), // the robots.txt verdict
    cost: jsonObject("cost"), // { usd?, acus? }
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("builds_started_idx").on(t.startedAt.desc().nullsFirst()),
    index("builds_domain_idx").on(t.domain, t.startedAt.desc().nullsFirst()),
  ],
);

export const buildAttempts = pgTable(
  "build_attempts",
  {
    buildId: text("build_id").notNull(),
    n: integer("n").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome"), // what the builder reported: pr_opened, built_no_pr, kit_gap, ...
    verdict: text("verdict"), // the backend's gate: pass | fail | unreachable
    passed: integer("passed").notNull().default(0),
    total: integer("total").notNull().default(0),
    failed: jsonb("failed").notNull().default([]), // the checks that failed, with their detail
    sentBack: boolean("sent_back").notNull().default(false),
    notes: text("notes"),
    gate: jsonb("gate"), // the gate's whole report on this attempt: source, verdict, rows, checks
  },
  (t) => [
    primaryKey({ name: "build_attempts_pkey", columns: [t.buildId, t.n] }),
    foreignKey({ name: "build_attempts_build_id_fkey", columns: [t.buildId], foreignColumns: [builds.id] })
      .onDelete("cascade"),
  ],
);

export const buildEvents = pgTable(
  "build_events",
  {
    buildId: text("build_id").notNull(),
    seq: integer("seq").notNull(), // 0, 1, 2, ... in the order the build reported them
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(), // system (the backend) | agent (the builder) | agent_gate | gate (the backend's gate)
    stage: text("stage"),
    message: text("message").notNull(),
    attempt: integer("attempt").notNull().default(0),
    extra: jsonObject("extra"), // the gate summary an event carries
  },
  (t) => [
    primaryKey({ name: "build_events_pkey", columns: [t.buildId, t.seq] }),
    foreignKey({ name: "build_events_build_id_fkey", columns: [t.buildId], foreignColumns: [builds.id] })
      .onDelete("cascade"),
  ],
);
