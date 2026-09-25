import { sql } from "drizzle-orm";
import { check, customType, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { driveItems } from "@/lib/drive-schema";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const SEARCH_DOC_STATUSES = ["queued", "indexing", "indexed", "skipped", "failed"] as const;
export const SEARCH_SKIP_REASONS = ["too_large", "unsupported", "excluded", "protected", "empty", "trashed"] as const;
export type SearchDocStatus = (typeof SEARCH_DOC_STATUSES)[number];
export type SearchSkipReason = (typeof SEARCH_SKIP_REASONS)[number];

/** One row per file that search knows about; `content_hash` is the etag the chunks were extracted from. */
export const driveSearchDocs = pgTable("drive_search_docs", {
  itemId: uuid("item_id").primaryKey().references(() => driveItems.id, { onDelete: "cascade" }),
  contentHash: text("content_hash"),
  status: text("status", { enum: SEARCH_DOC_STATUSES }).notNull(),
  skipReason: text("skip_reason", { enum: SEARCH_SKIP_REASONS }),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  indexedAt: timestamp("indexed_at", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
}, (table) => [
  index("drive_search_docs_status_idx").on(table.status, table.queuedAt),
  check("drive_search_docs_status_valid", sql`${table.status} in ('queued', 'indexing', 'indexed', 'skipped', 'failed')`),
  check("drive_search_docs_skip_reason_valid", sql`${table.skipReason} is null or ${table.skipReason} in ('too_large', 'unsupported', 'excluded', 'protected', 'empty', 'trashed')`),
]);

export type DriveSearchDocRow = typeof driveSearchDocs.$inferSelect;

/** Passages of a file's current contents. `id` doubles as the Vectorize vector id. */
export const driveSearchChunks = pgTable("drive_search_chunks", {
  id: uuid("id").primaryKey(),
  itemId: uuid("item_id").notNull().references(() => driveItems.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  /** "page 3", "Sheet1", "slide 4", "caption"; null for plain text. */
  location: text("location"),
  text: text("text").notNull(),
  // 'simple' does not stem: contents mix Dutch and English, and English stemming would mangle Dutch words.
  tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', text)`),
}, (table) => [
  unique("drive_search_chunks_item_ordinal").on(table.itemId, table.ordinal),
  index("drive_search_chunks_tsv_idx").using("gin", table.tsv),
]);

export type DriveSearchChunkRow = typeof driveSearchChunks.$inferSelect;

/**
 * Vector ids whose chunk rows are gone but may still exist in Vectorize. Queries always join back to
 * Postgres, so a leftover vector can never surface; this journal only keeps the index tidy.
 */
export const driveSearchOrphans = pgTable("drive_search_orphans", {
  vectorId: uuid("vector_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
