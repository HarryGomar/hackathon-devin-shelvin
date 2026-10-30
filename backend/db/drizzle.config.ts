// drizzle-kit reads this for `npm run generate`, `npm run check` and `npm run studio`.
// Migrations are applied by the Python server (server/db.py), not by `drizzle-kit migrate`: one tracker only
// (the `schema_migrations` table), so don't run `drizzle-kit migrate` or `drizzle-kit push` against these databases.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  out: "./drizzle",
  // Only studio connects; generate and check work from schema.ts and drizzle/meta alone.
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://localhost/scanner" },
});
